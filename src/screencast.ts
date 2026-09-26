import { runJson } from "./run.ts";

// terminal-browser screen relay: CDP Page.startScreencast -> SSE (/screen).
//
// Discovers the terminal-browser instance with `terminal-browser ls --all --json`,
// follows its active tab, and streams JPEG frames only while at least one
// viewer is connected. input() forwards whitelisted CDP Input.* commands
// from the viewer to the page (user control).

type Browser = {
  key: string;
  cdpPort: number;
  pane?: { tab: string; pane: string };
  tabs: { id: number; url: string; title: string; active: boolean; targetId: string; agentControlled: boolean }[];
};

// Presentation crop: a rectangle of the visible viewport, in CSS pixels.
export type Rect = { x: number; y: number; w: number; h: number };

export type ScreenMeta = {
  connected: boolean;
  reason?: "browser_not_found" | "no_browser_in_tab" | "tab_unknown" | "no_active_tab";
  browser?: string;
  url?: string;
  title?: string;
  agentControlled?: boolean;
};

export function createScreencast(opts: { browserKey?: string; herdrTab?: () => Promise<string | undefined> }) {
  const viewers = new Set<ReadableStreamDefaultController>();
  const enc = new TextEncoder();

  let meta: ScreenMeta = { connected: false };
  type Frame = { data: string; w: number; h: number; clip?: Rect };
  let lastFrame: Frame | null = null; // full screencast frame
  let lastCrop: Frame | null = null; // cropped frame while a clip is set
  let clip: Rect | null = null;
  let ws: WebSocket | null = null;
  let wsTarget = "";
  let msgId = 0;
  let timer: Timer | null = null;
  const pending = new Map<number, (result: any) => void>();

  const emit = (c: ReadableStreamDefaultController, event: string, data: unknown) => {
    try {
      c.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    } catch {
      viewers.delete(c);
    }
  };
  const broadcast = (event: string, data: unknown) => viewers.forEach((c) => emit(c, event, data));

  function setMeta(next: ScreenMeta) {
    if (JSON.stringify(next) === JSON.stringify(meta)) return;
    meta = next;
    broadcast("meta", meta);
  }

  async function listBrowsers(): Promise<Browser[]> {
    // timeout: a hung terminal-browser must not pile up processes or stall sync
    return (await runJson(["terminal-browser", "ls", "--all", "--json"], 3000))?.browsers ?? [];
  }

  // Only ever relay (and forward input to) the intended browser: the one given
  // with --browser, or one in the agent's own herdr tab. Never fall back to
  // another tab's browser: that would expose another agent's screen and let
  // "my control" type into it.
  async function pickBrowser(): Promise<{ browser?: Browser; reason?: ScreenMeta["reason"] }> {
    const all = await listBrowsers();
    if (opts.browserKey) {
      const browser = all.find((b) => b.key === opts.browserKey);
      return browser ? { browser } : { reason: "browser_not_found" };
    }
    const tab = await opts.herdrTab?.();
    if (!tab) return { reason: "tab_unknown" };
    const browser = all.find((b) => b.pane?.tab === tab);
    return browser ? { browser } : { reason: "no_browser_in_tab" };
  }

  function disconnect() {
    ws?.close();
    ws = null;
    wsTarget = "";
    pending.forEach((r) => r(null));
    pending.clear();
  }

  // CDP call that resolves with the result (null on error or closed socket).
  function request(method: string, params: object = {}): Promise<any> {
    const sock = ws;
    if (!sock || sock.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    return new Promise((resolve) => {
      const id = ++msgId;
      const t = setTimeout(() => pending.delete(id) && resolve(null), 5000);
      pending.set(id, (r) => (clearTimeout(t), resolve(r)));
      sock.send(JSON.stringify({ id, method, params }));
    });
  }

  // While a clip is set, only the clipped region is sent to viewers: every
  // screencast frame (= the page changed) triggers one Page.captureScreenshot
  // of the rectangle at full device resolution. At most one capture runs at a
  // time; changes during a capture are coalesced into one more capture.
  let capturing = false;
  let dirty = false;
  async function capture() {
    if (!clip) return;
    if (capturing) {
      dirty = true;
      return;
    }
    capturing = true;
    try {
      do {
        dirty = false;
        const c = clip;
        if (!c) break;
        // clip coordinates are document-relative; the rect is viewport-relative
        const vv = (await request("Page.getLayoutMetrics"))?.cssVisualViewport;
        if (!vv) break;
        const shot = await request("Page.captureScreenshot", {
          format: "jpeg",
          quality: 85,
          clip: { x: c.x + vv.pageX, y: c.y + vv.pageY, width: c.w, height: c.h, scale: 1 },
        });
        if (!shot?.data || clip !== c) continue;
        lastCrop = { data: shot.data, w: c.w, h: c.h, clip: c };
        broadcast("frame", lastCrop);
        await Bun.sleep(100); // cap at ~10 captures/s
      } while (dirty && clip);
    } finally {
      capturing = false;
    }
  }

  function setClip(next: Rect | null) {
    clip = next;
    lastCrop = null;
    if (clip) capture();
    else if (lastFrame) broadcast("frame", lastFrame);
  }

  function connect(port: number, targetId: string) {
    disconnect();
    const url = `ws://127.0.0.1:${port}/devtools/page/${targetId}`;
    wsTarget = url;
    const sock = new WebSocket(url);
    ws = sock;
    const call = (method: string, params: object = {}) =>
      sock.send(JSON.stringify({ id: ++msgId, method, params }));

    sock.onopen = () => {
      call("Page.enable");
      call("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 1600, maxHeight: 1600 });
      if (clip) capture();
    };
    sock.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && pending.has(msg.id)) {
        const resolve = pending.get(msg.id)!;
        pending.delete(msg.id);
        resolve(msg.result ?? null);
        return;
      }
      if (msg.method !== "Page.screencastFrame") return;
      const { data, metadata, sessionId } = msg.params;
      call("Page.screencastFrameAck", { sessionId });
      lastFrame = { data, w: metadata.deviceWidth, h: metadata.deviceHeight };
      if (clip) capture();
      else broadcast("frame", lastFrame);
    };
    sock.onclose = () => {
      if (ws === sock) {
        ws = null;
        wsTarget = "";
      }
    };
  }

  let syncing = false; // skip a tick while the previous sync is still running
  async function sync() {
    if (syncing) return;
    syncing = true;
    try {
      await syncOnce();
    } finally {
      syncing = false;
    }
  }

  async function syncOnce() {
    const { browser: b, reason } = await pickBrowser();
    const tab = b?.tabs.find((t) => t.active);
    if (!b || !tab) {
      disconnect();
      lastFrame = null;
      lastCrop = null;
      setMeta({ connected: false, reason: reason ?? "no_active_tab" });
      return;
    }
    const url = `ws://127.0.0.1:${b.cdpPort}/devtools/page/${tab.targetId}`;
    if (url !== wsTarget || !ws) connect(b.cdpPort, tab.targetId);
    setMeta({
      connected: true,
      browser: b.key,
      url: tab.url,
      title: tab.title,
      agentControlled: tab.agentControlled,
    });
  }

  function start() {
    if (timer) return;
    sync();
    timer = setInterval(sync, 1500);
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    disconnect();
    lastFrame = null;
    lastCrop = null;
    meta = { connected: false };
  }

  // SSE response for one viewer.
  function handle(): Response {
    let ctrl!: ReadableStreamDefaultController;
    let ping: Timer;
    const stream = new ReadableStream({
      start(c) {
        ctrl = c;
        viewers.add(c);
        emit(c, "meta", meta);
        const f = clip ? lastCrop : lastFrame;
        if (f) emit(c, "frame", f);
        ping = setInterval(() => emit(c, "ping", {}), 15000);
        start();
      },
      cancel() {
        clearInterval(ping);
        viewers.delete(ctrl);
        if (viewers.size === 0) stop();
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  }

  const INPUT_METHODS = new Set(["Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText"]);
  function input(raw: string) {
    let m: any;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    // input coordinates assume the full frame: ignore input while cropped
    if (clip || !INPUT_METHODS.has(m?.method) || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ id: ++msgId, method: m.method, params: m.params ?? {} }));
  }

  // Which browser the relay uses (or would use), for status reporting.
  async function describe(): Promise<ScreenMeta> {
    if (meta.connected) return meta;
    const { browser, reason } = await pickBrowser();
    return browser ? { connected: false, browser: browser.key } : { connected: false, reason };
  }

  // Run JS in the relayed tab (presentation script `go`). Needs the relay to be
  // connected, i.e. at least one viewer. Returns false if it could not run.
  async function evaluate(expression: string): Promise<boolean> {
    const r = await request("Runtime.evaluate", { expression, awaitPromise: true });
    return !!r && !r.exceptionDetails;
  }

  // Annotation: which element is at a point (hover / click) or where a
  // selected element is now (by selector). Coordinates are CSS px of the
  // visible viewport, same as the full screencast frame. Not while cropped.
  async function inspect(q: InspectQuery): Promise<Inspected | null> {
    if (clip) return null;
    const r = await request("Runtime.evaluate", {
      expression: `(${INSPECT_JS})(${JSON.stringify(q)})`,
      returnByValue: true,
    });
    return r && !r.exceptionDetails ? (r.result?.value ?? null) : null;
  }

  return { handle, input, describe, setClip, evaluate, inspect };
}

export type InspectQuery = { x?: number; y?: number; selector?: string; full?: boolean };
export type Inspected = {
  selector: string;
  label: string; // tag#id.class, for the hover tooltip
  rect: { x: number; y: number; w: number; h: number };
  text?: string; // full only
  url?: string; // full only
};

// Runs in the page. Selector: nearest unique id / data-testid ancestor, then
// tag:nth-of-type steps down to the element (light DOM only).
const INSPECT_JS = String((q: InspectQuery) => {
  let el: Element | null = null;
  if (q.selector) {
    try {
      el = document.querySelector(q.selector);
    } catch {}
  } else el = document.elementFromPoint(q.x ?? 0, q.y ?? 0);
  if (!el || el === document.documentElement) return null;
  const esc = CSS.escape;
  const unique = (s: string) => document.querySelectorAll(s).length === 1;
  const step = (e: Element): [string, boolean] => {
    if (e.id && unique(`#${esc(e.id)}`)) return [`#${esc(e.id)}`, true];
    for (const a of ["data-testid", "data-test", "data-cy"]) {
      const v = e.getAttribute(a);
      if (v && unique(`[${a}="${esc(v)}"]`)) return [`[${a}="${esc(v)}"]`, true];
    }
    const same = e.parentElement ? [...e.parentElement.children].filter((c) => c.localName === e.localName) : [];
    return [same.length > 1 ? `${e.localName}:nth-of-type(${same.indexOf(e) + 1})` : e.localName, false];
  };
  const parts: string[] = [];
  for (let e: Element | null = el; e && e !== document.documentElement; e = e.parentElement) {
    const [s, anchor] = step(e);
    parts.unshift(s);
    if (anchor || e === document.body) break;
  }
  const cls = [...el.classList].slice(0, 2).map((c) => `.${c}`).join("");
  const r = el.getBoundingClientRect();
  const out: any = {
    selector: parts.join(" > "),
    label: `${el.localName}${el.id ? `#${el.id}` : ""}${cls}`,
    rect: { x: r.x, y: r.y, w: r.width, h: r.height },
  };
  if (q.full) {
    const t = (el as HTMLInputElement).value || el.getAttribute("aria-label") || el.getAttribute("alt") || el.textContent || "";
    out.text = t.replace(/\s+/g, " ").trim().slice(0, 80);
    out.url = location.href;
  }
  return out;
});
