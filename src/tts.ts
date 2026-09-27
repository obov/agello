// Session-only Typecast credentials and single-viewer narration coordination.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const TYPECAST = {
  endpoint: "https://api.typecast.ai/v1/text-to-speech/with-timestamps",
  model: "ssfm-v30", language: "kor", voiceId: "tc_6a0e85a97f7750959b970d5d",
};
export type TtsStatus = {
  provider: "typecast"; configured: boolean; enabled: boolean;
  voiceId: string; language: string; model: string; driverId?: string; error?: string;
};
export type SpeechEvent = {
  phase: "ready" | "cancel" | "ended" | "error"; id: string; driverId?: string;
  at?: string; text?: string; audioUrl?: string; duration?: number; error?: string;
};
type Audio = { bytes: Uint8Array; duration: number };
type Active = {
  id: string; started: boolean; duration: number; timer?: Timer;
  text: string; at: string;
  start: (duration: number, id: string) => void;
  finish: () => void; fail: (error: Error) => void;
};
const VIEWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_AUDIO = 20 * 1024 * 1024;
const abortError = () => new DOMException("Cancelled", "AbortError");

// Parse only the named credential; no shell evaluation, expansion or .env loading.
export function parseTypecastKey(source: string): string | undefined {
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?TYPECAST_API_KEY\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[1].trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      const end = value.indexOf(quote, 1);
      if (end < 0 || !/^\s*(?:#.*)?$/.test(value.slice(end + 1))) return undefined;
      value = value.slice(1, end);
    } else value = value.replace(/\s+#.*$/, "").trim();
    return value || undefined;
  }
}

export async function synthesizeTypecast(
  apiKey: string, voiceId: string, text: string, signal: AbortSignal,
  doFetch: typeof fetch = fetch,
): Promise<Audio> {
  if (!text.trim() || [...text].length > 2000) throw new Error("tts_text_limit");
  let response: Response;
  try {
    response = await doFetch(TYPECAST.endpoint + "?granularity=word", {
      method: "POST", signal,
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ model: TYPECAST.model, text, voice_id: voiceId, language: TYPECAST.language,
        prompt: { emotion_type: "preset", emotion_preset: "normal", emotion_intensity: 1 },
        output: { audio_format: "mp3", target_lufs: -14 } }),
    });
  } catch { throw new Error(signal.aborted ? "tts_cancelled" : "tts_network_error"); }
  // Provider bodies and exceptions can contain credentials: never forward them.
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "tts_invalid_key" : "tts_provider_error");
  let data: any;
  try { data = await response.json(); } catch { throw new Error("tts_invalid_audio"); }
  if (typeof data.audio !== "string" || !data.audio || data.audio.length > MAX_AUDIO * 1.4 ||
      data.audio_format !== "mp3" || !Number.isFinite(data.audio_duration) || data.audio_duration <= 0 || data.audio_duration > 600)
    throw new Error("tts_invalid_audio");
  const bytes = Buffer.from(data.audio, "base64");
  if (!bytes.length || bytes.length > MAX_AUDIO) throw new Error("tts_invalid_audio");
  return { bytes, duration: data.audio_duration };
}

export function createTts(deps: {
  emit: (event: "tts" | "speech", data: TtsStatus | SpeechEvent) => void;
  pause: () => void;
  apiKey?: string; cwd?: string; fetch?: typeof fetch; startTimeoutMs?: number; prepareTimeoutMs?: number;
  readLocalKey?: () => Promise<string | undefined>;
}) {
  let apiKey = deps.apiKey ?? process.env.TYPECAST_API_KEY ?? "";
  let enabled = false;
  let voiceId = TYPECAST.voiceId;
  let driverId: string | undefined;
  let driverToken: string | undefined;
  let error: string | undefined;
  let active: Active | undefined;
  let preparing: AbortController | undefined;
  const connected = new Map<string, number>();
  const cache = new Map<string, Audio>();
  const urls = new Map<string, Audio & { expires: number }>();
  let cacheBytes = 0;
  let stopped = false;
  let configuration = 0;

  const status = (): TtsStatus => ({ provider: "typecast", configured: !!apiKey, enabled,
    voiceId, language: TYPECAST.language, model: TYPECAST.model,
    ...(driverId ? { driverId } : {}), ...(error ? { error } : {}) });
  const changed = () => deps.emit("tts", status());
  const clearAudio = () => { cache.clear(); urls.clear(); cacheBytes = 0; };
  const pruneUrls = () => {
    for (const [id, audio] of urls) if (audio.expires <= Date.now() && id !== active?.id) urls.delete(id);
    let bytes = [...urls.values()].reduce((sum, audio) => sum + audio.bytes.byteLength, 0);
    while (urls.size > 16 || bytes > 40 * 1024 * 1024) {
      const oldest = [...urls.keys()].find((id) => id !== active?.id);
      if (!oldest) break;
      bytes -= urls.get(oldest)!.bytes.byteLength;
      urls.delete(oldest);
    }
  };
  function fail(code: string) {
    error = code;
    const item = active;
    if (item) {
      active = undefined;
      clearTimeout(item.timer);
      deps.emit("speech", { phase: "error", id: item.id, driverId, error: code });
      item.fail(new Error(code));
    }
    preparing?.abort();
    changed();
    deps.pause();
  }
  function cancel() {
    preparing?.abort();
    preparing = undefined;
    const item = active;
    if (!item) return;
    active = undefined;
    clearTimeout(item.timer);
    deps.emit("speech", { phase: "cancel", id: item.id, driverId });
    item.fail(abortError());
  }

  async function configure(data: any): Promise<{ ok: boolean; tts: TtsStatus; driverToken?: string; error?: string }> {
    if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, tts: status(), error: "invalid_tts_config" };
    for (const field of ["enabled", "useLocalKey", "clearKey"]) if (data[field] !== undefined && typeof data[field] !== "boolean")
      return { ok: false, tts: status(), error: "invalid_tts_config" };
    if (data.apiKey !== undefined && (typeof data.apiKey !== "string" || data.apiKey.length > 4096 || /[\r\n]/.test(data.apiKey)))
      return { ok: false, tts: status(), error: "invalid_tts_config" };
    if (data.voiceId !== undefined && (typeof data.voiceId !== "string" || !/^(?:tc|uc)_[a-zA-Z0-9_-]{1,100}$/.test(data.voiceId)))
      return { ok: false, tts: status(), error: "invalid_voice" };
    if (data.enabled === true && (typeof data.viewerId !== "string" || !VIEWER.test(data.viewerId)))
      return { ok: false, tts: status(), error: "invalid_viewer" };
    if (data.enabled === true && !connected.get(data.viewerId))
      return { ok: false, tts: status(), error: "tts_driver_disconnected" };
    const revision = ++configuration;
    if (stopped) return { ok: false, tts: status(), error: "tts_stopped" };
    let nextKey = apiKey;
    if (data.useLocalKey) {
      try {
        nextKey = (deps.readLocalKey ? await deps.readLocalKey() : parseTypecastKey(await readFile(
          resolve(deps.cwd ?? process.cwd(), "../yt-outlier/.env"), "utf8"))) ?? "";
      } catch { return { ok: false, tts: status(), error: "tts_local_key_unavailable" }; }
      if (!nextKey) return { ok: false, tts: status(), error: "tts_local_key_unavailable" };
    }
    if (revision !== configuration || stopped)
      return { ok: false, tts: status(), error: "tts_config_superseded" };
    if (data.enabled === true && !connected.get(data.viewerId))
      return { ok: false, tts: status(), error: "tts_driver_disconnected" };
    if (data.apiKey !== undefined) nextKey = data.apiKey.trim();
    if (data.clearKey) nextKey = "";
    if (!data.clearKey && (data.enabled ?? enabled) && !nextKey) return { ok: false, tts: status(), error: "tts_key_required" };
    // Configuration changes apply from the next explicit resume.
    deps.pause();
    cancel();
    if (nextKey !== apiKey || (data.voiceId && data.voiceId !== voiceId)) clearAudio();
    apiKey = nextKey;
    if (data.voiceId) voiceId = data.voiceId;
    if (data.enabled !== undefined) enabled = data.enabled;
    if (data.clearKey) enabled = false;
    if (enabled && data.enabled === true) {
      driverId = data.viewerId;
      driverToken = crypto.randomUUID();
    }
    if (!enabled) { driverId = undefined; driverToken = undefined; }
    error = undefined;
    changed();
    return { ok: true, tts: status(), ...(enabled && data.enabled === true ? { driverToken } : {}) };
  }

  async function speak(text: string, at: string, signal: AbortSignal, onStart: Active["start"]): Promise<void> {
    if (stopped || signal.aborted) throw abortError();
    if (!driverId || !connected.get(driverId)) { fail("tts_driver_disconnected"); throw new Error("tts_driver_disconnected"); }
    error = undefined;
    changed();
    const ctrl = new AbortController();
    preparing = ctrl;
    const onAbort = () => { ctrl.abort(); cancel(); };
    signal.addEventListener("abort", onAbort, { once: true });
    const prepareTimer = setTimeout(() => { if (preparing === ctrl) fail("tts_prepare_timeout"); }, deps.prepareTimeoutMs ?? 45000);
    try {
      const cacheId = voiceId + ":" + text;
      let audio = cache.get(cacheId);
      if (!audio) {
        audio = await synthesizeTypecast(apiKey, voiceId, text, ctrl.signal, deps.fetch);
        if (ctrl.signal.aborted || signal.aborted || preparing !== ctrl) throw abortError();
        cache.set(cacheId, audio);
        cacheBytes += audio.bytes.byteLength;
        while (cache.size > 24 || cacheBytes > 40 * 1024 * 1024) {
          const oldest = cache.keys().next().value!;
          cacheBytes -= cache.get(oldest)!.bytes.byteLength;
          cache.delete(oldest);
        }
      }
      if (signal.aborted || ctrl.signal.aborted) throw abortError();
      preparing = undefined;
      clearTimeout(prepareTimer);
      const id = crypto.randomUUID();
      urls.set(id, { ...audio, expires: Date.now() + 10 * 60 * 1000 });
      pruneUrls();
      await new Promise<void>((finish, reject) => {
        active = { id, text, at, started: false, duration: audio!.duration, start: onStart, finish, fail: reject,
          timer: setTimeout(() => fail("tts_start_timeout"), deps.startTimeoutMs ?? 15000) };
        deps.emit("speech", { phase: "ready", id, driverId, at, text, audioUrl: `/tts/audio/${id}`, duration: audio!.duration });
      });
    } catch (cause) {
      if (!signal.aborted && !ctrl.signal.aborted && error === undefined) {
        const code = cause instanceof Error && /^tts_[a-z_]+$/.test(cause.message) ? cause.message : "tts_failed";
        fail(code);
      }
      throw cause;
    } finally {
      clearTimeout(prepareTimer);
      if (preparing === ctrl) preparing = undefined;
      signal.removeEventListener("abort", onAbort);
    }
  }

  function acknowledge(data: any) {
    if (!active || !driverToken || data?.viewerId !== driverId || data?.driverToken !== driverToken || data?.id !== active.id) return false;
    if (data.phase === "started" && !active.started) {
      active.started = true;
      clearTimeout(active.timer);
      active.timer = setTimeout(() => fail("tts_end_timeout"), active.duration * 2000 + 15000);
      active.start(active.duration, active.id);
      return true;
    }
    if (data.phase === "ended" && active.started) {
      const item = active;
      active = undefined;
      clearTimeout(item.timer);
      deps.emit("speech", { phase: "ended", id: item.id, driverId });
      item.finish();
      return true;
    }
    if (data.phase === "error") { fail("tts_playback_error"); return true; }
    return false;
  }

  async function handle(req: Request, pathname = new URL(req.url).pathname): Promise<Response | null> {
    if (pathname === "/tts") {
      if (req.method === "GET") return Response.json(status());
      if (req.method === "POST") {
        const data = await req.json().catch(() => null);
        const result = await configure(data);
        return Response.json(result, { status: result.ok ? 200 : 400 });
      }
      return new Response(null, { status: 405 });
    }
    if (pathname === "/tts/ack") {
      if (req.method !== "POST") return new Response(null, { status: 405 });
      return Response.json({ ok: true, accepted: acknowledge(await req.json().catch(() => null)) });
    }
    if (pathname.startsWith("/tts/audio/")) {
      if (req.method !== "GET") return new Response(null, { status: 405 });
      pruneUrls();
      const audio = urls.get(pathname.slice("/tts/audio/".length));
      return audio ? new Response(audio.bytes as BodyInit, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } })
        : Response.json({ ok: false, error: "tts_audio_not_found" }, { status: 404 });
    }
    return null;
  }

  return {
    status, configure, handle, acknowledge,
    // A joining audience receives the caption, never playback or its token.
    currentNarration: () => active?.started
      ? { text: active.text, script: active.at, narration: active.id, hold: active.duration } : null,
    narrate: (text: string, at: string, signal: AbortSignal, started: Active["start"]) => enabled ? speak(text, at, signal, started) : null,
    connect(viewer: string | null) { if (viewer && VIEWER.test(viewer)) connected.set(viewer, (connected.get(viewer) ?? 0) + 1); },
    disconnect(viewer: string | null) {
      if (!viewer) return;
      const count = (connected.get(viewer) ?? 0) - 1;
      if (count > 0) connected.set(viewer, count); else connected.delete(viewer);
      if (enabled && viewer === driverId && !connected.has(viewer)) fail("tts_driver_disconnected");
    },
    stop() {
      stopped = true; configuration++; cancel(); clearAudio(); connected.clear();
      apiKey = ""; driverToken = undefined; driverId = undefined; enabled = false;
    },
  };
}
