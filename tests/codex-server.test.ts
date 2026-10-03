import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFile, chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../src/server";

const ID = "01a0e1cb-fa7f-7b11-92b5-746796520982";
const OTHER = "01a0e1cb-fa7f-7b11-92b5-746796520983";
let dir: string;
let app: Awaited<ReturnType<typeof startServer>>;
let statePath: string;
let rollout: string;
const originalPath = process.env.PATH;
const originalHome = process.env.CODEX_HOME;
const controllers: AbortController[] = [];
const state = (status = "idle", session = ID, kind = "codex") => Bun.write(statePath, JSON.stringify({ status, session, kind }));
const ts = "2026-09-27T07:00:00.000Z";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "agello-codex-server-"));
  statePath = join(dir, "state.json");
  rollout = join(dir, "sessions", "2026", "09", "27", `rollout-2026-09-27T00-00-00-${ID}.jsonl`);
  await state();
  await Bun.write(rollout, JSON.stringify({ type: "response_item", timestamp: ts,
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "old history" }] } }) + "\n");
  const cli = join(dir, "herdr");
  await Bun.write(cli, `#!${process.execPath}
const args = process.argv.slice(2);
const state = await Bun.file(${JSON.stringify(statePath)}).json();
if (args[0] === 'agent' && args[1] === 'prompt') {
  if (state.status === 'blocked') { console.log(JSON.stringify({error:{code:'agent_blocked'}})); process.exit(0); }
  await Bun.write(${JSON.stringify(join(dir, "last-prompt.json"))}, JSON.stringify(args));
  console.log(JSON.stringify({result:{}}));
} else console.log(JSON.stringify({result: args[0] === 'agent'
  ? {agent:{agent:state.kind, agent_status:state.status, agent_session:{value:state.session}}}
  : {pane:{label:'mock Codex pane'}}}));
`);
  await chmod(cli, 0o755);
  process.env.PATH = `${dir}:${originalPath}`;
  process.env.CODEX_HOME = dir;
  app = await startServer({ pane: "test:codex", port: 0 });
});
afterAll(async () => {
  controllers.forEach((c) => c.abort());
  app?.stop();
  process.env.PATH = originalPath;
  if (originalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome;
  await rm(dir, { recursive: true, force: true });
});
async function events(url = app.url) {
  const controller = new AbortController();
  controllers.push(controller);
  const response = await fetch(url + "/events", { signal: controller.signal });
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
    } catch { /* stream abort */ }
  })();
  return output;
}
async function waitFor(fn: () => boolean) {
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    if (fn()) return;
    await Bun.sleep(10);
  }
  throw new Error("Expected Codex event not received");
}
const append = (...payloads: any[]) => appendFile(rollout, payloads.map((payload) => JSON.stringify({ type: "response_item", timestamp: ts, payload })).join("\n") + "\n");
const post = async (path: string, body: any) => fetch(app.url + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("Codex HTTP/SSE sends annotations and images, confirms input, streams tools and presentation replies", async () => {
  expect(await (await fetch(app.url + "/status")).json()).toMatchObject({ alive: true, agent: "codex", session: ID });
  const stream = await events();
  await waitFor(() => stream.some((e) => e.event === "hello"));
  expect(stream.find((e) => e.event === "hello")?.data).toMatchObject({ transcript: true, session: ID });
  await post("/present", {});
  const result = await post("/send", { action: "annotate", text: "fix button", target: { selector: "#save", label: "Save", rect: { x: 1, y: 2, w: 30, h: 10 } }, images: [{ type: "image/png", data: "iVBORw0KGgo=" }] });
  expect(await result.json()).toEqual({ ok: true });
  const args = await Bun.file(join(dir, "last-prompt.json")).json();
  expect(args.slice(0, 3)).toEqual(["agent", "prompt", "test:codex"]);
  expect(args[3]).toContain("[browser] action=annotate");
  expect(args[3]).toContain("#save");
  expect(args[3]).toContain("[image:");
  expect(args[3].split("\n").length).toBeLessThanOrEqual(3);
  await waitFor(() => stream.some((e) => e.event === "message" && e.data.queued));
  const queued = stream.find((e) => e.event === "message" && e.data.queued)!.data;
  await append(
    { type: "message", role: "user", content: [{ type: "input_text", text: args[3] }] },
    { type: "function_call", call_id: "tool-1", name: "exec_command", arguments: JSON.stringify({ cmd: "bun test" }) },
  );
  await waitFor(() => stream.some((e) => e.event === "tool_start"));
  const joined = await events();
  await waitFor(() => joined.some((e) => e.event === "tool_start"));
  expect(joined.find((e) => e.event === "hello")?.data.tools).toContain("tool-1");
  await append(
    { type: "function_call_output", call_id: "tool-1", output: "Process exited with code 0" },
    { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "checking button" }] },
    { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "button fixed" }] },
  );
  await waitFor(() => stream.some((e) => e.data.text === "button fixed"));
  expect(stream.some((e) => e.event === "delivered" && e.data.id === queued.id)).toBe(true);
  expect(stream.some((e) => e.event === "tool_end" && e.data.id === "tool-1")).toBe(true);
  expect(stream.filter((e) => e.event === "message" && e.data.role === "browser")).toHaveLength(1);
  expect(stream.some((e) => e.data.text === "old history")).toBe(false);
  expect(stream.some((e) => e.event === "present" && e.data.on)).toBe(true);
  const image = args[3].match(/\[image: ([^\]]+)\]/)?.[1];
  if (image) await rm(image, { force: true });
});

test("Codex blocks dialog input and rejects replaced sessions and unsupported agents", async () => {
  await state("blocked");
  const blocked = await post("/send", { text: "should not type" });
  expect(blocked.status).toBe(409);
  expect(await blocked.json()).toEqual({ ok: false, error: "agent_blocked" });
  await state("idle", OTHER);
  const changed = await post("/send", { text: "wrong session" });
  expect(changed.status).toBe(409);
  expect(await changed.json()).toEqual({ ok: false, error: "session_changed" });
  await state("idle", ID, "gemini");
  const unsupported = await post("/send", { text: "unsupported" });
  expect(await unsupported.json()).toEqual({ ok: false, error: "unsupported_agent" });
  await state();
});

test("a rollout created after startup is discovered, with complete-line UTF-8 streaming", async () => {
  await rm(rollout);
  const delayed = await startServer({ pane: "test:codex", port: 0, session: ID });
  try {
    const stream = await events(delayed.url);
    await waitFor(() => stream.some((e) => e.event === "hello"));
    expect(stream.find((e) => e.event === "hello")?.data.transcript).toBe(false);
    const line = JSON.stringify({ type: "response_item", timestamp: ts, payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "늦게 생성된 답변" }] } });
    await Bun.write(rollout, line); // no newline yet
    await waitFor(() => stream.some((e) => e.event === "hello" && e.data.transcript));
    expect(stream.some((e) => e.event === "message")).toBe(false);
    await appendFile(rollout, "\n");
    await waitFor(() => stream.some((e) => e.data.text === "늦게 생성된 답변"));
    expect(delayed.transcript).toBe(rollout);
  } finally { delayed.stop(); }
});
