import { expect, test } from "bun:test";
import { createPlayer, lineHold, parseScript, PACE } from "../src/player";
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function harness() {
  const said: any[] = [];
  const speech: { at: string; signal: AbortSignal; start: (duration: number, id: string) => void; end: () => void; reject: (e: Error) => void }[] = [];
  const player = createPlayer({
    go: async () => {}, say: (...args) => said.push(args), changed: () => {}, done: () => {},
    narrate: (_text, at, signal, start) => new Promise<void>((end, reject) => speech.push({ at, signal, start, end, reject })),
  });
  player.load({ steps: [{ say: ["first", "second"] }, { say: ["third"] }] });
  return { player, said, speech };
}

test("text-only mode retains pacing and parse validation", () => {
  expect(lineHold("short")).toBe(10);
  expect(lineHold("x".repeat(500))).toBe(20);
  expect(lineHold("short", 25)).toBe(25);
  expect(typeof parseScript({ steps: [{ say: [""] }] })).toBe("string");
  const said: any[] = [];
  const player = createPlayer({ go: async () => {}, say: (...args) => said.push(args), changed: () => {}, done: () => {} });
  player.load({ steps: [{ say: ["hello"] }] });
  player.resume();
  expect(said[0]).toEqual(["hello", "1.1", 10]);
  expect(player.info()).toMatchObject({ state: "playing", next: undefined, last: "1.1" });
  player.stop();
});

test("caption appears only on actual start; current line advances only after ended", async () => {
  const { player, said, speech } = harness();
  player.resume();
  expect(said).toHaveLength(0);
  expect(player.info().next).toBe("1.1");
  speech[0].start(2.4, "n1");
  expect(said[0]).toEqual(["first", "1.1", 2.4, "n1"]);
  expect(player.info().next).toBe("1.1");
  speech[0].end();
  await flush();
  expect(player.info().next).toBe("1.2");
  expect(speech).toHaveLength(1);
  player.stop();
});

test("pause and hand raise cancel late callbacks and replay interrupted narration", async () => {
  const { player, said, speech } = harness();
  player.resume();
  speech[0].start(2, "old");
  player.pause();
  player.rewind();
  expect(speech[0].signal.aborted).toBe(true);
  speech[0].start(3, "late");
  speech[0].end();
  await flush();
  expect(said).toHaveLength(1);
  player.resume();
  expect(speech[1].at).toBe("1.1");
  speech[1].start(2, "retry");
  expect(said[1][3]).toBe("retry");
  player.stop();
});

test("goto, load and stop discard pending work", async () => {
  const { player, said, speech } = harness();
  player.resume();
  await player.goto({ step: 1, line: 0 });
  expect(speech[0].signal.aborted).toBe(true);
  speech[0].start(1, "old");
  speech[0].end();
  await flush();
  expect(speech[1].at).toBe("2.1");
  expect(said).toHaveLength(0);
  player.load({ steps: [{ say: ["new one"] }, { say: ["new two"] }] });
  expect(speech[1].signal.aborted).toBe(true);
  speech[1].start(1, "old2");
  speech[1].end();
  await flush();
  expect(speech).toHaveLength(3);
  speech[2].start(1, "new");
  expect(said[0][0]).toBe("new two");
  player.stop();
  expect(speech[2].signal.aborted).toBe(true);
});

test("narration failure pauses on current line and resume clears error", async () => {
  const { player, speech } = harness();
  player.resume();
  speech[0].reject(new Error("provider failure"));
  await flush();
  expect(player.info()).toMatchObject({ state: "paused", next: "1.1", error: "narration_failed" });
  player.resume();
  expect(player.info().error).toBeUndefined();
  expect(speech[1].at).toBe("1.1");
  player.stop();
});

test("ended narration waits the inter-line gap before next speech", async () => {
  const { player, speech } = harness();
  player.resume();
  speech[0].start(0.01, "first");
  speech[0].end();
  await new Promise((resolve) => setTimeout(resolve, PACE.fade + PACE.betweenLines + 30));
  expect(speech[1].at).toBe("1.2");
  player.stop();
});
