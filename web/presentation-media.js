// Browser-only presentation media. Credentials never enter history or browser storage.
export const DEFAULT_VOICE = "tc_6a0e85a97f7750959b970d5d";
const MIME_TYPES = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
export function recordingMime(Recorder) {
  return MIME_TYPES.find((type) => Recorder.isTypeSupported(type)) || "";
}

// MediaRecorder's streaming WebM omits Duration. Patch only the small EBML
// header, retaining cluster bytes as Blob slices instead of copying the video.
function ebmlElement(bytes, offset) {
  const variable = (at, strip) => {
    if (at >= bytes.length || !bytes[at]) return null;
    let length = 1;
    while (length <= 8 && !(bytes[at] & (0x80 >> (length - 1)))) length++;
    if (length > 8 || at + length > bytes.length) return null;
    let value = BigInt(strip ? bytes[at] & ((0x80 >> (length - 1)) - 1) : bytes[at]);
    for (let i = 1; i < length; i++) value = (value << 8n) | BigInt(bytes[at + i]);
    return { value, length, unknown: strip && value === (1n << BigInt(7 * length)) - 1n };
  };
  const id = variable(offset, false);
  if (!id) return null;
  const size = variable(offset + id.length, true);
  if (!size) return null;
  const body = offset + id.length + size.length;
  return { id: Number(id.value), size: size.unknown ? Infinity : Number(size.value), sizeAt: offset + id.length, sizeLength: size.length, body, end: size.unknown ? Infinity : body + Number(size.value) };
}

function ebmlWriteSize(bytes, at, length, value) {
  let integer = BigInt(value);
  if (integer < 0 || integer >= (1n << BigInt(length * 7)) - 1n) return false;
  for (let i = length - 1; i >= 0; i--) { bytes[at + i] = Number(integer & 255n); integer >>= 8n; }
  bytes[at] |= 0x80 >> (length - 1);
  return true;
}

export async function finalizeWebmDuration(blob, elapsedMs, BlobClass = Blob) {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return blob;
  const bytes = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
  let at = 0, segment;
  while (at < bytes.length) {
    const element = ebmlElement(bytes, at);
    if (!element) return blob;
    if (element.id === 0x18538067) { segment = element; break; }
    at = element.end;
  }
  if (!segment) return blob;
  let info, scale = 1_000_000, duration;
  const seekHeads = [];
  at = segment.body;
  while (at < bytes.length) {
    const element = ebmlElement(bytes, at);
    if (!element || element.end > bytes.length) break;
    if (element.id === 0x1549a966) info = element;
    if (element.id === 0x114d9b74) seekHeads.push(element);
    at = element.end;
  }
  if (!info) return blob;
  for (at = info.body; at < info.end;) {
    const child = ebmlElement(bytes, at);
    if (!child || child.end > info.end || child.id === 0xbf) return blob; // avoid invalidating CRC metadata
    if (child.id === 0x2ad7b1) {
      scale = 0;
      for (let i = child.body; i < child.end; i++) scale = scale * 256 + bytes[i];
    }
    if (child.id === 0x4489) duration = child;
    at = child.end;
  }
  if (!scale) return blob;
  const value = elapsedMs * 1_000_000 / scale;
  if (duration) {
    const view = new DataView(bytes.buffer);
    if (duration.size === 8) view.setFloat64(duration.body, value);
    else if (duration.size === 4) view.setFloat32(duration.body, value);
    else return blob;
    return new BlobClass([bytes, blob.slice(bytes.length)], { type: blob.type });
  }
  const extra = new Uint8Array(11);
  extra.set([0x44, 0x89, 0x88]); new DataView(extra.buffer).setFloat64(3, value);
  if (!ebmlWriteSize(bytes, info.sizeAt, info.sizeLength, info.size + extra.length)) return blob;
  if (Number.isFinite(segment.size) && !ebmlWriteSize(bytes, segment.sizeAt, segment.sizeLength, segment.size + extra.length)) return blob;
  // Preserve SeekHead positions when a browser includes an index before clusters.
  for (const head of seekHeads) {
    for (at = head.body; at < head.end;) {
      const entry = ebmlElement(bytes, at);
      if (!entry || entry.end > head.end || entry.id === 0xbf) return blob;
      if (entry.id === 0x4dbb) {
        for (let offset = entry.body; offset < entry.end;) {
          const child = ebmlElement(bytes, offset);
          if (!child || child.end > entry.end) return blob;
          if (child.id === 0x53ac) {
            let position = 0n;
            for (let i = child.body; i < child.end; i++) position = (position << 8n) | BigInt(bytes[i]);
            if (position >= BigInt(info.end - segment.body)) {
              position += BigInt(extra.length);
              if (position >= 1n << BigInt(8 * child.size)) return blob;
              for (let i = child.end - 1; i >= child.body; i--) { bytes[i] = Number(position & 255n); position >>= 8n; }
            }
          }
          offset = child.end;
        }
      }
      at = entry.end;
    }
  }
  return new BlobClass([bytes.slice(0, info.end), extra, bytes.slice(info.end), blob.slice(bytes.length)], { type: blob.type });
}

// Character wrapping also works for Korean lines without spaces.
export function wrapCaption(ctx, text, width) {
  const lines = [];
  for (const paragraph of String(text).split("\n")) {
    let line = "";
    for (const char of Array.from(paragraph)) {
      if (line && ctx.measureText(line + char).width > width) { lines.push(line); line = ""; }
      line += char;
    }
    lines.push(line);
  }
  return lines;
}

export function drawPresentation(ctx, image, captions, width = 1280, height = 720) {
  ctx.fillStyle = "#0b0b0c";
  ctx.fillRect(0, 0, width, height);
  if (image.complete && image.naturalWidth && image.naturalHeight) {
    const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
    const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
    ctx.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
  }
  let bottom = height - 28;
  for (const caption of captions.slice(-3).reverse()) {
    const event = caption.kind === "event";
    const font = event ? 20 : 28, lineHeight = event ? 28 : 38;
    ctx.font = `${font}px system-ui, sans-serif`;
    // Keep the safe area readable even for unusually long script lines.
    const all = wrapCaption(ctx, caption.text, width - 256);
    const lines = all.slice(0, 8);
    if (all.length > lines.length) lines[lines.length - 1] += "…";
    const boxWidth = Math.min(width - 208, Math.max(80, ...lines.map((line) => ctx.measureText(line).width)) + 40);
    const boxHeight = lines.length * lineHeight + 24;
    const x = (width - boxWidth) / 2, y = bottom - boxHeight;
    if (y < 100) break;
    ctx.fillStyle = event ? "rgba(255,255,255,.92)" : caption.kind === "user" ? "rgba(47,111,237,.9)" : "rgba(20,20,22,.82)";
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, boxWidth, boxHeight, 16);
    else ctx.rect(x, y, boxWidth, boxHeight);
    ctx.fill();
    ctx.fillStyle = event ? "#1d1d1f" : "#fff";
    ctx.textBaseline = "top";
    lines.forEach((line, i) => ctx.fillText(line, x + 20, y + 12 + i * lineHeight));
    bottom = y - 10;
  }
}

export class PresentationMedia {
  constructor({ viewerId, image, captions = () => [], onChange = () => {}, onSpeech = () => {}, env = globalThis }) {
    Object.assign(this, { viewerId, image, captions, onChange, onSpeech, env });
    this.config = { enabled: false, configured: false, voiceId: DEFAULT_VOICE };
    this.server = "";
    this.driverToken = null;
    this.version = 0;
    this.retired = new Set();
    this.recording = null;
    this.download = null;
    this.active = null;
    this.context = null;
    this.error = "";
    this.suspended = false;
    this.localPausePending = false;
    this.disposed = false;
  }

  changed() { this.onChange(this); }
  report(error) { this.error = String(error?.message || error); this.changed(); }
  async unlock() {
    if (!this.context || this.context.state === "closed") {
      const AudioContext = this.env.AudioContext || this.env.webkitAudioContext;
      if (!AudioContext) throw new Error("이 브라우저는 TTS 음성 재생을 지원하지 않아요.");
      this.context = new AudioContext();
      this.audioDestination = this.context.createMediaStreamDestination();
      // Keep the recording audio track clock running before, between, and
      // after spoken lines. Otherwise a recorder can rebase the first audio
      // packet to zero and omit pauses, moving speech ahead of the captions.
      this.silenceSource = this.context.createConstantSource();
      this.silenceSource.offset.value = 0;
      this.silenceSource.connect(this.audioDestination);
      this.silenceSource.start();
    }
    await this.context.resume();
    if (this.context.state !== "running") throw new Error("음성 재생이 차단됐어요. TTS 켜기를 다시 눌러 주세요.");
  }

  reset(server, dispose = false) {
    this.version++;
    this.disposed = dispose;
    this.cancelSpeech();
    this.stopRecording();
    this.driverToken = null;
    this.suspended = false;
    this.localPausePending = false;
    this.server = server;
    this.config = { enabled: false, configured: false, voiceId: DEFAULT_VOICE };
    const context = this.context;
    if (this.silenceSource) {
      try { this.silenceSource.stop(); } catch {}
      this.silenceSource.disconnect();
      this.silenceSource = null;
    }
    this.context = null;
    this.audioDestination = null;
    context?.close().catch(() => {});
    if (dispose && this.download) { this.env.URL.revokeObjectURL(this.download.url); this.download = null; }
    this.changed();
  }

  setConfig(config, token) {
    if (token) this.driverToken = token;
    const ownAudio = !!config.enabled && config.driverId === this.viewerId;
    if (this.recording && this.recording.withAudio !== ownAudio) {
      this.stopRecording();
      this.error = "TTS 설정이 변경되어 녹화를 저장했어요. 새 설정으로 다시 녹화할 수 있어요.";
    }
    this.config = config;
    if (!config.enabled || config.driverId !== this.viewerId) this.cancelSpeech();
    if (config.error) this.error = config.error;
    this.changed();
  }

  async request(path, body) {
    const response = await this.env.fetch(`${this.server}${path}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  async configure(body) {
    if (this.recording && body.enabled !== undefined && body.enabled !== this.config.enabled) {
      throw new Error("녹화를 종료한 뒤 TTS를 변경해 주세요. 녹화의 오디오 설정은 시작할 때 정해져요.");
    }
    const version = this.version;
    const data = await this.request("/tts", { ...body, viewerId: this.viewerId });
    if (version === this.version) { this.error = ""; this.setConfig(data.tts, data.driverToken); }
    return data;
  }

  retire(id) {
    this.retired.add(id);
    if (this.retired.size > 256) this.retired.delete(this.retired.values().next().value);
  }

  cancelSpeech(id) {
    const active = this.active;
    if (id) this.retire(id);
    if (!active || (id && active.id !== id)) return;
    this.active = null;
    this.retire(active.id);
    active.abort.abort();
    if (active.source) {
      active.source.onended = null;
      try { active.source.stop(); } catch {}
      active.source.disconnect();
    }
    this.onSpeech({ id: active.id, phase: "cancel" });
  }

  pauseSpeech() {
    this.suspended = true;
    this.localPausePending = true;
    this.cancelSpeech();
  }

  resumeSpeech() { this.suspended = false; this.localPausePending = false; }

  observePlayer(state) {
    if (["paused", "done", "empty"].includes(state)) {
      this.suspended = true;
      this.localPausePending = false;
      this.cancelSpeech();
    } else if (state === "playing" && !this.localPausePending) this.suspended = false;
  }

  async handleSpeech(event) {
    if (event.phase !== "ready") {
      this.cancelSpeech(event.id);
      this.onSpeech(event);
      if (event.phase === "error") this.report(event.error || "TTS 음성 재생 실패");
      return;
    }
    if (!this.config.enabled || event.driverId !== this.viewerId || !this.driverToken || this.suspended || this.retired.has(event.id) || this.active?.id === event.id) return;
    this.cancelSpeech();
    const active = { id: event.id, abort: new AbortController(), source: null };
    this.active = active;
    const server = this.server, token = this.driverToken;
    let ackChain = Promise.resolve();
    const ack = (phase) => {
      ackChain = ackChain.catch(() => {}).then(async () => {
        if (phase !== "error" && (active.abort.signal.aborted || this.server !== server)) return;
        const response = await this.env.fetch(`${server}/tts/ack`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ viewerId: this.viewerId, driverToken: token, id: event.id, phase }),
          signal: active.abort.signal,
        });
        if (!response.ok) throw new Error("음성 동기화 연결이 끊겼어요. 발표를 다시 재생해 주세요.");
        const data = await response.json();
        if (data.ok === false) throw new Error(data.error || "음성 동기화 실패");
        if (data.accepted === false && phase === "started") throw new Error("이미 취소된 음성이에요. 발표를 다시 재생해 주세요.");
      });
      return ackChain;
    };
    try {
      if (!this.context || this.context.state !== "running") throw new Error("TTS 켜기를 눌러 이 화면에서 음성 재생을 허용해 주세요.");
      if (!/^\/tts\/audio\/[\w-]+$/.test(event.audioUrl)) throw new Error("잘못된 음성 주소");
      const response = await this.env.fetch(`${server}${event.audioUrl}`, { signal: active.abort.signal });
      if (!response.ok) throw new Error("TTS 음성을 불러오지 못했어요.");
      const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
      if (this.active !== active || active.abort.signal.aborted) return;
      const source = this.context.createBufferSource();
      active.source = source;
      source.buffer = buffer;
      source.connect(this.context.destination);
      source.connect(this.audioDestination);
      source.onended = () => {
        if (this.active !== active) return;
        this.active = null;
        this.retire(event.id);
        source.disconnect();
        this.onSpeech({ id: event.id, phase: "ended" });
        ack("ended").catch(async (error) => {
          if (active.abort.signal.aborted) return;
          try { await ack("error"); } catch {}
          this.report(error);
        });
      };
      source.start();
      this.error = "";
      this.changed();
      await ack("started");
    } catch (error) {
      if (active.abort.signal.aborted || this.server !== server) return;
      // ACK errors must stop audio too; a playing but unacknowledged line cannot advance safely.
      try { await ack("error"); } catch {}
      this.cancelSpeech(event.id);
      this.report(error);
    }
  }

  startRecording() {
    if (this.recording) return;
    if (this.disposed) throw new Error("화면에 다시 연결한 뒤 녹화해 주세요.");
    const { MediaRecorder } = this.env;
    if (!MediaRecorder) throw new Error("이 브라우저는 화면 녹화를 지원하지 않아요.");
    if (!this.image.complete || !this.image.naturalWidth || !this.image.naturalHeight) throw new Error("화면이 표시된 뒤 녹화를 시작해 주세요.");
    const mime = recordingMime(MediaRecorder);
    if (!mime) throw new Error("이 브라우저에서 지원하는 녹화 형식이 없어요.");
    const canvas = this.env.document.createElement("canvas");
    canvas.width = 1280; canvas.height = 720;
    if (!canvas.captureStream) throw new Error("이 브라우저는 발표 영역 녹화를 지원하지 않아요.");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("녹화 화면을 만들지 못했어요.");
    drawPresentation(ctx, this.image, this.captions());
    let stream = canvas.captureStream(0);
    let videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack?.requestFrame) {
      stream.getTracks().forEach((track) => track.stop());
      stream = canvas.captureStream(30);
      videoTrack = stream.getVideoTracks()[0];
    }
    let recorder;
    try {
      if (this.config.enabled && this.config.driverId === this.viewerId) {
        if (!this.context || this.context.state !== "running") throw new Error("TTS 켜기를 눌러 음성 재생을 허용한 뒤 녹화해 주세요.");
        this.audioDestination.stream.getAudioTracks().forEach((track) => stream.addTrack(track.clone()));
      }
      recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
    } catch (error) { stream.getTracks().forEach((track) => track.stop()); throw error; }
    const recording = { recorder, stream, chunks: [], bytes: 0, started: this.env.performance.now(), withAudio: !!this.config.enabled && this.config.driverId === this.viewerId, frame: null, timer: null, stopping: false };
    recording.draw = () => {
      drawPresentation(ctx, this.image, this.captions());
      // Explicit frame requests prevent a static canvas from delaying caption
      // changes until the encoder's next sparse frame timestamp.
      videoTrack?.requestFrame?.();
    };
    this.recording = recording;
    recorder.ondataavailable = ({ data }) => {
      if (!data?.size) return;
      // A hard memory bound; finalize what fits instead of growing unbounded.
      if (recording.bytes + data.size > 256 * 1024 * 1024) { this.report("녹화 용량 한도(256MB)에 도달해 저장했어요."); this.stopRecording(); return; }
      recording.chunks.push(data); recording.bytes += data.size;
      // Leave room for the recorder's final chunk (including MP4 metadata).
      if (recording.bytes >= 240 * 1024 * 1024 && !recording.stopping) {
        this.report("녹화 용량 한도(256MB)에 가까워져 저장했어요."); this.stopRecording();
      }
    };
    recorder.onerror = () => { this.report("녹화 중 오류가 발생했어요."); this.stopRecording(); };
    recorder.onstop = async () => {
      this.cleanupRecording(recording);
      if (!this.disposed && recording.bytes) {
        const type = recorder.mimeType || mime;
        const extension = type.startsWith("video/mp4") ? "mp4" : "webm";
        let blob = new this.env.Blob(recording.chunks, { type });
        if (extension === "webm") {
          try { blob = await finalizeWebmDuration(blob, (recording.stoppedAt ?? this.env.performance.now()) - recording.started, this.env.Blob); }
          catch { /* Keep the original browser recording if its metadata cannot be patched. */ }
        }
        if (!this.disposed) {
          if (this.download) this.env.URL.revokeObjectURL(this.download.url);
          this.download = { url: this.env.URL.createObjectURL(blob), name: `agello-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`, bytes: blob.size };
        }
      }
      if (this.recording === recording) this.recording = null;
      recording.chunks.length = 0;
      this.changed();
    };
    let lastDraw = -Infinity;
    const draw = (time) => {
      if (recording.stopping || this.recording !== recording) return;
      try {
        if (time - lastDraw >= 1000 / 30) { recording.draw(); lastDraw = time; }
      } catch (error) { this.report(error); this.stopRecording(); return; }
      recording.frame = this.env.requestAnimationFrame(draw);
    };
    try { recorder.start(1000); } catch (error) { this.cleanupRecording(recording); this.recording = null; throw error; }
    recording.draw();
    recording.frame = this.env.requestAnimationFrame(draw);
    recording.timer = this.env.setInterval(() => {
      if (this.env.performance.now() - recording.started >= 15 * 60 * 1000) { this.report("15분 녹화 한도에 도달해 저장했어요."); this.stopRecording(); }
      this.changed();
    }, 1000);
    this.error = "";
    this.changed();
  }

  cleanupRecording(recording) {
    this.env.cancelAnimationFrame(recording.frame);
    this.env.clearInterval(recording.timer);
    recording.stream.getTracks().forEach((track) => track.stop());
  }

  flushRecordingFrame() {
    if (!this.recording || this.recording.stopping) return;
    try { this.recording.draw(); }
    catch (error) { this.report(error); this.stopRecording(); }
  }

  stopRecording() {
    const recording = this.recording;
    if (!recording || recording.stopping) return;
    recording.stopping = true;
    recording.stoppedAt = this.env.performance.now();
    this.env.cancelAnimationFrame(recording.frame);
    this.env.clearInterval(recording.timer);
    if (recording.recorder.state !== "inactive") recording.recorder.stop();
    else { this.cleanupRecording(recording); this.recording = null; }
    this.changed();
  }
}
