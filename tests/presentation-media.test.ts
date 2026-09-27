import { expect, test } from "bun:test";
import { PresentationMedia, drawPresentation, recordingMime, wrapCaption, finalizeWebmDuration } from "../web/presentation-media.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const response = (data: unknown = { ok: true, accepted: true }, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => data, arrayBuffer: async () => new ArrayBuffer(4) });
const ready = (id = "line-1", driverId = "viewer") => ({ phase: "ready", id, driverId, audioUrl: `/tts/audio/${id}` });
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

function harness() {
  const calls: any[] = [], sources: any[] = [], silences: any[] = [], recorders: any[] = [], tracks: any[] = [], revoked: string[] = [];
  const intervals = new Map<number, () => void>(), frames = new Map<number, Function>();
  const flags = { throwStart: false, now: 0, url: 0, timer: 0 };
  const track = (kind: string) => {
    const value = { kind, stopped: false, requestedFrames: 0, requestFrame() { this.requestedFrames++; }, stop() { this.stopped = true; }, clone() { return track(kind); } };
    tracks.push(value); return value;
  };
  const stream = (values: any[]) => ({ getTracks: () => values, getVideoTracks: () => values.filter((t) => t.kind === "video"), getAudioTracks: () => values.filter((t) => t.kind === "audio"), addTrack: (value: any) => values.push(value) });
  const audioTrack = track("audio");
  const ctx = { fillStyle: "", font: "", textBaseline: "", fillRect() {}, drawImage(...args: any[]) { calls.push(["draw", ...args]); }, beginPath() {}, rect() {}, roundRect() {}, fill() {}, fillText(...args: any[]) { calls.push(["caption", ...args]); }, measureText: (text: string) => ({ width: Array.from(text).length * 10 }) };
  class AudioContext {
    state = "suspended";
    destination = {};
    async resume() { this.state = "running"; }
    async close() { this.state = "closed"; }
    createMediaStreamDestination() { return { stream: stream([audioTrack]) }; }
    createConstantSource() {
      const source = { offset: { value: 1 }, started: false, stopped: false, disconnected: false, connections: [] as any[], start() { this.started = true; }, stop() { this.stopped = true; }, connect(value: any) { this.connections.push(value); }, disconnect() { this.disconnected = true; } };
      silences.push(source); return source;
    }
    async decodeAudioData() { return { duration: 2 }; }
    createBufferSource() {
      const source = { buffer: null, onended: null as any, started: false, stopped: false, disconnected: false, connections: [] as any[], connect(value: any) { this.connections.push(value); }, disconnect() { this.disconnected = true; }, start() { this.started = true; calls.push(["audio-start"]); }, stop() { this.stopped = true; this.onended?.(); } };
      sources.push(source); return source;
    }
  }
  class MediaRecorder {
    static isTypeSupported(type: string) { return type.startsWith("video/webm"); }
    state = "inactive";
    mimeType: string;
    ondataavailable: any; onstop: any; onerror: any; completion: any;
    constructor(public stream: any, options: any) { this.mimeType = options.mimeType; recorders.push(this); }
    start() { if (flags.throwStart) throw new Error("start failed"); this.state = "recording"; }
    stop() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["video"]) }); this.completion = this.onstop?.(); }
  }
  const env: any = {
    AudioContext, MediaRecorder, Blob, performance: { now: () => flags.now },
    document: { createElement: () => ({ width: 0, height: 0, getContext: () => ctx, captureStream: (rate: number) => { calls.push(["capture-rate", rate]); return stream([track("video")]); } }) },
    URL: { createObjectURL: () => `blob:${++flags.url}`, revokeObjectURL: (url: string) => revoked.push(url) },
    fetch: async (url: string, options: any = {}) => { calls.push([url, options.body && JSON.parse(options.body)]); return response(); },
    requestAnimationFrame: (fn: Function) => { const id = ++flags.timer; frames.set(id, fn); return id; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    setInterval: (fn: () => void) => { const id = ++flags.timer; intervals.set(id, fn); return id; },
    clearInterval: (id: number) => intervals.delete(id),
  };
  const speech: any[] = [];
  const image = { complete: true, naturalWidth: 1280, naturalHeight: 720 };
  const media = new PresentationMedia({ viewerId: "viewer", image, env, onSpeech: (e: any) => speech.push(e), captions: () => [{ text: "안녕하세요", kind: "agent" }] });
  media.reset("http://localhost");
  const enable = async () => { await media.unlock(); media.setConfig({ enabled: true, configured: true, voiceId: "voice", driverId: "viewer" }, "secret-token"); };
  const acks = () => calls.filter(([url]) => String(url).endsWith("/tts/ack")).map(([, body]) => body.phase);
  return { media, image, env, ctx, calls, sources, silences, recorders, tracks, revoked, intervals, frames, flags, speech, enable, acks, audioTrack };
}

test("TTS and recording default off and browser recording format is detected", () => {
  const { media } = harness();
  expect(media.config.enabled).toBe(false); expect(media.recording).toBeNull();
  expect(recordingMime({ isTypeSupported: (type: string) => type === "video/mp4" })).toBe("video/mp4");
  expect(recordingMime({ isTypeSupported: () => false })).toBe("");
});

test("canvas letterboxes the image and wraps Korean captions inside the safe area", () => {
  const { ctx, calls, image } = harness();
  expect(wrapCaption(ctx, "가나다라\n마바", 20)).toEqual(["가나", "다라", "마바"]);
  drawPresentation(ctx, { ...image, naturalWidth: 720, naturalHeight: 720 }, [{ text: "안녕하세요", kind: "agent" }]);
  expect(calls.find(([kind]) => kind === "draw").slice(2)).toEqual([280, 0, 720, 720]);
  const caption = calls.find(([kind]) => kind === "caption");
  expect(caption[1]).toBe("안녕하세요"); expect(caption[3]).toBeLessThan(692);
});

test("only the driver starts audio, then sends started/ended ACKs in order", async () => {
  const h = harness(); await h.enable();
  await h.media.handleSpeech(ready("other", "another-viewer")); expect(h.sources).toHaveLength(0);
  await h.media.handleSpeech(ready());
  expect(h.sources[0].started).toBe(true); expect(h.sources[0].connections).toHaveLength(2);
  expect(h.acks()).toEqual(["started"]);
  h.sources[0].onended(); await settle(); expect(h.acks()).toEqual(["started", "ended"]);
  await h.media.handleSpeech(ready()); expect(h.sources).toHaveLength(1);
});

test("cancel during fetch or decode prevents stale audio from starting", async () => {
  for (const phase of ["fetch", "decode"]) {
    const h = harness(); await h.enable();
    const pending = deferred<any>();
    if (phase === "fetch") h.env.fetch = () => pending.promise;
    else h.media.context.decodeAudioData = () => pending.promise;
    const work = h.media.handleSpeech(ready()); await settle();
    h.media.cancelSpeech(); pending.resolve(phase === "fetch" ? response() : { duration: 2 });
    await work; expect(h.sources).toHaveLength(0); expect(h.acks()).toEqual([]);
  }
});

test("cancel stops audio immediately without sending ended ACK", async () => {
  const h = harness(); await h.enable(); await h.media.handleSpeech(ready());
  h.media.cancelSpeech(); await settle();
  expect(h.sources[0].stopped).toBe(true); expect(h.sources[0].disconnected).toBe(true);
  expect(h.acks()).toEqual(["started"]); expect(h.speech.at(-1).phase).toBe("cancel");
});

test("failed or rejected started ACK stops audio and sends an error ACK", async () => {
  for (const mode of ["network", "rejected"]) {
    const h = harness(); await h.enable();
    h.env.fetch = async (url: string, options: any = {}) => {
      const body = options.body && JSON.parse(options.body); h.calls.push([url, body]);
      if (body?.phase === "started") {
        if (mode === "network") throw new Error("offline");
        return response({ ok: true, accepted: false });
      }
      return response();
    };
    await h.media.handleSpeech(ready());
    expect(h.acks()).toEqual(["started", "error"]); expect(h.sources[0].stopped).toBe(true); expect(h.media.error).not.toBe("");
  }
});

test("a cancelled line error does not cancel a newer line", async () => {
  const h = harness(); await h.enable();
  const pending = deferred<any>();
  const fetch = h.env.fetch;
  h.env.fetch = (url: string, options: any) => url.endsWith("/line-1") ? pending.promise : fetch(url, options);
  const old = h.media.handleSpeech(ready("line-1")); await settle();
  await h.media.handleSpeech(ready("line-2")); pending.resolve(response({}, false)); await old;
  expect(h.media.active.id).toBe("line-2"); expect(h.sources[0].stopped).toBe(false);
});

test("audio gesture requirement reports error and pauses via error ACK", async () => {
  const h = harness(); h.media.setConfig({ enabled: true, driverId: "viewer" }, "token");
  await h.media.handleSpeech(ready()); expect(h.acks()).toEqual(["error"]);
  expect(h.media.error).toContain("TTS 켜기");
});

test("recording without TTS has video only, finalizes a download and releases resources", async () => {
  const h = harness(); h.media.startRecording();
  expect(h.recorders[0].stream.getAudioTracks()).toHaveLength(0); expect(h.frames.size).toBe(1);
  h.media.stopRecording(); await h.recorders[0].completion; expect(h.media.recording).toBeNull(); expect(h.media.download.name).toEndWith(".webm");
  expect(h.tracks.filter((t) => t.kind === "video").every((t) => t.stopped)).toBe(true);
  expect(h.frames.size).toBe(0); expect(h.intervals.size).toBe(0);
  h.media.startRecording(); h.media.stopRecording(); await h.recorders[1].completion; expect(h.revoked).toEqual(["blob:1"]);
});

test("manual video clock requests initial, scheduled, and immediate caption frames", async () => {
  const h = harness(); h.media.startRecording();
  const track = h.recorders[0].stream.getVideoTracks()[0];
  expect(h.calls.find(([kind]) => kind === "capture-rate")[1]).toBe(0);
  expect(track.requestedFrames).toBe(1);
  h.media.flushRecordingFrame(); expect(track.requestedFrames).toBe(2);
  const callback = [...h.frames.values()][0]; callback(40); expect(track.requestedFrames).toBe(3);
  h.media.stopRecording(); await h.recorders[0].completion;
  h.media.flushRecordingFrame(); expect(track.requestedFrames).toBe(3);
});

test("TTS recording clones its audio track; stopping recording preserves speech playback", async () => {
  const h = harness(); await h.enable(); await h.media.handleSpeech(ready());
  h.media.startRecording(); const audio = h.recorders[0].stream.getAudioTracks()[0];
  expect(audio).not.toBe(h.audioTrack); h.media.stopRecording();
  expect(audio.stopped).toBe(true); expect(h.audioTrack.stopped).toBe(false); expect(h.sources[0].stopped).toBe(false);
});

test("recording audio has a continuous silent clock and releases it on reset", async () => {
  const h = harness(); await h.enable(); await h.media.unlock();
  expect(h.silences).toHaveLength(1);
  const silence = h.silences[0];
  expect(silence.started).toBe(true); expect(silence.offset.value).toBe(0);
  expect(silence.connections).toEqual([h.media.audioDestination]);
  expect(silence.connections).not.toContain(h.media.context.destination);
  h.media.startRecording(); await h.media.handleSpeech(ready());
  h.sources[0].onended(); await settle();
  expect(silence.stopped).toBe(false); h.media.stopRecording(); await h.recorders[0].completion;
  expect(silence.stopped).toBe(false);
  h.media.reset("http://next");
  expect(silence.stopped).toBe(true); expect(silence.disconnected).toBe(true);
  expect(h.media.silenceSource).toBeNull();
  await h.media.unlock(); expect(h.silences).toHaveLength(2);
  h.media.reset("http://next", true); expect(h.silences[1].stopped).toBe(true);
});

test("recording TTS changes are blocked locally and finalize on remote config change", async () => {
  const h = harness(); h.media.startRecording();
  await expect(h.media.configure({ enabled: true })).rejects.toThrow("녹화를 종료");
  h.media.setConfig({ enabled: true, driverId: "viewer" });
  await h.recorders[0].completion;
  expect(h.media.recording).toBeNull(); expect(h.media.download).not.toBeNull();
});

test("local pause blocks a not-yet-ready line until observed pause and subsequent resume", async () => {
  const h = harness(); await h.enable();
  h.media.pauseSpeech(); h.media.observePlayer("playing");
  await h.media.handleSpeech(ready("late")); expect(h.sources).toHaveLength(0);
  h.media.observePlayer("paused"); await h.media.handleSpeech(ready("still-late")); expect(h.sources).toHaveLength(0);
  h.media.observePlayer("playing"); await h.media.handleSpeech(ready("new")); expect(h.sources).toHaveLength(1);
  h.media.pauseSpeech(); h.media.resumeSpeech(); await h.media.handleSpeech(ready("explicit")); expect(h.sources).toHaveLength(2);
});

test("another viewer's TTS does not prevent video-only recording", () => {
  const h = harness(); h.media.setConfig({ enabled: true, driverId: "another" }); h.media.startRecording();
  expect(h.recorders[0].stream.getAudioTracks()).toHaveLength(0);
  h.media.setConfig({ enabled: false }); expect(h.media.recording).not.toBeNull(); h.media.stopRecording();
});

test("recorder start errors and missing images leave no live recording resources", () => {
  const h = harness(); h.flags.throwStart = true;
  expect(() => h.media.startRecording()).toThrow("start failed"); expect(h.media.recording).toBeNull();
  expect(h.tracks.filter((t) => t.kind === "video").every((t) => t.stopped)).toBe(true);
  h.image.complete = false; expect(() => h.media.startRecording()).toThrow("화면이 표시");
});

test("duration and memory limits finalize bounded recordings", async () => {
  const timed = harness(); timed.media.startRecording(); timed.flags.now = 15 * 60 * 1000;
  [...timed.intervals.values()][0](); await timed.recorders[0].completion; expect(timed.media.recording).toBeNull(); expect(timed.media.error).toContain("15분");
  const size = harness(); size.media.startRecording(); size.media.recording.bytes = 256 * 1024 * 1024;
  size.recorders[0].ondataavailable({ data: new Blob(["too much"]) });
  await size.recorders[0].completion;
  expect(size.media.recording).toBeNull(); expect(size.media.error).toContain("256MB");
});

test("server changes stop voice/recording and disposal revokes download URLs", async () => {
  const h = harness(); await h.enable(); await h.media.handleSpeech(ready()); h.media.startRecording();
  const context = h.media.context; h.media.reset("http://next-server");
  await h.recorders[0].completion;
  expect(context.state).toBe("closed"); expect(h.sources[0].stopped).toBe(true); expect(h.media.driverToken).toBeNull();
  expect(h.media.recording).toBeNull(); expect(h.media.download).not.toBeNull();
  h.media.reset("http://next-server", true); expect(h.revoked).toEqual(["blob:1"]); expect(h.media.download).toBeNull();
});

test("WebM finalization adds duration while preserving video bytes and unknown Segment size", async () => {
  // Chrome's real streaming header shape: EBML, unknown-sized Segment, Info, Cluster.
  const header = Uint8Array.from(Buffer.from("1a45dfa3801853806701ffffffffffffff1549a966992ad7b1830f42404d80864368726f6d655741864368726f6d65", "hex"));
  const tail = new Uint8Array(70_000); tail.set([0x1f, 0x43, 0xb6, 0x75, 0xff]);
  const blob = new Blob([header, tail], { type: "video/webm" });
  const result = await finalizeWebmDuration(blob, 12_500);
  const bytes = new Uint8Array(await result.arrayBuffer());
  expect(result.size).toBe(blob.size + 11); expect(result.type).toBe("video/webm");
  const marker = Buffer.from(bytes).indexOf(Buffer.from([0x44, 0x89, 0x88]));
  expect(marker).toBe(header.length); expect(new DataView(bytes.buffer).getFloat64(marker + 3)).toBe(12_500);
  expect(bytes.slice(header.length + 11)).toEqual(tail);
  expect(await finalizeWebmDuration(new Blob(["not webm"]), 1000)).toEqual(new Blob(["not webm"]));
});

test("a configuration response from an old server cannot restore its key or driver", async () => {
  const h = harness(); const pending = deferred<any>(); h.env.fetch = () => pending.promise;
  const work = h.media.configure({ apiKey: "private-key", enabled: true });
  h.media.reset("http://next"); pending.resolve(response({ ok: true, tts: { enabled: true, configured: true }, driverToken: "old-token" }));
  await work; expect(h.media.config.enabled).toBe(false); expect(h.media.driverToken).toBeNull();
});
