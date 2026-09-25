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
  let lastFrame: { data: string; w: number; h: number } | null = null;
  let ws: WebSocket | null = null;
  let wsTarget = "";
  let msgId = 0;
  let timer: Timer | null = null;

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
    };
    sock.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.method !== "Page.screencastFrame") return;
      const { data, metadata, sessionId } = msg.params;
      call("Page.screencastFrameAck", { sessionId });
      lastFrame = { data, w: metadata.deviceWidth, h: metadata.deviceHeight };
      broadcast("frame", lastFrame);
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
        if (lastFrame) emit(c, "frame", lastFrame);
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
    if (!INPUT_METHODS.has(m?.method) || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ id: ++msgId, method: m.method, params: m.params ?? {} }));
  }

  // Which browser the relay uses (or would use), for status reporting.
  async function describe(): Promise<ScreenMeta> {
    if (meta.connected) return meta;
    const { browser, reason } = await pickBrowser();
    return browser ? { connected: false, browser: browser.key } : { connected: false, reason };
  }

  return { handle, input, describe };
}
