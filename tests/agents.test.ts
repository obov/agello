import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { createCodexLocator, findTranscript } from "../src/agents";
import { readCodexQueue } from "../src/codex-queue";

const ID = "01a0e1cb-fa7f-7b11-92b5-746796520982";
const OTHER = "01a0e1cb-fa7f-7b11-92b5-746796520983";
const path = `/tmp/codex/sessions/2026/09/27/rollout-2026-09-27T16-37-16-${ID}.jsonl`;

test("Codex locator uses the exact pane process and excludes shared daemons", async () => {
  const calls: string[][] = [];
  let session = ID;
  const exec = async (args: string[]) => {
    calls.push(args);
    if (args[1] === "-axo") return "10 ?? /bin/codex\n11 ttys1 /bin/codex\n12 ttys2 /bin/codex\n13 ttys1 /bin/codex-code-mode-host";
    if (args[0] === "ps") return `codex HERDR_PANE_ID=${args[3] === "11" ? "w1:p1" : "w2:p1"} CODEX_HOME=/tmp/codex`;
    return `p11\nn${path.replace(ID, session)}\nn/tmp/codex/thread-writer-locks/${session}.lock`;
  };
  const locator = createCodexLocator("w1:p1", exec);
  expect(await locator.locate()).toEqual({ session: ID, transcript: path, home: "/tmp/codex", pid: 11 });
  expect(calls.some((a) => a[3] === "10")).toBe(false);
  session = OTHER;
  expect((await locator.locate())?.session).toBe(OTHER);
});

test("Codex locator refuses ambiguous process/rollout matches and does not guess from cwd", async () => {
  const exec = async (args: string[]) => args[1] === "-axo" ? "11 ttys1 /bin/codex\n12 ttys2 /bin/codex" : "codex HERDR_PANE_ID=w1:p1";
  expect(await createCodexLocator("w1:p1", exec).locate()).toBeNull();
  const multi = async (args: string[]) => args[1] === "-axo" ? "11 ttys1 /bin/codex" : args[0] === "ps" ? "codex HERDR_PANE_ID=w1:p1" : `n${path}\nn${path.replace(ID, OTHER)}`;
  expect(await createCodexLocator("w1:p1", multi).locate()).toBeNull();
});

test("transcript lookup respects Codex home, missing directories and safe session IDs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agello-agent-"));
  try {
    expect(await findTranscript("codex", ID, dir)).toBeNull();
    const file = join(dir, "sessions", "2026", "09", "27", `rollout-2026-09-27T00-00-00-${ID}.jsonl`);
    await Bun.write(file, "{}\n");
    expect(await findTranscript("codex", ID, dir)).toBe(file);
    expect(await findTranscript("codex", "../*", dir)).toBeNull();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("native queue reader isolates threads, orders prompts, and never creates or modifies a database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agello-queue-"));
  try {
    expect(readCodexQueue(dir, ID)).toBeNull();
    const dbPath = join(dir, "queue_1.sqlite");
    expect(await Bun.file(dbPath).exists()).toBe(false);
    const db = new Database(dbPath, { create: true });
    db.run("CREATE TABLE queued_items (id TEXT, thread_id TEXT, payload_json TEXT, queue_order INTEGER, created_at_ms INTEGER)");
    const insert = db.query("INSERT INTO queued_items VALUES (?,?,?,?,?)");
    // Exact native serializer shape captured from an isolated 0.157.1 queue.
    const payload = (text: string) => JSON.stringify({ UserInput: { content: [{ type: "text", text, text_elements: [] }], client_id: "fixture-client" } });
    insert.run("second", ID, payload("two"), 2, 1000);
    insert.run("first", ID, payload("one"), 1, 1000);
    insert.run("other", OTHER, payload("secret from another pane"), 0, 1000);
    insert.run("invalid", ID, "not json", 3, 1000);
    db.close();
    const before = await Bun.file(dbPath).bytes();
    expect(readCodexQueue(dir, ID)?.map((q) => q.text)).toEqual(["one", "two"]);
    expect(await Bun.file(dbPath).bytes()).toEqual(before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
