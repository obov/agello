// herdr workspace -> tab -> pane tree, creation, and switching to a pane's own
// agello server (one server per pane; started on demand through the CLI).
// Deliberately no close/delete: closing a herdr pane kills its processes.

import { join } from "node:path";
import { run, runJson } from "./run.ts";

const CLI = join(import.meta.dir, "..", "bin", "agello.ts");
const ID = /^[A-Za-z0-9]+:[A-Za-z0-9]+$/; // herdr ids: w23, w23:t1, w23:p3
const WS_ID = /^[A-Za-z0-9]+$/;

// Resolve herdr on the current PATH (Bun.spawn uses the PATH from process start).
const bin = () => Bun.which("herdr", { PATH: process.env.PATH }) ?? "herdr";
const herdr = async (...cmd: string[]) => (await runJson([bin(), ...cmd], 5000)) ?? { error: { code: "herdr_failed" } };

export type TreePane = { id: string; agent?: string; status: string; title?: string; cwd?: string; focused: boolean };
export type TreeTab = { id: string; label: string; number: number; panes: TreePane[] };
export type TreeWorkspace = { id: string; label: string; number: number; tabs: TreeTab[] };

export async function paneTree(): Promise<TreeWorkspace[] | null> {
  const [w, t, p] = await Promise.all([herdr("workspace", "list"), herdr("tab", "list"), herdr("pane", "list")]);
  if (!w.result || !t.result || !p.result) return null;
  const tabs = new Map<string, TreeTab>();
  for (const tab of t.result.tabs)
    tabs.set(tab.tab_id, { id: tab.tab_id, label: tab.label, number: tab.number, panes: [] });
  for (const pane of p.result.panes)
    tabs.get(pane.tab_id)?.panes.push({
      id: pane.pane_id,
      agent: pane.agent,
      status: pane.agent_status,
      title: pane.terminal_title_stripped || undefined,
      cwd: pane.foreground_cwd || pane.cwd,
      focused: pane.focused,
    });
  return w.result.workspaces.map((ws: any) => ({
    id: ws.workspace_id,
    label: ws.label,
    number: ws.number,
    tabs: t.result.tabs
      .filter((tab: any) => tab.workspace_id === ws.workspace_id)
      .map((tab: any) => tabs.get(tab.tab_id)!),
  }));
}

const text = (v: unknown, max = 200) => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : undefined);
const fail = (error: string, status = 400) => Response.json({ ok: false, error }, { status });

// POST /panes/connect {pane} -> {ok, url}: the pane's server, started if needed.
async function connect(pane: unknown): Promise<Response> {
  if (typeof pane !== "string" || !ID.test(pane)) return fail("invalid_pane");
  if (!(await herdr("pane", "get", pane)).result) return fail("pane_not_found", 404);
  const out = await run([process.execPath, CLI, "start", "--pane", pane], 20000);
  const url = out?.match(/https?:\/\/127\.0\.0\.1:\d+/)?.[0];
  return url ? Response.json({ ok: true, pane, url }) : fail("server_start_failed", 502);
}

// POST /panes/create {kind: workspace|tab|pane, ...} -> {ok, pane}: the new root pane.
async function create(d: any): Promise<Response> {
  const cwd = text(d.cwd, 1024);
  if (cwd && !cwd.startsWith("/")) return fail("invalid_cwd");
  const label = text(d.label, 80);
  const opt = [...(cwd ? ["--cwd", cwd] : []), ...(label ? ["--label", label] : []), "--no-focus"];
  let res: any;
  if (d.kind === "workspace") res = await herdr("workspace", "create", ...opt);
  else if (d.kind === "tab") {
    if (typeof d.workspace !== "string" || !WS_ID.test(d.workspace)) return fail("invalid_workspace");
    res = await herdr("tab", "create", "--workspace", d.workspace, ...opt);
  } else if (d.kind === "pane") {
    if (typeof d.pane !== "string" || !ID.test(d.pane)) return fail("invalid_pane");
    if (d.direction !== "right" && d.direction !== "down") return fail("invalid_direction");
    res = await herdr("pane", "split", d.pane, "--direction", d.direction, ...(cwd ? ["--cwd", cwd] : []), "--no-focus");
  } else return fail("invalid_kind");
  const pane = res.result?.root_pane?.pane_id ?? res.result?.pane?.pane_id;
  return pane ? Response.json({ ok: true, pane }) : fail(res.error?.code ?? "herdr_failed", 502);
}

export async function panesRoute(req: Request, path: string, current: string): Promise<Response | null> {
  if (path === "/panes" && req.method === "GET") {
    const tree = await paneTree();
    return tree ? Response.json({ ok: true, current, workspaces: tree }) : fail("herdr_failed", 502);
  }
  if (req.method !== "POST" || (path !== "/panes/connect" && path !== "/panes/create")) return null;
  const d = (await req.json().catch(() => null)) as any;
  if (!d || typeof d !== "object") return fail("invalid_body");
  return path === "/panes/connect" ? connect(d.pane) : create(d);
}
