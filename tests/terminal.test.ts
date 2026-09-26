import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server";

let dir: string, bridge: Awaited<ReturnType<typeof startServer>>;
const originalPath = process.env.PATH;
const sockets: WebSocket[] = [];
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "agello-terminal-"));
  const cli = join(dir, "herdr");
  await Bun.write(cli, `#!${process.execPath}
if (process.argv[2] !== 'terminal') { console.log('{}'); process.exit(0); }
let cols=Number(process.argv[process.argv.indexOf('--cols')+1]);
let rows=Number(process.argv[process.argv.indexOf('--rows')+1]);
let seq=0;
const frame=(text)=>console.log(JSON.stringify({type:'terminal.frame',encoding:'ansi',full:++seq===1,seq,width:cols,height:rows,bytes:Buffer.from(text).toString('base64')}));
frame('initial cursor \\x1b[3;4H');
let pending='';
for await (const chunk of Bun.stdin.stream()) {
 pending+=new TextDecoder().decode(chunk);
 let n;
 while((n=pending.indexOf('\\n'))>=0){
  const m=JSON.parse(pending.slice(0,n));pending=pending.slice(n+1);
  if(m.type==='terminal.resize'){cols=m.cols;rows=m.rows;}
  frame(JSON.stringify(m));
 }
}
`);
  await chmod(cli, 0o755);
  process.env.PATH = `${dir}:${originalPath}`;
  bridge = await startServer({ port: 0, pane: "test:p1" });
});
afterAll(async () => {
  sockets.forEach((ws) => ws.close());
  bridge?.stop();
  process.env.PATH = originalPath;
  await rm(dir, { recursive: true, force: true });
});
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await Bun.sleep(10); }
  throw new Error("Timed out");
}
async function connect() {
  const ws = new WebSocket(bridge.url.replace("http", "ws") + "/terminal");
  sockets.push(ws);
  const frames: any[] = [];
  ws.onmessage = (e) => frames.push(JSON.parse(e.data));
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject; });
  return { ws, frames };
}
const start = (ws: WebSocket) => ws.send(JSON.stringify({ type: "terminal.start", cols: 80, rows: 24 }));

test("serves local terminal assets and rejects untrusted websocket origins", async () => {
  for (const [path, type] of [["/terminal.js", "text/javascript"], ["/terminal.css", "text/css"]]) {
    const r = await fetch(bridge.url + path);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain(type);
    expect((await r.text()).length).toBeGreaterThan(100);
  }
  expect((await fetch(bridge.url + "/terminal", { headers: { Origin: "https://untrusted.example" } })).status).toBe(403);
  expect((await fetch(bridge.url + "/terminal")).status).toBe(426);
});

test("streams ANSI, preserves keyboard bytes, resizes, and releases exclusive control", async () => {
  const a = await connect(); start(a.ws);
  await until(() => a.frames.length > 0);
  expect(a.frames[0]).toHaveProperty("full", true);
  expect(Buffer.from(a.frames[0].bytes, "base64").toString()).toContain("\x1b[3;4H");
  const b = await connect();
  await until(() => b.frames.length > 0);
  expect(b.frames[0].type).toBe("terminal.error");
  const text = "한글\x1b[A\x03\r";
  a.ws.send(JSON.stringify({ type: "terminal.input", text }));
  a.ws.send(JSON.stringify({ type: "terminal.resize", cols: 100, rows: 30 }));
  await until(() => a.frames.length >= 3);
  expect(JSON.parse(Buffer.from(a.frames[1].bytes, "base64").toString()).text).toBe(text);
  expect(a.frames[2].width).toBe(100);
  expect(a.frames[2].height).toBe(30);
  a.ws.close(); await until(() => a.ws.readyState === WebSocket.CLOSED); await Bun.sleep(30);
  const c = await connect(); start(c.ws);
  await until(() => c.frames.length > 0);
  expect(c.frames[0].full).toBe(true);
  c.ws.send(JSON.stringify({ type: "terminal.resize", cols: -1, rows: 0 }));
  await until(() => c.ws.readyState === WebSocket.CLOSED);
  expect(c.frames.at(-1).type).toBe("terminal.error");
});

test("uploads pasted terminal images and returns their paths", async () => {
  const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
  const ok = await (await fetch(bridge.url + "/upload", { method: "POST", body: JSON.stringify({ images: [{ type: "image/png", data: png }] }) })).json();
  expect(ok.paths[0]).toMatch(/agello-uploads\/[\w-]+\.png$/);
  await rm(ok.paths[0]);
  expect((await fetch(bridge.url + "/upload", { method: "POST", body: JSON.stringify({ images: [{ type: "text/plain", data: png }] }) })).status).toBe(400);
  expect((await fetch(bridge.url + "/upload", { method: "POST", headers: { Origin: "https://untrusted.example" }, body: "{}" })).status).toBe(403);
});
