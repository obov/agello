// Presentation script player.
//
// A script is a list of steps. Each step has an optional `go` (how to bring the
// screen to that step: "#3" sets location.hash, anything else is evaluated as
// JS in the page; written by the agent, agello knows nothing about the deck)
// and lines (`say`), each shown as one bubble.
//
// The player owns order and timing: entering a step runs its `go`, then every
// line is sent and held for its reading time (see PACE). pause() stops at once and keeps
// the position, resume() re-runs the current step's `go` (the agent may have
// moved the screen meanwhile) and continues from the next unshown line.
// rewind() (after a raised hand) moves back so the last shown line plays again.
// goto() moves the position and shows that step without playing.
//
// Positions are "step.line", 1-based, in everything that leaves this module.

import type { Rect } from "./screencast.ts";

export type Step = { go?: string; say: string[]; hold?: number };
export type Script = { rect?: Rect; steps: Step[] };
export type PlayerInfo = {
  state: "empty" | "ready" | "playing" | "paused" | "done";
  next?: string; // next line to show ("3.2")
  last?: string; // last line shown
  steps: number;
  error?: string;
};

// Pacing: the audience looks at a new screen first, then reads and thinks.
//   go -> 1s -> line (shown >= 10s) -> fades out -> 0.3s -> next line
//                                     last line -> fades out -> 0.7s -> next step's go
const MIN_HOLD = 10;
const MAX_HOLD = 20;
export const PACE = { afterGo: 1000, fade: 500, betweenLines: 300, afterStep: 700 };

// How long one line stays on screen (s): at least 10s, longer text a bit more
// (about 8 chars/s past the first ~50 chars), at most 20s. `hold` can only
// lengthen it.
export function lineHold(text: string, hold?: number): number {
  const auto = Math.min(MAX_HOLD, Math.max(MIN_HOLD, 4 + [...text].length / 8));
  return hold != null && Number.isFinite(hold) && hold > 0 ? Math.max(MIN_HOLD, hold) : auto;
}

export function parseRectString(v: unknown): Rect | undefined {
  if (v && typeof v === "object") {
    const r = v as any;
    return { x: r.x, y: r.y, w: r.w, h: r.h };
  }
  if (typeof v !== "string") return undefined;
  const n = v.split(/[\s,]+/).filter(Boolean).map(Number);
  return n.length === 4 ? { x: n[0], y: n[1], w: n[2], h: n[3] } : undefined;
}

// Validate a script from JSON. Returns the script or an error message.
export function parseScript(raw: any): Script | string {
  if (!raw || typeof raw !== "object") return "script must be an object";
  if (!Array.isArray(raw.steps) || !raw.steps.length) return "steps must be a non-empty array";
  const steps: Step[] = [];
  for (const [i, s] of raw.steps.entries()) {
    const at = `steps[${i}]`;
    if (!s || typeof s !== "object") return `${at} must be an object`;
    if (s.go != null && typeof s.go !== "string") return `${at}.go must be a string`;
    const say = s.say == null ? [] : Array.isArray(s.say) ? s.say : [s.say];
    if (!say.every((l: unknown) => typeof l === "string" && l.trim())) return `${at}.say must be non-empty strings`;
    if (s.hold != null && !(Number.isFinite(s.hold) && s.hold > 0)) return `${at}.hold must be a positive number`;
    steps.push({ go: s.go || undefined, say: say.map((l: string) => l.trim()), hold: s.hold });
  }
  const rect = raw.rect == null ? undefined : parseRectString(raw.rect);
  if (raw.rect != null && !rect) return "rect must be \"x,y,w,h\" or {x,y,w,h}";
  return { rect, steps };
}

// "3" or "3.2" (1-based) -> 0-based position
export function parsePos(v: string): { step: number; line: number } | null {
  const m = String(v).trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const step = Number(m[1]) - 1;
  const line = m[2] ? Number(m[2]) - 1 : 0;
  return step >= 0 && line >= 0 ? { step, line } : null;
}

export function createPlayer(deps: {
  go: (expr: string) => Promise<void>;
  say: (text: string, at: string, hold: number, narration?: string) => void;
  // null selects text pacing; a promise resolves only after actual playback ends.
  narrate?: (text: string, at: string, signal: AbortSignal,
    started: (duration: number, id: string) => void) => Promise<void> | null;
  done: () => void;
  changed: () => void;
}) {
  let script: Script | null = null;
  let state: PlayerInfo["state"] = "empty";
  let cur = { step: 0, line: 0 }; // next line to show
  let last: { step: number; line: number } | null = null;
  let entered = false; // `go` of cur.step already run in this play run
  let run = 0; // bumps on every pause/goto/load, stale timers check it
  let timer: Timer | null = null;
  let speech: AbortController | null = null;
  let error: string | undefined;

  const fmt = (p: { step: number; line: number }) => `${p.step + 1}.${p.line + 1}`;
  const set = (s: PlayerInfo["state"]) => {
    state = s;
    deps.changed();
  };
  const cancel = () => {
    run++;
    if (timer) clearTimeout(timer);
    timer = null;
    speech?.abort();
    speech = null;
  };
  const wait = (ms: number, id: number, fn: () => void) => {
    timer = setTimeout(() => id === run && fn(), ms);
  };

  function info(): PlayerInfo {
    const steps = script?.steps.length ?? 0;
    // next line as it will be played (a finished step points at the next step)
    let p = cur;
    while (script && p.step < steps && p.line >= Math.max(1, script.steps[p.step].say.length))
      p = { step: p.step + 1, line: 0 };
    return {
      state,
      steps,
      next: script && p.step < steps ? fmt(p) : undefined,
      last: last ? fmt(last) : undefined,
      ...(error ? { error } : {}),
    };
  }

  // Skip past finished steps (cur.line beyond the step's lines).
  function normalize() {
    if (!script) return;
    while (cur.step < script.steps.length && cur.line >= Math.max(1, script.steps[cur.step].say.length)) {
      cur = { step: cur.step + 1, line: 0 };
      entered = false;
    }
  }

  async function tick(id: number) {
    if (id !== run || state !== "playing" || !script) return;
    normalize();
    if (cur.step >= script.steps.length) {
      set("done");
      deps.done();
      return;
    }
    const step = script.steps[cur.step];
    if (!entered) {
      entered = true;
      if (step.go) {
        await deps.go(step.go);
        if (id !== run) return;
        wait(PACE.afterGo, id, () => tick(id));
        return;
      }
    }
    if (!step.say.length) {
      // silent step: just show the screen for `hold` seconds
      cur = { step: cur.step, line: 1 };
      deps.changed();
      wait(lineHold("", step.hold) * 1000 + PACE.afterStep, id, () => tick(id));
      return;
    }
    const text = step.say[cur.line];
    const position = { ...cur };
    const lastLine = cur.line === step.say.length - 1;
    const gap = lastLine ? PACE.afterStep : PACE.betweenLines;
    speech = new AbortController();
    const narration = deps.narrate?.(text, fmt(cur), speech.signal, (duration, narrationId) => {
      if (id !== run || state !== "playing") return;
      last = position;
      deps.say(text, fmt(position), duration, narrationId);
      deps.changed();
    });
    if (narration) {
      try {
        await narration;
        if (id !== run || state !== "playing") return;
        speech = null;
        cur = { step: position.step, line: position.line + 1 };
        deps.changed();
        wait(PACE.fade + gap, id, () => tick(id));
      } catch {
        if (id !== run) return;
        cancel();
        error = "narration_failed";
        set("paused");
      }
      return;
    }
    speech = null;
    const hold = lineHold(text, step.hold);
    last = { ...cur };
    deps.say(text, fmt(cur), hold);
    cur = { step: cur.step, line: cur.line + 1 };
    deps.changed();
    wait(hold * 1000 + PACE.fade + gap, id, () => tick(id));
  }

  return {
    info,
    script: () => script,

    // Replace the script, keeping the position (clamped) and the state.
    load(next: Script) {
      const playing = state === "playing";
      cancel();
      error = undefined;
      script = next;
      if (cur.step > next.steps.length) cur = { step: next.steps.length, line: 0 };
      normalize();
      if (state === "empty") state = "ready";
      if (state === "done" && cur.step < next.steps.length) state = "paused";
      if (playing) {
        entered = true; // screen is already on this step
        tick(run);
      }
      deps.changed();
    },

    resume(): string | null {
      if (!script) return "no_script";
      if (state === "playing") return null;
      if (state === "done") return "done";
      cancel();
      error = undefined;
      entered = false; // bring the screen back to the current step first
      set("playing");
      tick(run);
      return null;
    },

    pause() {
      if (state !== "playing") return;
      cancel();
      set("paused");
    },

    // Paused by an interruption (raised hand): the next resume replays the
    // last shown line, since the viewer may have missed it.
    rewind() {
      if (state !== "paused" || !last) return;
      cur = { ...last };
      entered = false;
      deps.changed();
    },

    // Move to a step (and line) and show its screen. Does not play; if it was
    // playing, it keeps playing from there.
    async goto(pos: { step: number; line: number }): Promise<string | null> {
      if (!script) return "no_script";
      const step = script.steps[pos.step];
      if (!step) return "no_such_step";
      if (pos.line > 0 && pos.line >= step.say.length) return "no_such_line";
      const playing = state === "playing";
      cancel();
      error = undefined;
      cur = { ...pos };
      entered = false;
      if (playing) {
        tick(run);
        return null;
      }
      if (state !== "ready") state = "paused";
      if (step.go) await deps.go(step.go);
      entered = true;
      deps.changed();
      return null;
    },

    // Presentation ended: stop where it is.
    stop() {
      cancel();
      if (state === "playing") {
        set("paused");
      }
    },
  };
}
