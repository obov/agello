// Page audio relay, page side. Injected into the relayed terminal-browser tab
// through CDP while at least one viewer listens (GET /screen/audio).
//
// CDP has no audio stream and terminal-browser (Electron) denies tab capture,
// so the page's own audio graph is rerouted:
//   - AudioNode.connect(ctx.destination) goes to a per-context tap instead
//   - <audio>/<video> playing while remote are moved into a WebAudio graph
//     (createMediaElementSource), which also takes them off the speakers
//   tap -> out (gain 1 local, 0 remote) -> real destination
//   tap -> ScriptProcessor -> 16-bit stereo PCM -> binding -> agello server
//
// Remote mode lasts while the server keeps calling ping() (every ~1.5s); after
// 4s without a ping (server gone, tab no longer relayed) local playback returns.
//
// Not captured: connections made before injection (reload the page),
// cross-origin media without CORS (routing them would play silence, so they
// keep playing locally), cross-site iframes (separate CDP targets).

export const AUDIO_BINDING = "__agelloAudioPcm";

export const PAGE_AUDIO_JS = `(() => {
  if (window.__agelloAudio) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC || !window.AudioNode) return;
  const BINDING = ${JSON.stringify(AUDIO_BINDING)};
  const QUIET_CHUNKS = 24; // ~2s of silence before chunks stop being sent
  const origConnect = AudioNode.prototype.connect;
  const origDisconnect = AudioNode.prototype.disconnect;
  const origCreateSource = AC.prototype.createMediaElementSource;
  const origPlay = HTMLMediaElement.prototype.play;
  const taps = new WeakMap(); // context -> tap record
  const records = new Set();
  const owned = new WeakSet(); // media elements moved into our graph
  let remote = false, lastPing = 0, nextId = 1, mediaCtx = null;

  function send(t, buf) {
    const n = buf.length;
    const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    const pcm = new Int16Array(n * 2);
    let loud = false;
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      if (l || r) loud = true;
      pcm[2 * i] = (l < -1 ? -1 : l > 1 ? 1 : l) * 32767;
      pcm[2 * i + 1] = (r < -1 ? -1 : r > 1 ? 1 : r) * 32767;
    }
    t.quiet = loud ? 0 : t.quiet + 1;
    if (t.quiet > QUIET_CHUNKS) return;
    const bytes = new Uint8Array(pcm.buffer);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    try { window[BINDING](JSON.stringify({ c: t.id, r: t.ctx.sampleRate, d: btoa(s) })); } catch {}
  }

  function tapOf(ctx) {
    let t = taps.get(ctx);
    if (t) return t;
    const tap = ctx.createGain(), out = ctx.createGain();
    out.gain.value = remote ? 0 : 1;
    origConnect.call(tap, out);
    origConnect.call(out, ctx.destination);
    t = { id: nextId++, ctx, tap, out, quiet: QUIET_CHUNKS + 1 };
    if (ctx.createScriptProcessor) {
      const proc = ctx.createScriptProcessor(4096, 2, 2), sink = ctx.createGain();
      sink.gain.value = 0;
      origConnect.call(tap, proc);
      origConnect.call(proc, sink);
      origConnect.call(sink, ctx.destination);
      proc.onaudioprocess = (e) => { if (remote) send(t, e.inputBuffer); };
      t.proc = proc;
    }
    taps.set(ctx, t);
    records.add(t);
    return t;
  }

  AudioNode.prototype.connect = function (dest, output) {
    const ctx = this.context;
    if (dest && ctx instanceof AC && dest === ctx.destination) {
      origConnect.call(this, tapOf(ctx).tap, output || 0);
      return dest;
    }
    return origConnect.apply(this, arguments);
  };
  AudioNode.prototype.disconnect = function (dest) {
    const ctx = this.context, t = ctx && taps.get(ctx);
    if (t && dest && dest === ctx.destination) {
      const args = [...arguments];
      args[0] = t.tap;
      if (args.length > 2) args.length = 2; // the tap has one input
      return origDisconnect.apply(this, args);
    }
    return origDisconnect.apply(this, arguments);
  };

  function capturable(el) {
    if (el.srcObject) return true;
    const src = el.currentSrc || el.src;
    if (!src) return false;
    if (el.crossOrigin != null) return true;
    try {
      const u = new URL(src, location.href);
      return u.protocol === "data:" || u.origin === location.origin;
    } catch { return false; }
  }
  function own(el) {
    if (!remote || !(el instanceof HTMLMediaElement) || owned.has(el) || !capturable(el)) return;
    try {
      mediaCtx = mediaCtx || new AC();
      const src = origCreateSource.call(mediaCtx, el);
      owned.add(el);
      origConnect.call(src, tapOf(mediaCtx).tap);
      if (mediaCtx.state !== "running") mediaCtx.resume().catch(() => {});
    } catch {}
  }
  HTMLMediaElement.prototype.play = function () {
    own(this);
    return origPlay.apply(this, arguments);
  };
  for (const type of ["play", "playing"]) document.addEventListener(type, (e) => own(e.target), true);

  function setRemote(on) {
    if (on) lastPing = Date.now();
    if (remote === on) return;
    remote = on;
    for (const t of records) {
      t.out.gain.value = on ? 0 : 1;
      t.quiet = QUIET_CHUNKS + 1;
    }
    if (on) {
      document.querySelectorAll("audio,video").forEach((el) => { if (!el.paused) own(el); });
      if (mediaCtx && mediaCtx.state !== "running") mediaCtx.resume().catch(() => {});
    }
  }
  setInterval(() => { if (remote && Date.now() - lastPing > 4000) setRemote(false); }, 1000);

  window.__agelloAudio = {
    ping: () => setRemote(true),
    off: () => setRemote(false),
    state: () => ({ remote, contexts: records.size, media: !!mediaCtx }),
  };
})()`;

// Viewer-bound chunk, validated (the binding is callable by the page itself).
export type PcmChunk = { c: number; r: number; d: string };
export function parsePcm(payload: string): PcmChunk | null {
  if (payload.length > 512 * 1024) return null;
  let m: any;
  try {
    m = JSON.parse(payload);
  } catch {
    return null;
  }
  const { c, r, d } = m ?? {};
  if (!Number.isInteger(c) || c < 1 || c > 1e6) return null;
  if (!Number.isFinite(r) || r < 8000 || r > 192000) return null;
  if (typeof d !== "string" || !d || d.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(d)) return null;
  return { c, r, d };
}
