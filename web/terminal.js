import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

export function mountTerminal(host, status, server) {
  const term = new Terminal({ fontSize: 14, fontFamily: 'Menlo, Consolas, monospace',
    cursorBlink: true, scrollback: 0, disableStdin: true,
    theme: { background: '#101114', foreground: '#e4e4e7' } });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  fit.fit();
  const ws = new WebSocket(`${server.replace(/^http/, "ws")}/terminal`);
  let active = true, ready = false, failed = false, queued = 0;
  let resizeTimer;
  const send = (msg) => {
    if (active && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const dimensions = () => ({ cols: Math.max(2, Math.min(500, term.cols)), rows: Math.max(2, Math.min(300, term.rows)) });
  status.textContent = "터미널 연결 중…";
  ws.onopen = () => send({ type: "terminal.start", ...dimensions() });
  ws.onmessage = (event) => {
    if (!active) return;
    try {
      const frame = JSON.parse(event.data);
      if (frame.type === "terminal.error") {
        failed = true;
        status.textContent = frame.message;
      } else if (frame.type === "terminal.frame") {
        const data = Uint8Array.from(atob(frame.bytes), (c) => c.charCodeAt(0));
        queued += data.length;
        if (queued > 4 * 1024 * 1024) {
          failed = true;
          status.textContent = "화면 처리가 지연되었습니다. 다시 연결해 주세요.";
          ws.close();
          return;
        }
        if (term.cols !== frame.width || term.rows !== frame.height) term.resize(frame.width, frame.height);
        term.write(data, () => { queued -= data.length; });
        if (!ready) {
          ready = true;
          term.options.disableStdin = false;
          status.textContent = "터미널 연결됨 · 키보드 입력 가능";
          term.focus();
        }
      }
    } catch {
      failed = true;
      status.textContent = "터미널 화면을 읽을 수 없습니다. 다시 연결해 주세요.";
      ws.close();
    }
  };
  ws.onclose = () => {
    if (!active) return;
    ready = false;
    term.options.disableStdin = true;
    if (!failed) status.textContent = "연결이 종료되었습니다. 다시 연결해 주세요.";
  };
  ws.onerror = () => { failed = true; status.textContent = "터미널 서버에 연결할 수 없습니다."; };
  term.onData((text) => { if (ready) send({ type: "terminal.input", text }); });
  // Herdr renders viewport frames; scroll the source viewport rather than an
  // xterm scrollback buffer. Herdr routes wheel events to alternate-screen apps.
  const wheel = (event) => {
    if (!ready || !event.deltaY || event.ctrlKey) return;
    event.preventDefault();
    event.stopPropagation();
    send({ type: "terminal.scroll", direction: event.deltaY < 0 ? "up" : "down",
      lines: Math.min(100, Math.max(1, Math.ceil(Math.abs(event.deltaY) / 40))) });
  };
  host.addEventListener("wheel", wheel, { passive: false, capture: true });
  const observer = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!active || !host.clientWidth || !host.clientHeight) return;
      fit.fit();
      if (ready) send({ type: "terminal.resize", ...dimensions() });
    }, 100);
  });
  observer.observe(host);
  return () => {
    active = false;
    clearTimeout(resizeTimer);
    observer.disconnect();
    host.removeEventListener("wheel", wheel, true);
    ws.close();
    term.dispose();
    host.replaceChildren();
  };
}
