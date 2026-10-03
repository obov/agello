import { expect, test } from "bun:test";
import { createTranscript } from "../src/transcript";

const ts = "2026-09-27T07:00:00.000Z";
function setup(kind: "claude" | "codex" = "codex") {
  const events: { event: string; data: any }[] = [];
  const parser = createTranscript(kind, (event, data) => events.push({ event, data }));
  const record = (payload: any, type = "response_item") => parser.handleEntry({ type, timestamp: ts, payload });
  return { ...parser, events, record };
}

test("Codex maps both rollout generations without duplicate bubbles or injected context", () => {
  const p = setup();
  p.record({ type: "message", role: "developer", content: [{ type: "input_text", text: "private instructions" }] });
  p.record({ type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>private</environment_context>" }] });
  p.record({ type: "reasoning", summary: [{ text: "private thinking" }] });
  p.record({ type: "item_completed", item: { type: "Reasoning", raw_content: ["private thinking"] } }, "event_msg");
  const prompt = "[browser] action=annotate fix this\n대상: #button";
  p.record({ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] });
  p.record({ type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: prompt }] } }, "event_msg");
  p.record({ type: "item_completed", item: { type: "AgentMessage", content: [{ type: "Text", text: "checking" }], phase: "commentary" } }, "event_msg");
  p.record({ type: "message", role: "assistant", content: [{ type: "output_text", text: "checking" }], phase: "commentary" });
  p.record({ type: "agent_message", message: "fixed" }, "event_msg");
  p.record({ type: "message", role: "assistant", content: [{ type: "output_text", text: "fixed" }] });
  expect(p.events.map((e) => e.data)).toEqual([
    { role: "browser", action: "annotate", text: "fix this\n대상: #button", ts },
    { role: "assistant", text: "checking", ts, phase: "commentary" },
    { role: "assistant", text: "fixed", ts },
  ]);
  // Repeated prompts are real messages, even with identical timestamps.
  p.record({ type: "message", role: "user", content: [{ type: "input_text", text: "again" }] });
  p.record({ type: "message", role: "user", content: [{ type: "input_text", text: "again" }] });
  expect(p.events.filter((e) => e.data.text === "again")).toHaveLength(2);
});

test("Codex tool calls, custom tools, nested execution failures and interrupted cleanup", () => {
  const p = setup();
  p.record({ type: "function_call", call_id: "call-1", name: "exec_command", arguments: JSON.stringify({ cmd: "bun test", command: "bun test" }) });
  expect(p.pendingTools.size).toBe(1);
  p.record({ type: "function_call_output", call_id: "call-1", output: "Process exited with code 1" });
  expect(p.events.at(-1)).toEqual({ event: "tool_end", data: { id: "call-1", isError: true } });
  p.record({ type: "custom_tool_call", call_id: "call-2", name: "apply_patch", input: "*** Begin Patch" });
  p.record({ type: "custom_tool_call_output", call_id: "call-2", output: [{ type: "input_text", text: "Success" }] });
  p.record({ type: "item_started", item: { type: "CommandExecution", id: "nested", command: "false" } }, "event_msg");
  p.record({ type: "item_completed", item: { type: "CommandExecution", id: "nested", command: "false", exit_code: 1 } }, "event_msg");
  expect(p.events.filter((e) => e.event === "tool_start" && e.data.id === "nested")).toHaveLength(1);
  expect(p.events.at(-1)?.data.isError).toBe(true);
  p.record({ type: "custom_tool_call", call_id: "interrupted", name: "exec", input: "work()" });
  p.record({ type: "turn_aborted" }, "event_msg");
  expect(p.pendingTools.size).toBe(0);
  expect(p.events.filter((e) => e.event === "message")).toHaveLength(0);
});

test("Codex pending browser prompt is delivered on echo, and failed sends are withdrawn", () => {
  const p = setup();
  const prompt = "[browser] action=message hello";
  const id = p.pendingPrompt(prompt);
  expect(p.events[0].data).toMatchObject({ id, queued: true, role: "browser", text: "hello" });
  p.record({ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] });
  p.record({ type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: prompt }] } }, "event_msg");
  expect(p.events).toHaveLength(2);
  expect(p.events[1]).toEqual({ event: "delivered", data: { id } });
  expect(p.queue).toHaveLength(0);
  const failed = p.pendingPrompt("failed");
  p.cancelPrompt(failed);
  expect(p.events.at(-1)).toEqual({ event: "unqueued", data: { id: failed } });
});

test("Codex native queue supports edits, withdrawal and delayed delivery without duplicate prompts", () => {
  const p = setup();
  const q = { id: "cq-native", text: "from terminal", ts };
  p.syncQueue([q], 0);
  p.syncQueue([q], 50);
  expect(p.events.filter((e) => e.event === "message")).toHaveLength(1);
  p.syncQueue([{ ...q, text: "edited" }], 100);
  expect(p.events.filter((e) => e.event === "unqueued").at(-1)?.data.id).toBe(q.id);
  expect(p.events.filter((e) => e.event === "message").at(-1)?.data.text).toBe("edited");
  p.syncQueue([], 200);
  p.record({ type: "user_message", message: "edited" }, "event_msg");
  expect(p.events.at(-1)).toEqual({ event: "delivered", data: { id: q.id } });
  p.syncQueue([{ ...q, text: "edited" }], 250); // stale snapshot must not re-enqueue
  expect(p.queue).toHaveLength(0);
  p.syncQueue([], 300);
  const removed = { id: "cq-removed", text: "withdrawn", ts };
  p.syncQueue([removed], 400);
  p.syncQueue([], 500);
  p.syncQueue([], 2001);
  expect(p.events.some((e) => e.event === "unqueued" && e.data.id === removed.id)).toBe(true);
});

test("Codex mirrors repeated identical messages exactly once per occurrence", () => {
  const p = setup();
  for (let i = 0; i < 2; i++) p.record({ type: "agent_message", message: "same" }, "event_msg");
  for (let i = 0; i < 2; i++) p.record({ type: "message", role: "assistant", content: [{ type: "output_text", text: "same" }] });
  expect(p.events.filter((e) => e.data.text === "same")).toHaveLength(2);
  p.record({ type: "message", role: "user", content: [{ type: "input_text", text: "<div>fix this HTML</div>" }] });
  expect(p.events.at(-1)?.data.text).toBe("<div>fix this HTML</div>");
});

test("Codex queue reorder follows the native order", () => {
  const p = setup();
  const a = { id: "cq-a", text: "a", ts }, b = { id: "cq-b", text: "b", ts };
  p.syncQueue([a, b]);
  p.syncQueue([b, a]);
  expect(p.queue.map((q) => q.id)).toEqual([b.id, a.id]);
  expect(p.events.at(-1)).toEqual({ event: "queue_order", data: { ids: [b.id, a.id] } });
});

test("Claude still handles typed/pasted prompts, FIFO, mid-turn delivery, tools and narration", () => {
  const p = setup("claude");
  const entry = (data: any) => p.handleEntry({ timestamp: ts, ...data });
  const prompt = "[browser] action=message hello";
  entry({ type: "queue-operation", operation: "enqueue", content: prompt });
  entry({ type: "queue-operation", operation: "dequeue" });
  entry({ type: "user", promptSource: "queued", message: { content: prompt } });
  expect(p.events.map((e) => e.event)).toEqual(["message", "delivered"]);
  entry({ type: "queue-operation", operation: "enqueue", content: "later" });
  entry({ type: "attachment", attachment: { type: "queued_command", prompt: "later" } });
  expect(p.queue).toHaveLength(0);
  entry({ type: "user", promptSource: "typed", message: { content: '<pasted_content id="1">\nhello\n</pasted_content id="1">' } });
  expect(p.events.at(-1)?.data.text).toBe("hello");
  entry({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "hidden" }] } });
  entry({ type: "assistant", message: { content: [
    { type: "thinking", thinking: "hidden", signature: "" },
    { type: "thinking", thinking: "spoken", signature: Buffer.from("narration").toString("base64") },
    { type: "tool_use", id: "tool", name: "Read", input: { file_path: "/tmp/file" } },
  ] } });
  expect(p.pendingTools.size).toBe(1);
  entry({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool", is_error: true }] } });
  expect(p.pendingTools.size).toBe(0);
  expect(p.events.some((e) => e.data.text === "hidden")).toBe(false);
  expect(p.events.some((e) => e.data.text === "spoken" && e.data.narration)).toBe(true);
});
