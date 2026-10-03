// Normalize agent rollout records to agello's existing SSE contract.
import type { AgentKind } from "./agents.ts";
export const BROWSER_PREFIX = "[browser]";
export type Emit = (event: string, data: any) => void;

// Claude Code wraps multi-line pasted input (4+ lines) in pasted_content tags.
// Strip them for display.
const PASTE_TAG = /<\/?pasted_content id="[^"]*">\n?/g;
const unwrapPaste = (s: string) => s.replace(PASTE_TAG, "").trim();

function toolSummary(input: any): string {
  const s =
    input?.description ??
    input?.file_path ??
    input?.pattern ??
    input?.query ??
    input?.url ??
    input?.skill ??
    input?.prompt ??
    input?.command ??
    input?.cmd ??
    input?.path ??
    "";
  const text = String(s).replace(/\s+/g, " ").trim();
  return text.length > 80 ? text.slice(0, 80) + "…" : text;
}

// Some models emit user-facing narration as a `thinking` block whose signature
// carries a "narration" marker. Claude Code renders these like normal replies,
// so treat them as assistant text. Plain (unmarked) thinking stays hidden.
// The marker is an undocumented detail of the signature; if it changes, these
// blocks are simply not shown (same as before).
export function isNarration(b: any): boolean {
  if (b?.type !== "thinking" || typeof b.thinking !== "string" || !b.thinking.trim()) return false;
  try {
    return Buffer.from(String(b.signature ?? "").slice(0, 200), "base64").includes("narration");
  } catch {
    return false;
  }
}

export function createTranscript(kind: AgentKind, broadcast: Emit) {
  // Pending tools, so a page that connects mid-tool still shows the loader.
  const pendingTools = new Map<string, { id: string; name: string; summary: string; ts?: string }>();

  // Build a chat message from a user prompt string ([browser] prefix -> browser bubble).
  function userMessage(raw: string, ts: string, extra: object = {}) {
    const text = unwrapPaste(raw);
    if (text.startsWith(BROWSER_PREFIX)) {
      const [head, ...rest] = text.split("\n");
      const m = head.match(/action=(\S+) ?(.*)$/);
      const body = [m?.[2] ?? "", ...rest].filter(Boolean).join("\n");
      return { role: "browser", action: m?.[1] ?? "message", text: body, ts, ...extra };
    }
    return { role: "terminal", text, ts, ...extra };
  }

  // Prompts typed while the agent is busy are queued by Claude Code:
  //   queue-operation enqueue {content}          -> show as a "queued" bubble
  //   queue-operation remove  {content, reason}  -> delivered mid-turn (absorbed_mid_turn)
  //   attachment queued_command {prompt}         -> delivered mid-turn (same message)
  //   queue-operation dequeue                    -> delivered at turn end (FIFO, no content);
  //                                                 followed by a user entry (promptSource "queued")
  //   queue-operation popAll                     -> queue pulled back into the input box
  // System prompts (task notifications, "<tag>..." content) share the queue but are not shown.
  type Queued = { id: string; text: string; human: boolean };
  const queue: Queued[] = [];
  const suppress: string[] = []; // delivered queue texts whose follow-up user entry must not duplicate
  const isHumanPrompt = (t: string) => !/^\s*<[a-z][\w-]*>/i.test(t);
  const consumed = new Set<string>();

  function deliver(q: Queued) {
    if (q.id.startsWith("cq-")) consumed.add(q.id);
    if (q.human) broadcast("delivered", { id: q.id });
  }

  function handleQueue(d: any) {
    const op = d.operation;
    if (op === "enqueue" && typeof d.content === "string") {
      const q = { id: `q-${d.timestamp}-${queue.length}`, text: d.content, human: isHumanPrompt(d.content) };
      queue.push(q);
      if (q.human) broadcast("message", userMessage(d.content, d.timestamp, { id: q.id, queued: true }));
    } else if (op === "remove" && typeof d.content === "string") {
      const i = queue.findIndex((q) => q.text === d.content);
      if (i >= 0) deliver(queue.splice(i, 1)[0]);
    } else if (op === "dequeue") {
      const q = queue.shift();
      if (q) {
        deliver(q);
        suppress.push(q.text);
      }
    } else if (op === "popAll") {
      for (const q of queue.splice(0)) if (q.human) broadcast("unqueued", { id: q.id });
    }
  }

  function handleClaude(d: any) {
    if (d.isSidechain) return;
    const content = d.message?.content;

    if (d.type === "queue-operation") return handleQueue(d);

    if (d.type === "attachment" && d.attachment?.type === "queued_command") {
      const i = queue.findIndex((q) => q.text === d.attachment.prompt);
      if (i >= 0) deliver(queue.splice(i, 1)[0]);
      return;
    }

    if (d.type === "user") {
      const src = d.promptSource;
      if (typeof content === "string" && (src === "typed" || src === "queued") && !d.isMeta) {
        const s = suppress.indexOf(content);
        if (s >= 0) {
          suppress.splice(s, 1); // already shown as a queued bubble, now delivered
          return;
        }
        broadcast("message", userMessage(content, d.timestamp));
        return;
      }
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === "tool_result") {
            pendingTools.delete(b.tool_use_id);
            broadcast("tool_end", { id: b.tool_use_id, isError: !!b.is_error });
          }
        }
      }
      return;
    }

    if (d.type === "assistant" && Array.isArray(content)) {
      for (const b of content) {
        if (b.type === "text" && b.text.trim()) {
          broadcast("message", { role: "assistant", text: b.text, ts: d.timestamp });
        } else if (isNarration(b)) {
          broadcast("message", { role: "assistant", text: b.thinking, ts: d.timestamp, narration: true });
        } else if (b.type === "tool_use") {
          const t = { id: b.id, name: b.name, summary: toolSummary(b.input), ts: d.timestamp };
          pendingTools.set(b.id, t);
          broadcast("tool_start", t);
        }
      }
    }
  }


  // Codex persists both Responses items and UI lifecycle records. A mirror
  // must not duplicate a bubble; two identical prompts from one source must.
  const mirrors = new Map<string, { source: string; ts: string }[]>();
  const injectedContext = /^(?:\s*<(?:environment_context|user_instructions|instructions|permissions|collaboration_mode|turn_aborted|subagent_notification|skills_instructions)\b|# AGENTS\.md instructions)/i;
  function codexMessage(role: "user" | "assistant", text: string, ts: string, source: string, phase?: string) {
    if (!text.trim() || (role === "user" && injectedContext.test(text))) return;
    const key = `${role}:${text}`;
    const copies = mirrors.get(key) ?? [];
    const mirror = copies.findIndex((prev) => prev.source !== source && Math.abs(Date.parse(ts) - Date.parse(prev.ts)) < 10000);
    if (mirror >= 0) {
      copies.splice(mirror, 1);
      if (!copies.length) mirrors.delete(key);
      return;
    }
    copies.push({ source, ts });
    if (copies.length > 100) copies.shift();
    mirrors.set(key, copies);
    if (mirrors.size > 200) mirrors.delete(mirrors.keys().next().value!);
    if (role === "user") {
      const i = queue.findIndex((q) => q.text.trim() === text.trim());
      if (i >= 0) { deliver(queue.splice(i, 1)[0]); return; }
      broadcast("message", userMessage(text, ts));
    } else broadcast("message", { role: "assistant", text, ts, ...(phase ? { phase } : {}) });
  }
  const textContent = (content: any): string => typeof content === "string" ? content :
    Array.isArray(content) ? content.filter((b) => ["text", "Text", "input_text", "output_text"].includes(b.type))
      .map((b) => b.text ?? "").join("\n") : "";
  function startTool(id: string, name: string, input: any, ts: string) {
    if (!id || pendingTools.has(id)) return;
    const t = { id, name, summary: toolSummary(input), ts };
    pendingTools.set(id, t);
    broadcast("tool_start", t);
  }
  function endTool(id: string, error = false) {
    if (!id) return;
    pendingTools.delete(id);
    broadcast("tool_end", { id, isError: error });
  }
  function handleCodex(d: any) {
    const p = d.payload;
    if (!p) return;
    if (d.type === "response_item") {
      if (p.type === "message" && p.channel !== "analysis" && (p.role === "user" || p.role === "assistant"))
        codexMessage(p.role, textContent(p.content), d.timestamp, "response", p.phase);
      else if (p.type === "function_call" || p.type === "custom_tool_call") {
        let input: any = p.input ?? {};
        try { input = JSON.parse(p.arguments ?? p.input); } catch {}
        startTool(p.call_id, p.name, typeof input === "string" ? { command: input } : input, d.timestamp);
      } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
        const output = textContent(p.output);
        endTool(p.call_id, /Process exited with code [1-9]|"exit_code"\s*:\s*[1-9]/.test(output));
      }
      return;
    }
    if (d.type !== "event_msg") return;
    if (p.type === "user_message") codexMessage("user", p.message ?? "", d.timestamp, "event");
    else if (p.type === "agent_message") codexMessage("assistant", p.message ?? "", d.timestamp, "event", p.phase);
    else if (p.type === "item_completed" || p.type === "item_started") {
      const i = p.item;
      if (!i) return;
      if (p.type === "item_completed" && (i.type === "UserMessage" || i.type === "AgentMessage"))
        codexMessage(i.type === "UserMessage" ? "user" : "assistant", textContent(i.content) || i.text || "", d.timestamp, "event", i.phase);
      // UI tool lifecycle items supplement Responses calls (e.g. code-mode
      // nested commands). Reasoning, system context and tool outputs stay out
      // of chat and presentation captions.
      const names: Record<string, string> = { CommandExecution: "exec_command", FileChange: "apply_patch",
        McpToolCall: i.tool ?? "MCP", DynamicToolCall: i.tool ?? "tool", CollabToolCall: i.tool ?? "agent" };
      const name = names[i.type] ?? (i.type === "Extension" ? i.kind : undefined);
      if (name && i.id) {
        if (p.type === "item_started") startTool(i.id, name, i, d.timestamp);
        else {
          if (!pendingTools.has(i.id)) startTool(i.id, name, i, d.timestamp);
          endTool(i.id, i.status === "failed" || i.status === "declined" || (typeof i.exit_code === "number" && i.exit_code !== 0));
        }
      }
    } else if (["task_complete", "task_completed", "turn_aborted"].includes(p.type)) {
      for (const id of pendingTools.keys()) endTool(id, p.type === "turn_aborted");
    }
  }

  // Native Codex Tab-queued prompts, read from its queue database. Keep a
  // removed item briefly so a rollout flush can confirm delivery before we
  // call it withdrawn. Never write to the agent's database.
  const absentSince = new Map<string, number>();
  function syncQueue(items: { id: string; text: string; ts: string }[], now = Date.now()) {
    const oldOrder = queue.map((q) => q.id).join(",");
    const ids = new Set(items.map((q) => q.id));
    for (const q of [...queue]) {
      if (!q.id.startsWith("cq-")) continue;
      if (ids.has(q.id)) { absentSince.delete(q.id); continue; }
      const since = absentSince.get(q.id) ?? now;
      absentSince.set(q.id, since);
      if (now - since >= 1500) {
        queue.splice(queue.indexOf(q), 1);
        absentSince.delete(q.id);
        if (q.human) broadcast("unqueued", { id: q.id });
      }
    }
    for (const item of items) {
      if (consumed.has(item.id)) continue;
      const old = queue.find((q) => q.id === item.id);
      if (old?.text === item.text) continue;
      if (old) { queue.splice(queue.indexOf(old), 1); if (old.human) broadcast("unqueued", { id: old.id }); }
      const q = { ...item, human: !injectedContext.test(item.text) };
      queue.push(q);
      if (q.human) broadcast("message", userMessage(q.text, q.ts, { id: q.id, queued: true }));
    }
    // Forget consumed IDs only after they disappear from the native queue.
    for (const id of consumed) if (!ids.has(id)) consumed.delete(id);
    const order = new Map(items.map((q, i) => [q.id, i]));
    queue.sort((a, b) => (order.get(a.id) ?? items.length) - (order.get(b.id) ?? items.length));
    if (queue.map((q) => q.id).join(",") !== oldOrder)
      broadcast("queue_order", { ids: queue.filter((q) => q.human).map((q) => q.id) });
  }
  // Browser sends are pending until echoed by Codex, including mid-turn
  // steering. Register before typing, as the echo can precede herdr's reply.
  function pendingPrompt(text: string) {
    const id = `send-${crypto.randomUUID()}`;
    const ts = new Date().toISOString();
    queue.push({ id, text, human: true });
    broadcast("message", userMessage(text, ts, { id, queued: true }));
    return id;
  }
  function cancelPrompt(id: string) {
    const i = queue.findIndex((q) => q.id === id);
    if (i >= 0) { queue.splice(i, 1); broadcast("unqueued", { id }); }
  }
  return { handleEntry: kind === "codex" ? handleCodex : handleClaude, pendingTools, queue,
    syncQueue, pendingPrompt, cancelPrompt };
}
