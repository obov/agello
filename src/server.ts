// ahello server: browser <-> coding agent bridge via herdr (Bun runtime).
//
// GET  /                 index.html
// GET  /agent-bridge.js  <agent-bridge> web component
// GET  /status           session liveness (herdr agent get + pane get)
// GET  /events           SSE: status, chat messages, tool start/end (from transcript JSONL)
// POST /send             {action, text} -> herdr agent prompt
// GET  /screen           SSE: terminal-browser screen frames (CDP screencast)
// WS   /terminal         interactive herdr terminal frames, keyboard input, resize
// GET  /panes            herdr workspace -> tab -> pane tree
// POST /panes/connect    {pane} -> url of that pane's server (started if needed)
// POST /panes/create     {kind: workspace|tab|pane, cwd?, label?, workspace?, pane?, direction?}
// WS   /input            user control: CDP Input.* commands forwarded to the page
// GET  /present          presentation state
// POST /present          {rect?: {x,y,w,h}} start (or move the crop), {stop: true} end
//                        ({stop: true, from: "viewer"}: ended from the page, the agent is told
//                         with "[browser] action=present-stop")

import { createTerminal, type SocketData } from "./terminal.ts";
import { panesRoute } from "./panes.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { runJson } from "./run.ts";
import { createScreencast, type Rect } from "./screencast.ts";

export type ServerOptions = {
  port: number;
  pane: string;
  session?: string;
  allowOrigins?: string[];
  browser?: string;
};

export const BROWSER_PREFIX = "[browser]";
const WEB_DIR = join(import.meta.dir, "..", "web");

// ---------- pure helpers ----------

// Keep prompts at 3 lines or fewer so Claude Code does not treat them as a
// paste: drop blank lines, put the first body line on the header line, and
// join everything past the 3rd line with " / ".
export function formatPrompt(action: string, text: string): string {
  const head = `${BROWSER_PREFIX} action=${action}`;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return head;
  const rest = lines.slice(1);
  const tail = rest.length > 2 ? [rest[0], rest.slice(1).join(" / ")] : rest;
  return [`${head} ${lines[0]}`, ...tail].join("\n");
}

// Claude Code wraps multi-line pasted input (4+ lines) in pasted_content tags.
// Strip them for display.
const PASTE_TAG = /<\/?pasted_content id="[^"]*">\n?/g;
const unwrapPaste = (s: string) => s.replace(PASTE_TAG, "").trim();

function toolSummary(input: any): string {
  const s =
    input?.description ??
    input?.file_path ??
    input?.pattern ??
    input?.query ??
    input?.url ??
    input?.skill ??
    input?.prompt ??
    input?.command ??
    "";
  const text = String(s).replace(/\s+/g, " ").trim();
  return text.length > 80 ? text.slice(0, 80) + "…" : text;
}

// Some models emit user-facing narration as a `thinking` block whose signature
// carries a "narration" marker. Claude Code renders these like normal replies,
// so treat them as assistant text. Plain (unmarked) thinking stays hidden.
// The marker is an undocumented detail of the signature; if it changes, these
// blocks are simply not shown (same as before).
export function isNarration(b: any): boolean {
  if (b?.type !== "thinking" || typeof b.thinking !== "string" || !b.thinking.trim()) return false;
  try {
    return Buffer.from(String(b.signature ?? "").slice(0, 200), "base64").includes("narration");
  } catch {
    return false;
  }
}

// Every herdr call is killed after `timeout` ms so a hung herdr cannot pile up processes.
async function herdr(timeout: number, ...cmd: string[]): Promise<any> {
  return (await runJson(["herdr", ...cmd], timeout)) ?? { error: { code: "herdr_failed" } };
}

// Presentation rect from the API: finite, non-negative origin, positive size (CSS px).
export function parseRect(r: any): Rect | null {
  if (!r || typeof r !== "object") return null;
  const v = [r.x, r.y, r.w, r.h].map(Number);
  if (!v.every(Number.isFinite) || v[0] < 0 || v[1] < 0 || v[2] < 1 || v[3] < 1) return null;
  const [x, y, w, h] = v.map(Math.round);
  return { x, y, w, h };
}

export type Present = { on: boolean; rect?: Rect; since?: string };

type Status =
  | { alive: false; reason: string; pane: string }
  | { alive: true; status: string; pane: string; label?: string; session: string; title?: string };

// ---------- server ----------

export async function startServer(opts: ServerOptions) {
  const PANE = opts.pane;
  const ALLOW_ORIGINS = opts.allowOrigins ?? [];
  const HTML = Bun.file(join(WEB_DIR, "index.html"));
  const COMPONENT = Bun.file(join(WEB_DIR, "agent-bridge.js"));

  const terminal = createTerminal(PANE);
  const bundle = await Bun.build({ entrypoints: [join(WEB_DIR, "terminal.js")], target: "browser", minify: true });
  if (!bundle.success) throw new Error(`Terminal bundle failed: ${bundle.logs.join("\n")}`);
  const terminalJS = await bundle.outputs[0].text();
  const terminalCSS = Bun.file(new URL(import.meta.resolve("@xterm/xterm/css/xterm.css")));

  const agentInfo = async (): Promise<any | null> =>
    (await herdr(3000, "agent", "get", PANE))?.result?.agent ?? null;

  const SESSION: string | undefined = opts.session ?? (await agentInfo())?.agent_session?.value;

  async function checkStatus(): Promise<Status> {
    // label (set with `herdr pane rename`) is only on pane get, not agent get
    const [a, p] = await Promise.all([agentInfo(), herdr(3000, "pane", "get", PANE)]);
    if (!a) return { alive: false, reason: "agent_not_found", pane: PANE };
    if (a.agent !== "claude") return { alive: false, reason: "not_claude", pane: PANE };
    const current = a.agent_session?.value;
    if (SESSION && current !== SESSION) return { alive: false, reason: "session_changed", pane: PANE };
    return {
      alive: true,
      status: a.agent_status,
      pane: PANE,
      label: p?.result?.pane?.label || undefined,
      session: current,
      title: a.terminal_title_stripped,
    };
  }

  // ----- SSE clients -----

  const clients = new Set<ReadableStreamDefaultController>();
  const enc = new TextEncoder();
  const send = (ctrl: ReadableStreamDefaultController, event: string, data: unknown) => {
    try {
      ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    } catch {
      clients.delete(ctrl);
    }
  };
  const broadcast = (event: string, data: unknown) => clients.forEach((c) => send(c, event, data));

  // ----- status polling -----

  let lastStatus: Status | null = null;
  let polling = false; // skip a tick while the previous poll is still running
  async function pollStatus() {
    if (polling) return;
    polling = true;
    try {
      const s = await checkStatus();
      if (JSON.stringify(s) !== JSON.stringify(lastStatus)) {
        lastStatus = s;
        broadcast("status", s);
      }
    } finally {
      polling = false;
    }
  }
  await pollStatus();
  const timers: Timer[] = [setInterval(pollStatus, 1500)];

  // ----- transcript tail -----

  async function findTranscript(): Promise<string | null> {
    if (!SESSION) return null;
    const base = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
    for await (const p of new Bun.Glob(`*/${SESSION}.jsonl`).scan({ cwd: base, absolute: true })) return p;
    return null;
  }

  // Pending tools, so a page that connects mid-tool still shows the loader.
  const pendingTools = new Map<string, { id: string; name: string; summary: string; ts?: string }>();

  // Build a chat message from a user prompt string ([browser] prefix -> browser bubble).
  function userMessage(raw: string, ts: string, extra: object = {}) {
    const text = unwrapPaste(raw);
    if (text.startsWith(BROWSER_PREFIX)) {
      const [head, ...rest] = text.split("\n");
      const m = head.match(/action=(\S+) ?(.*)$/);
      const body = [m?.[2] ?? "", ...rest].filter(Boolean).join("\n");
      return { role: "browser", action: m?.[1] ?? "message", text: body, ts, ...extra };
    }
    return { role: "terminal", text, ts, ...extra };
  }

  // Prompts typed while the agent is busy are queued by Claude Code:
  //   queue-operation enqueue {content}          -> show as a "queued" bubble
  //   queue-operation remove  {content, reason}  -> delivered mid-turn (absorbed_mid_turn)
  //   attachment queued_command {prompt}         -> delivered mid-turn (same message)
  //   queue-operation dequeue                    -> delivered at turn end (FIFO, no content);
  //                                                 followed by a user entry (promptSource "queued")
  //   queue-operation popAll                     -> queue pulled back into the input box
  // System prompts (task notifications, "<tag>..." content) share the queue but are not shown.
  type Queued = { id: string; text: string; human: boolean };
  const queue: Queued[] = [];
  const suppress: string[] = []; // delivered queue texts whose follow-up user entry must not duplicate
  const isHumanPrompt = (t: string) => !/^\s*<[a-z][\w-]*>/i.test(t);

  function deliver(q: Queued) {
    if (q.human) broadcast("delivered", { id: q.id });
  }

  function handleQueue(d: any) {
    const op = d.operation;
    if (op === "enqueue" && typeof d.content === "string") {
      const q = { id: `q-${d.timestamp}-${queue.length}`, text: d.content, human: isHumanPrompt(d.content) };
      queue.push(q);
      if (q.human) broadcast("message", userMessage(d.content, d.timestamp, { id: q.id, queued: true }));
    } else if (op === "remove" && typeof d.content === "string") {
      const i = queue.findIndex((q) => q.text === d.content);
      if (i >= 0) deliver(queue.splice(i, 1)[0]);
    } else if (op === "dequeue") {
      const q = queue.shift();
      if (q) {
        deliver(q);
        suppress.push(q.text);
      }
    } else if (op === "popAll") {
      for (const q of queue.splice(0)) if (q.human) broadcast("unqueued", { id: q.id });
    }
  }

  function handleEntry(d: any) {
    if (d.isSidechain) return;
    const content = d.message?.content;

    if (d.type === "queue-operation") return handleQueue(d);

    if (d.type === "attachment" && d.attachment?.type === "queued_command") {
      const i = queue.findIndex((q) => q.text === d.attachment.prompt);
      if (i >= 0) deliver(queue.splice(i, 1)[0]);
      return;
    }

    if (d.type === "user") {
      const src = d.promptSource;
      if (typeof content === "string" && (src === "typed" || src === "queued") && !d.isMeta) {
        const s = suppress.indexOf(content);
        if (s >= 0) {
          suppress.splice(s, 1); // already shown as a queued bubble, now delivered
          return;
        }
        broadcast("message", userMessage(content, d.timestamp));
        return;
      }
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === "tool_result") {
            pendingTools.delete(b.tool_use_id);
            broadcast("tool_end", { id: b.tool_use_id, isError: !!b.is_error });
          }
        }
      }
      return;
    }

    if (d.type === "assistant" && Array.isArray(content)) {
      for (const b of content) {
        if (b.type === "text" && b.text.trim()) {
          broadcast("message", { role: "assistant", text: b.text, ts: d.timestamp });
        } else if (isNarration(b)) {
          broadcast("message", { role: "assistant", text: b.thinking, ts: d.timestamp, narration: true });
        } else if (b.type === "tool_use") {
          const t = { id: b.id, name: b.name, summary: toolSummary(b.input), ts: d.timestamp };
          pendingTools.set(b.id, t);
          broadcast("tool_start", t);
        }
      }
    }
  }

  const transcript = await findTranscript();
  if (transcript) {
    // Start from current end: only messages after the server starts are streamed.
    let offset = Bun.file(transcript).size;
    let reading = false;
    timers.push(
      setInterval(async () => {
        if (reading) return;
        reading = true;
        try {
          const f = Bun.file(transcript);
          if (f.size < offset) offset = 0; // truncated/rewritten
          if (f.size === offset) return;
          const buf = new Uint8Array(await f.slice(offset, f.size).arrayBuffer());
          const lastNl = buf.lastIndexOf(0x0a);
          if (lastNl < 0) return; // wait for full line
          offset += lastNl + 1;
          for (const line of new TextDecoder().decode(buf.subarray(0, lastNl)).split("\n")) {
            if (!line.trim()) continue;
            try {
              handleEntry(JSON.parse(line));
            } catch {}
          }
        } finally {
          reading = false;
        }
      }, 300),
    );
  }

  // ----- screen relay -----

  const screen = createScreencast({
    browserKey: opts.browser,
    // shell panes have no agent: fall back to the pane's own tab
    herdrTab: async () => (await agentInfo())?.tab_id ?? (await herdr(3000, "pane", "get", PANE))?.result?.pane?.tab_id,
  });

  // ----- presentation mode -----
  // on: viewers show only the screen, full size, with agent replies as
  // short-lived bubbles. rect: crop of the visible viewport (unset = whole screen).

  let present: Present = { on: false };
  function setPresent(next: Present) {
    present = next;
    screen.setClip(next.on ? (next.rect ?? null) : null);
    broadcast("present", present);
  }

  async function presentRequest(req: Request): Promise<Response> {
    const data = (await req.json().catch(() => ({}))) as { rect?: unknown; stop?: boolean; from?: string };
    if (data.stop) {
      const was = present.on;
      setPresent({ on: false });
      // Ended from the page: the agent may still be presenting, so tell it.
      // (The CLI stop comes from the agent itself and needs no notice.)
      let notified: string | undefined;
      if (was && data.from === "viewer") {
        const r = await promptAgent("present-stop", "사용자가 페이지에서 발표를 종료함");
        notified = r.ok ? "ok" : r.error;
      }
      return Response.json({ ok: true, present, notified });
    }
    let rect: Rect | undefined;
    if (data.rect != null) {
      rect = parseRect(data.rect) ?? undefined;
      if (!rect) return Response.json({ ok: false, error: "invalid_rect" }, { status: 400 });
    }
    setPresent({ on: true, rect, since: present.on ? present.since : new Date().toISOString() });
    return Response.json({ ok: true, present });
  }

  // ----- HTTP -----

  // Same-origin and localhost pages are allowed by default; add more with
  // allowOrigins (e.g. "null" for file:// pages).
  function originAllowed(origin: string | null, self: string): boolean {
    if (!origin || origin === self) return true;
    if (ALLOW_ORIGINS.includes("*") || ALLOW_ORIGINS.includes(origin)) return true;
    try {
      const u = new URL(origin);
      return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
    } catch {
      return false;
    }
  }

  function withCors(res: Response, origin: string | null): Response {
    if (origin) {
      res.headers.set("Access-Control-Allow-Origin", origin);
      res.headers.set("Vary", "Origin");
    }
    return res;
  }

  function events(): Response {
    let ctrl!: ReadableStreamDefaultController;
    let ping: Timer;
    const stream = new ReadableStream({
      start(c) {
        ctrl = c;
        clients.add(c);
        send(c, "hello", {
          transcript: !!transcript,
          pane: PANE,
          session: SESSION,
          queue: queue.filter((q) => q.human).map((q) => q.id),
          tools: [...pendingTools.keys()],
        });
        if (lastStatus) send(c, "status", lastStatus);
        send(c, "present", present);
        for (const t of pendingTools.values()) send(c, "tool_start", t);
        ping = setInterval(() => send(c, "ping", {}), 15000);
      },
      cancel() {
        clearInterval(ping);
        clients.delete(ctrl);
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  }

  // Type a [browser] prompt into the agent session.
  async function promptAgent(action: string, text: string): Promise<{ ok: boolean; error?: string; status?: number }> {
    const st = await checkStatus();
    if (!st.alive) return { ok: false, error: st.reason, status: 409 };
    if (st.status === "blocked") return { ok: false, error: "agent_blocked", status: 409 };
    const res = await herdr(10000, "agent", "prompt", PANE, formatPrompt(action, text.trim()));
    if (res?.error) return { ok: false, error: res.error.code, status: 502 };
    return { ok: true };
  }

  async function sendPrompt(req: Request): Promise<Response> {
    const data = (await req.json().catch(() => ({}))) as { action?: string; text?: string };
    const action = /^[\w-]{1,32}$/.test(data.action ?? "") ? data.action! : "message";
    const r = await promptAgent(action, data.text ?? "");
    return r.ok ? Response.json({ ok: true }) : Response.json({ ok: false, error: r.error }, { status: r.status });
  }

  async function route(req: Request, url: URL): Promise<Response> {
    if (url.pathname.startsWith("/panes")) {
      const res = await panesRoute(req, url.pathname, PANE);
      if (res) return res;
    }
    switch (url.pathname) {
      case "/status":
        return Response.json({
          ...(await checkStatus()),
          browser: opts.browser,
          screen: await screen.describe(),
          present,
        });
      case "/events":
        return events();
      case "/screen":
        return screen.handle();
      case "/terminal.js":
        return new Response(terminalJS, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
      case "/terminal.css":
        return new Response(terminalCSS, { headers: { "Content-Type": "text/css; charset=utf-8" } });
      case "/agent-bridge.js":
        return new Response(COMPONENT, {
          headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" },
        });
      case "/send":
        if (req.method === "POST") return sendPrompt(req);
        break;
      case "/present":
        return req.method === "POST" ? presentRequest(req) : Response.json(present);
    }
    return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  }

  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: opts.port,
    idleTimeout: 0, // keep SSE open
    websocket: {
      maxPayloadLength: 128 * 1024,
      open(ws) { if (ws.data.kind === "terminal") terminal.open(ws); },
      message(ws, msg) {
        if (ws.data.kind === "terminal") terminal.message(ws, String(msg));
        else screen.input(String(msg));
      },
      close(ws) { if (ws.data.kind === "terminal") terminal.close(ws); },
    },
    async fetch(req, server) {
      const url = new URL(req.url);
      const origin = req.headers.get("Origin");
      const isScript = ["/agent-bridge.js", "/terminal.js", "/terminal.css"].includes(url.pathname);

      // The component script itself is public; data and input endpoints are origin-checked.
      if (!isScript && !originAllowed(origin, url.origin))
        return Response.json({ ok: false, error: "origin_not_allowed" }, { status: 403 });

      if (req.method === "OPTIONS")
        return withCors(
          new Response(null, {
            status: 204,
            headers: {
              "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type",
              "Access-Control-Max-Age": "600",
            },
          }),
          origin,
        );

      if (url.pathname === "/input" || url.pathname === "/terminal")
        return server.upgrade(req, { data: { kind: url.pathname === "/terminal" ? "terminal" : "screen" } })
          ? undefined : new Response("websocket required", { status: 426 });

      const res = await route(req, url);
      return isScript ? (res.headers.set("Access-Control-Allow-Origin", "*"), res) : withCors(res, origin);
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    pane: PANE,
    session: SESSION,
    transcript,
    stop() {
      terminal.stop();
      timers.forEach(clearInterval);
      server.stop(true);
    },
  };
}
