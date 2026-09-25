import type { ServerWebSocket } from "bun";

export type SocketData = { kind: "screen" | "terminal" };
type Socket = ServerWebSocket<SocketData>;
const MAX_MESSAGE = 128 * 1024;

// The CLI owns Herdr's socket handshake and emits ordered ANSI frame envelopes.
// Never use --takeover: another controller must release its session first.
export function createTerminal(pane: string) {
  let owner: Socket | null = null;
  let childProcess: ReturnType<typeof Bun.spawn> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function close(ws: Socket) {
    if (owner !== ws) return;
    owner = null;
    clearTimeout(timer);
    const child = childProcess;
    childProcess = null;
    if (child) {
      try { (child.stdin as any).end(); } catch {}
      child.kill(); // Disconnect only; Herdr keeps the underlying pane alive.
    }
  }

  function fail(ws: Socket, message: string) {
    ws.send(JSON.stringify({ type: "terminal.error", message }));
    close(ws);
    ws.close(1011, "Terminal disconnected");
  }

  function send(ws: Socket, frame: unknown) {
    if (owner !== ws) return;
    if (ws.getBufferedAmount() > 4 * 1024 * 1024) {
      fail(ws, "연결이 느려 터미널을 닫았습니다. 다시 연결해 주세요.");
      return;
    }
    ws.send(JSON.stringify(frame));
  }

  async function pump(ws: Socket, child: ReturnType<typeof Bun.spawn>) {
    let pending = "";
    let stderr = "";
    let received = false;
    const readError = (async () => {
      for await (const chunk of child.stderr as ReadableStream<Uint8Array>) {
        stderr = (stderr + new TextDecoder().decode(chunk)).slice(-2000);
      }
    })();
    try {
      const decoder = new TextDecoder();
      for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
        if (owner !== ws) break;
        pending += decoder.decode(chunk, { stream: true });
        if (pending.length > 8 * 1024 * 1024) throw new Error("Terminal frame too large");
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (!line.trim()) continue;
          const frame = JSON.parse(line);
          if (frame.type === "terminal.frame" && frame.encoding === "ansi") {
            if (!received) { received = true; clearTimeout(timer); }
            send(ws, frame);
          } else if (frame.type === "terminal.closed") {
            fail(ws, frame.reason || "터미널 연결이 종료되었습니다.");
          }
        }
      }
      await child.exited;
      await readError;
      if (owner === ws) fail(ws, stderr.trim() || "터미널 연결이 종료되었습니다. 다시 연결해 주세요.");
    } catch {
      if (owner === ws) fail(ws, "터미널 스트림을 읽을 수 없습니다.");
    }
  }

  return {
    open(ws: Socket) {
      if (owner) {
        ws.send(JSON.stringify({ type: "terminal.error", message: "다른 브라우저가 터미널을 사용 중입니다." }));
        ws.close(1008, "Terminal busy");
        return;
      }
      owner = ws;
      timer = setTimeout(() => fail(ws, "터미널 연결 시간이 초과되었습니다."), 10000);
    },
    message(ws: Socket, raw: string) {
      if (owner !== ws) return;
      try {
        if (raw.length > MAX_MESSAGE) throw new Error("Message too large");
        const msg = JSON.parse(raw);
        const size = () => Number.isInteger(msg.cols) && Number.isInteger(msg.rows)
          && msg.cols >= 2 && msg.cols <= 500 && msg.rows >= 2 && msg.rows <= 300;
        if (msg.type === "terminal.start" && !childProcess && size()) {
          childProcess = Bun.spawn([Bun.which("herdr", { PATH: process.env.PATH }) ?? "herdr", "terminal", "session", "control", pane,
            "--cols", String(msg.cols), "--rows", String(msg.rows)],
          { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
          void pump(ws, childProcess);
          return;
        }
        if (!childProcess) throw new Error("Terminal not started");
        let command: object;
        if (msg.type === "terminal.input" && typeof msg.text === "string" && msg.text.length <= 65536) {
          command = { type: msg.type, text: msg.text };
        } else if (msg.type === "terminal.resize" && size()) {
          command = { type: msg.type, cols: msg.cols, rows: msg.rows };
        } else if (msg.type === "terminal.scroll" && ["up", "down"].includes(msg.direction)
            && Number.isInteger(msg.lines) && msg.lines > 0 && msg.lines <= 100) {
          command = { type: msg.type, direction: msg.direction, lines: msg.lines };
        } else throw new Error("Invalid terminal message");
        const input = childProcess.stdin as Bun.FileSink;
        if (input.write(JSON.stringify(command) + "\n") > 1024 * 1024) throw new Error("Input overflow");
        input.flush();
      } catch {
        fail(ws, "터미널 요청을 처리할 수 없습니다.");
      }
    },
    close,
    stop() { if (owner) close(owner); },
  };
}
