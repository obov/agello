// Session identity comes from herdr, or from the Codex process in the exact
// pane. Never choose the newest rollout by cwd: several panes can share it.
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { run } from "./run.ts";

export type AgentKind = "claude" | "codex";
export const agentKind = (value: unknown): AgentKind | undefined =>
  value === "claude" || value === "codex" ? value : undefined;
export const codexHome = () => process.env.CODEX_HOME ?? join(homedir(), ".codex");
const safeId = (id: string) => /^[\w-]{1,128}$/.test(id);
export const rolloutId = (path: string) => basename(path).match(/^rollout-.*-([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\.jsonl$/i)?.[1];

export async function findTranscript(kind: AgentKind, session?: string, home = codexHome()): Promise<string | null> {
  if (!session || !safeId(session)) return null;
  const base = kind === "claude"
    ? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects")
    : join(home, "sessions");
  const pattern = kind === "claude" ? `*/${session}.jsonl` : `**/rollout-*-${session}.jsonl`;
  try {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: base, absolute: true })) return path;
  } catch { /* A fresh installation may not have a sessions directory yet. */ }
  return null;
}

export type CodexSession = { session: string; transcript: string | null; home: string; pid: number };
export function createCodexLocator(pane: string, exec = run) {
  let pid: number | undefined;
  let home = codexHome();

  async function locate(): Promise<CodexSession | null> {
    if (!pid) {
      const processes = await exec(["ps", "-axo", "pid=,tty=,comm="], 2000);
      const candidates = (processes ?? "").split("\n").flatMap((line) => {
        const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
        // Shared app-server daemons inherit a pane environment but own many
        // threads. Only a terminal's Codex process identifies its occupant.
        return m && m[2] !== "??" && m[2] !== "?" && /(?:^|\/)codex$/.test(m[3]) ? [Number(m[1])] : [];
      });
      const matches = await Promise.all(candidates.map(async (candidate) => {
        const env = await exec(["ps", "eww", "-p", String(candidate), "-o", "command="], 2000);
        if (env?.match(/(?:^|\s)HERDR_PANE_ID=([^\s]+)/)?.[1] !== pane) return null;
        return { pid: candidate, home: env.match(/(?:^|\s)CODEX_HOME=([^\s]+)/)?.[1] ?? codexHome() };
      }));
      const own = matches.filter((m) => m !== null);
      if (own.length !== 1) return null;
      pid = own[0]!.pid;
      home = own[0]!.home;
    }
    const files = await exec(["lsof", "-a", "-p", String(pid), "-Fn"], 2000);
    if (files === null) { pid = undefined; return null; }
    const paths = (files ?? "").split("\n").filter((l) => l.startsWith("n")).map((l) => l.slice(1));
    const rollouts = paths.filter((p) => rolloutId(p));
    const locks = paths.flatMap((p) => {
      const m = p.match(/\/thread-writer-locks\/([\w-]+)\.lock$/);
      return m ? [m[1]] : [];
    });
    const ids = new Set([...rollouts.map((p) => rolloutId(p)!), ...locks]);
    if (ids.size !== 1) return null;
    const session = [...ids][0];
    return { session, home, pid, transcript: rollouts[0] ?? await findTranscript("codex", session, home) };
  }
  return { locate };
}
