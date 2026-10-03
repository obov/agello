import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Codex 0.157 stores Tab-queued submissions here. This is an optional,
// version-sensitive reader: a missing/changed DB never prevents chat.
export function readCodexQueue(home: string, session: string): { id: string; text: string; ts: string }[] | null {
  const path = join(home, "queue_1.sqlite");
  if (!existsSync(path)) return null;
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    const rows = db.query("SELECT id, payload_json, created_at_ms FROM queued_items WHERE thread_id = ? ORDER BY queue_order").all(session) as any[];
    return rows.flatMap((row) => {
      try {
        const payload = JSON.parse(row.payload_json);
        // SQLite stores the core submission enum, rather than the camelCase
        // App Server QueuedSubmission response. Observed in Codex 0.157.1.
        const input = payload.UserInput?.content ?? payload.input;
        if (!Array.isArray(input)) return [];
        const text = input.filter((i: any) => i.type === "text" && typeof i.text === "string")
          .map((i: any) => i.text).join("\n");
        return text.trim() ? [{ id: `cq-${row.id}`, text, ts: new Date(row.created_at_ms).toISOString() }] : [];
      } catch { return []; }
    });
  } catch { return null; }
  finally { db?.close(); }
}
