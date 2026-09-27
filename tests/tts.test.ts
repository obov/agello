import { expect, test } from "bun:test";
import { createTts, parseTypecastKey, synthesizeTypecast, TYPECAST } from "../src/tts";
const VIEWER = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const SECRET = "secret-for-unit-test";
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const success = () => Response.json({ audio: Buffer.from("fake mp3 bytes").toString("base64"), audio_format: "mp3", audio_duration: 1.25 });
function fixture(extra: any = {}) {
  const events: any[] = [];
  let calls = 0;
  let pauses = 0;
  const tts = createTts({ apiKey: SECRET, emit: (event, data) => events.push({ event, data }), pause: () => pauses++,
    fetch: async () => { calls++; return success(); }, ...extra });
  tts.connect(VIEWER);
  return { tts, events, calls: () => calls, pauses: () => pauses };
}
async function enable(tts: ReturnType<typeof createTts>) {
  const result = await tts.configure({ enabled: true, viewerId: VIEWER });
  expect(result.ok).toBe(true);
  return result.driverToken!;
}
function ready(events: any[]) { return events.findLast((entry) => entry.data.phase === "ready").data; }

test("dotenv reads only named key, respects quotes/comments, never evaluates expansion", () => {
  expect(parseTypecastKey("OTHER=x\nexport TYPECAST_API_KEY='abc#123' # note")).toBe("abc#123");
  expect(parseTypecastKey('TYPECAST_API_KEY="xyz"\nOTHER=y')).toBe("xyz");
  expect(parseTypecastKey("TYPECAST_API_KEY=abc # note")).toBe("abc");
  expect(parseTypecastKey("TYPECAST_API_KEY='unterminated")).toBeUndefined();
  expect(parseTypecastKey("TYPECAST_API_KEY=$(never-execute)")).toBe("$(never-execute)");
});

test("Typecast request uses official preset fields and validates audio", async () => {
  let options: RequestInit | undefined;
  const result = await synthesizeTypecast(SECRET, TYPECAST.voiceId, "hello", new AbortController().signal, async (_url, init) => {
    options = init;
    return success();
  });
  expect((options!.headers as any)["X-API-KEY"]).toBe(SECRET);
  expect(JSON.parse(options!.body as string)).toMatchObject({ model: "ssfm-v30", language: "kor", prompt: { emotion_type: "preset" }, output: { audio_format: "mp3" } });
  expect(result.duration).toBe(1.25);
  await expect(synthesizeTypecast(SECRET, TYPECAST.voiceId, "x".repeat(2001), new AbortController().signal)).rejects.toThrow("tts_text_limit");
  await expect(synthesizeTypecast(SECRET, TYPECAST.voiceId, "hi", new AbortController().signal,
    async () => Response.json({ audio: "", audio_duration: 3, audio_format: "mp3" }))).rejects.toThrow("tts_invalid_audio");
});

test("provider errors never return raw body, exception or key", async () => {
  for (const fake of [async () => new Response(SECRET, { status: 401 }), async () => { throw new Error(SECRET); }]) {
    try { await synthesizeTypecast(SECRET, TYPECAST.voiceId, "hi", new AbortController().signal, fake); }
    catch (error) { expect(String(error)).not.toContain(SECRET); }
  }
});

test("single driver controls start/end, duplicate and old ACKs are ignored, audio cached", async () => {
  const { tts, events, calls } = fixture();
  const token = await enable(tts);
  let starts = 0;
  const ctrl = new AbortController();
  const pending = tts.narrate("hello", "1.1", ctrl.signal, () => starts++)!;
  await flush();
  const speech = ready(events);
  expect(starts).toBe(0);
  expect(tts.acknowledge({ viewerId: OTHER, driverToken: token, id: speech.id, phase: "started" })).toBe(false);
  expect(tts.acknowledge({ viewerId: VIEWER, driverToken: "wrong", id: speech.id, phase: "started" })).toBe(false);
  expect(tts.acknowledge({ viewerId: VIEWER, driverToken: token, id: speech.id, phase: "ended" })).toBe(false);
  const ack = { viewerId: VIEWER, driverToken: token, id: speech.id };
  expect(tts.acknowledge({ ...ack, phase: "started" })).toBe(true);
  expect(tts.acknowledge({ ...ack, phase: "started" })).toBe(false);
  expect(starts).toBe(1);
  expect(tts.acknowledge({ ...ack, phase: "ended" })).toBe(true);
  await pending;
  expect(tts.acknowledge({ ...ack, phase: "ended" })).toBe(false);
  const audio = (await tts.handle(new Request("http://local" + speech.audioUrl)))!;
  expect(audio.headers.get("Content-Type")).toBe("audio/mpeg");
  expect(audio.headers.get("Cache-Control")).toBe("no-store");
  expect(await audio.text()).toBe("fake mp3 bytes");
  const replay = new AbortController();
  const retry = tts.narrate("hello", "1.1", replay.signal, () => {})!;
  const caught = retry.catch(() => {});
  await flush();
  expect(calls()).toBe(1);
  replay.abort();
  await caught;
  expect(events.at(-1).data.phase).toBe("cancel");
  tts.stop();
});

test("late synth response after abort cannot emit ready or populate audio", async () => {
  let resolveFetch!: (response: Response) => void;
  const { tts, events } = fixture({ fetch: () => new Promise<Response>((resolve) => { resolveFetch = resolve; }) });
  await enable(tts);
  const ctrl = new AbortController();
  const result = tts.narrate("hi", "1.1", ctrl.signal, () => {})!.catch(() => {});
  ctrl.abort();
  resolveFetch(success());
  await result;
  expect(events.some((entry) => entry.data.phase === "ready")).toBe(false);
  tts.stop();
});

test("start timeout and driver disconnect pause and fail instead of hanging", async () => {
  const { tts, pauses } = fixture({ startTimeoutMs: 10 });
  await enable(tts);
  await expect(tts.narrate("hi", "1.1", new AbortController().signal, () => {})!).rejects.toThrow("tts_start_timeout");
  expect(pauses()).toBeGreaterThan(1);
  expect(tts.status().error).toBe("tts_start_timeout");
  tts.connect(VIEWER); // duplicate connection keeps the driver alive after one disconnect
  tts.disconnect(VIEWER);
  expect(tts.status().error).toBe("tts_start_timeout");
  tts.disconnect(VIEWER);
  expect(tts.status().error).toBe("tts_driver_disconnected");
  tts.stop();
});

test("local key requires opt-in; public responses redact keys and tokens", async () => {
  let reads = 0;
  const { tts, events } = fixture({ apiKey: "", readLocalKey: async () => { reads++; return SECRET; } });
  expect(reads).toBe(0);
  expect(tts.status().configured).toBe(false);
  const token = (await tts.configure({ useLocalKey: true, enabled: true, viewerId: VIEWER })).driverToken!;
  expect(reads).toBe(1);
  expect(tts.status()).toMatchObject({ enabled: true, configured: true });
  const noToken = await tts.configure({ viewerId: VIEWER, voiceId: TYPECAST.voiceId });
  expect(noToken.driverToken).toBeUndefined();
  const publicResponse = await (await tts.handle(new Request("http://local/tts")))!.text();
  expect(publicResponse).not.toContain(SECRET);
  expect(publicResponse).not.toContain(token);
  expect(JSON.stringify(events)).not.toContain(SECRET);
  expect(JSON.stringify(events)).not.toContain(token);
  await tts.configure({ clearKey: true });
  expect(tts.status()).toMatchObject({ enabled: false, configured: false });
  tts.stop();
});

test("configuration rejects malformed fields and disconnected viewers without changing mode", async () => {
  const { tts } = fixture();
  for (const data of [null, [], { enabled: "true" }, { voiceId: "https://bad" }, { apiKey: "key\nheader" }, { enabled: true, viewerId: OTHER }])
    expect((await tts.configure(data)).ok).toBe(false);
  expect(tts.status().enabled).toBe(false);
  expect((await tts.configure({ voiceId: "uc_custom_voice" })).ok).toBe(true);
  tts.stop();
});

test("joining viewers can restore only a started current caption", async () => {
  const { tts, events } = fixture();
  const token = await enable(tts);
  const controller = new AbortController();
  const pending = tts.narrate("live caption", "2.3", controller.signal, () => {})!;
  const caught = pending.catch(() => {});
  await flush();
  const speech = ready(events);
  expect(tts.currentNarration()).toBeNull();
  tts.acknowledge({ viewerId: VIEWER, driverToken: token, id: speech.id, phase: "started" });
  expect(tts.currentNarration()).toEqual({ text: "live caption", script: "2.3", narration: speech.id, hold: 1.25 });
  controller.abort();
  await caught;
  expect(tts.currentNarration()).toBeNull();
  tts.stop();
});

test("late local import cannot undo clearKey or restore credentials after stop", async () => {
  for (const action of ["clear", "stop"]) {
    let complete!: (key: string) => void;
    const { tts } = fixture({ apiKey: "", readLocalKey: () => new Promise<string>((resolve) => { complete = resolve; }) });
    const pending = tts.configure({ useLocalKey: true });
    if (action === "clear") await tts.configure({ clearKey: true }); else tts.stop();
    complete(SECRET);
    expect((await pending).ok).toBe(false);
    expect(tts.status().configured).toBe(false);
    tts.stop();
  }
});

test("viewer disconnect while reading local key cannot acquire playback ownership", async () => {
  let complete!: (key: string) => void;
  const { tts } = fixture({ apiKey: "", readLocalKey: () => new Promise<string>((resolve) => { complete = resolve; }) });
  const pending = tts.configure({ enabled: true, viewerId: VIEWER, useLocalKey: true });
  tts.disconnect(VIEWER);
  complete(SECRET);
  expect(await pending).toMatchObject({ ok: false, error: "tts_driver_disconnected" });
  expect(tts.status()).toMatchObject({ enabled: false, configured: false });
  tts.stop();
});
