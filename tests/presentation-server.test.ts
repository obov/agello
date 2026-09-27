import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../src/server";

const VIEWER = "cccccccc-3333-4333-8333-cccccccccccc";
const AUDIENCE = "dddddddd-4444-4444-8444-dddddddddddd";
const SECRET = "server-test-secret";
let dir: string;
let app: Awaited<ReturnType<typeof startServer>>;
let calls = 0;
const originalPath = process.env.PATH;
const originalKey = process.env.TYPECAST_API_KEY;
const originalFetch = globalThis.fetch;
const streams: AbortController[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "agello-presentation-"));
  const cli = join(dir, "herdr");
  await Bun.write(cli, `#!${process.execPath}
const args = process.argv.slice(2);
const result = args[0] === 'agent' && args[1] === 'get'
  ? { agent: { agent: 'claude', agent_status: 'idle' } }
  : args[0] === 'pane' ? { pane: { label: 'mock presentation' } } : {};
console.log(JSON.stringify({ result }));
`);
  await chmod(cli, 0o755);
  process.env.PATH = `${dir}:${originalPath}`;
  process.env.TYPECAST_API_KEY = "";
  // All real provider traffic is forbidden here; local HTTP uses the real fetch.
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.typecast.ai/")) {
      calls++;
      expect(init.headers["X-API-KEY"]).toBe(SECRET);
      return Response.json({ audio: Buffer.from("mock audio").toString("base64"), audio_format: "mp3", audio_duration: 1.5 });
    }
    if (!url.startsWith("http://127.0.0.1:")) throw new Error("Unexpected nonlocal network request in presentation tests");
    return originalFetch(input, init);
  }) as typeof fetch;
  app = await startServer({ pane: "test:presentation", port: 0, session: "" });
});
afterAll(async () => {
  streams.forEach((stream) => stream.abort());
  app?.stop();
  globalThis.fetch = originalFetch;
  process.env.PATH = originalPath;
  if (originalKey === undefined) delete process.env.TYPECAST_API_KEY; else process.env.TYPECAST_API_KEY = originalKey;
  await rm(dir, { recursive: true, force: true });
});
const post = async (path: string, data: any) => (await fetch(app.url + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })).json();
const get = async (path: string) => (await fetch(app.url + path)).json();
async function events(viewer: string) {
  const controller = new AbortController();
  streams.push(controller);
  const response = await fetch(app.url + "/events?viewer=" + viewer, { signal: controller.signal });
  const reader = response.body!.getReader();
  const output: { event: string; data: any }[] = [];
  void (async () => {
    let pending = "";
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        pending += decoder.decode(next.value, { stream: true });
        let end: number;
        while ((end = pending.indexOf("\n\n")) >= 0) {
          const block = pending.slice(0, end);
          pending = pending.slice(end + 2);
          const event = block.match(/^event: (.+)$/m)?.[1];
          const data = block.match(/^data: (.+)$/m)?.[1];
          if (event && data) output.push({ event, data: JSON.parse(data) });
        }
      }
    } catch { /* expected stream abort during cleanup */ }
  })();
  return output;
}
async function waitFor<T>(fn: () => T | undefined): Promise<T> {
  const end = Date.now() + 2000;
  while (Date.now() < end) {
    const value = fn();
    if (value !== undefined) return value;
    await Bun.sleep(5);
  }
  throw new Error("Expected presentation event not received");
}

test("HTTP/SSE narration sync, joining captions, interruption replay and redaction", async () => {
  const driverEvents = await events(VIEWER);
  await waitFor(() => driverEvents.find((entry) => entry.event === "tts"));
  expect((await get("/tts")).enabled).toBe(false);
  expect((await post("/script", { script: { steps: [{ say: ["first sentence", "second sentence"] }] } })).ok).toBe(true);
  const settings = await post("/tts", { apiKey: SECRET, enabled: true, viewerId: VIEWER });
  const token = settings.driverToken;
  expect(token).toBeString();
  expect(JSON.stringify(settings)).not.toContain(SECRET);
  const noToken = await post("/tts", { viewerId: VIEWER, voiceId: settings.tts.voiceId });
  expect(noToken.driverToken).toBeUndefined();
  await post("/player", { cmd: "resume" });
  const speech = (await waitFor(() => driverEvents.find((entry) => entry.data.phase === "ready")))!.data;
  expect(driverEvents.filter((entry) => entry.data.narration)).toHaveLength(0);
  expect((await get("/present")).player.next).toBe("1.1");
  expect((await post("/tts/ack", { viewerId: VIEWER, driverToken: "invalid", id: speech.id, phase: "started" })).accepted).toBe(false);
  expect((await post("/tts/ack", { viewerId: VIEWER, driverToken: token, id: speech.id, phase: "started" })).accepted).toBe(true);
  const caption = await waitFor(() => driverEvents.find((entry) => entry.data.narration === speech.id));
  expect(caption.event).toBe("message");
  expect(caption.data.text).toBe("first sentence");
  expect(caption.data.script).toBe("1.1");
  const audienceEvents = await events(AUDIENCE);
  const restored = await waitFor(() => audienceEvents.find((entry) => entry.data.narration === speech.id));
  expect(restored.data.text).toBe("first sentence");
  expect(audienceEvents.some((entry) => entry.data.phase === "ready")).toBe(false);
  const audio = await fetch(app.url + speech.audioUrl);
  expect(audio.headers.get("Content-Type")).toBe("audio/mpeg");
  expect(await audio.text()).toBe("mock audio");
  await post("/send", { action: "hand-raise", text: "question" });
  expect((await get("/present")).player).toMatchObject({ state: "paused", next: "1.1" });
  expect((await post("/tts/ack", { viewerId: VIEWER, driverToken: token, id: speech.id, phase: "ended" })).accepted).toBe(false);
  await waitFor(() => driverEvents.find((entry) => entry.data.phase === "cancel"));
  await post("/player", { cmd: "resume" });
  const replay = (await waitFor(() => driverEvents.find((entry) => entry.data.phase === "ready" && entry.data.id !== speech.id))).data;
  expect(calls).toBe(1);
  expect(replay.at).toBe("1.1");
  expect((await post("/tts/ack", { viewerId: AUDIENCE, driverToken: token, id: replay.id, phase: "started" })).accepted).toBe(false);
  await post("/tts", { enabled: false });
  expect((await get("/present")).player.state).toBe("paused");
  await post("/player", { cmd: "resume" });
  await waitFor(() => driverEvents.findLast((entry) => entry.event === "message" && entry.data.script === "1.1" && !entry.data.narration));
  await post("/player", { cmd: "pause" });
  const publicData = [await get("/tts"), await get("/present"), await get("/script"), driverEvents, audienceEvents];
  expect(JSON.stringify(publicData)).not.toContain(SECRET);
  expect(JSON.stringify(publicData)).not.toContain(token);
  const rejected = await fetch(app.url + "/tts", { method: "POST", headers: { Origin: "https://untrusted.example" }, body: JSON.stringify({ apiKey: SECRET }) });
  expect(rejected.status).toBe(403);
  const module = await fetch(app.url + "/presentation-media.js");
  expect(module.headers.get("Content-Type")).toContain("javascript");
});
