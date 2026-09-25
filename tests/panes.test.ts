import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { panesRoute } from "../src/panes";

let dir: string;
const originalPath = process.env.PATH;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "agello-panes-"));
  const cli = join(dir, "herdr");
  // Records every call to calls.log and answers like herdr 0.8.
  await Bun.write(cli, `#!${process.execPath}
const a = process.argv.slice(2);
require("node:fs").appendFileSync(${JSON.stringify(join(dir, "calls.log"))}, JSON.stringify(a) + "\\n");
const out = (result) => console.log(JSON.stringify({ result }));
const k = a[0] + " " + a[1];
if (k === "workspace list") out({ workspaces: [
  { workspace_id: "w1", label: "agello", number: 1 }, { workspace_id: "w2", label: "other", number: 2 } ] });
else if (k === "tab list") out({ tabs: [
  { tab_id: "w1:t1", workspace_id: "w1", label: "1", number: 1 },
  { tab_id: "w2:t1", workspace_id: "w2", label: "1", number: 1 }, { tab_id: "w2:t2", workspace_id: "w2", label: "2", number: 2 } ] });
else if (k === "pane list") out({ panes: [
  { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent: "claude", agent_status: "idle", terminal_title_stripped: "Claude Code", cwd: "/a", focused: true },
  { pane_id: "w2:p1", tab_id: "w2:t2", workspace_id: "w2", agent_status: "unknown", cwd: "/b", focused: false } ] });
else if (k === "workspace create" || k === "tab create") out({ root_pane: { pane_id: "w9:p1" } });
else if (k === "pane split") out({ pane: { pane_id: "w1:p2" } });
else if (k === "pane get") a[2] === "w1:p1" ? out({ pane: { pane_id: "w1:p1" } }) : process.exit(1);
else process.exit(1);
`);
  await chmod(cli, 0o755);
  process.env.PATH = `${dir}:${originalPath}`;
  // Never let these tests reach the real herdr: they create workspaces and panes.
  if (Bun.which("herdr", { PATH: process.env.PATH }) !== cli) throw new Error("mock herdr not on PATH");
});
afterAll(async () => {
  process.env.PATH = originalPath;
  await rm(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  panesRoute(new Request("http://x" + path, { method: "POST", body: JSON.stringify(body) }), path, "w1:p1");
const calls = async () => (await readFile(join(dir, "calls.log"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));

test("builds the workspace -> tab -> pane tree", async () => {
  const res = (await panesRoute(new Request("http://x/panes"), "/panes", "w1:p1"))!;
  const d = await res.json();
  expect(d.current).toBe("w1:p1");
  expect(d.workspaces.map((w: any) => w.label)).toEqual(["agello", "other"]);
  expect(d.workspaces[0].tabs[0].panes[0]).toMatchObject({ id: "w1:p1", agent: "claude", status: "idle", title: "Claude Code" });
  expect(d.workspaces[1].tabs.map((t: any) => t.panes.length)).toEqual([0, 1]);
});

test("creates workspaces, tabs and panes without focusing, and returns the new pane", async () => {
  expect(await (await post("/panes/create", { kind: "workspace", label: "new", cwd: "/tmp" }))!.json())
    .toEqual({ ok: true, pane: "w9:p1" });
  expect(await (await post("/panes/create", { kind: "tab", workspace: "w1" }))!.json()).toEqual({ ok: true, pane: "w9:p1" });
  expect(await (await post("/panes/create", { kind: "pane", pane: "w1:p1", direction: "down" }))!.json())
    .toEqual({ ok: true, pane: "w1:p2" });
  const made = (await calls()).filter((c) => c[1] === "create" || c[1] === "split");
  expect(made).toEqual([
    ["workspace", "create", "--cwd", "/tmp", "--label", "new", "--no-focus"],
    ["tab", "create", "--workspace", "w1", "--no-focus"],
    ["pane", "split", "w1:p1", "--direction", "down", "--no-focus"],
  ]);
});

test("rejects invalid input and never closes anything", async () => {
  const bad = [
    { kind: "workspace", cwd: "relative/path" },
    { kind: "tab", workspace: "w1; rm -rf" },
    { kind: "pane", pane: "w1:p1", direction: "left" },
    { kind: "close", pane: "w1:p1" },
  ];
  for (const b of bad) expect((await post("/panes/create", b))!.status).toBe(400);
  expect((await post("/panes/connect", { pane: "--takeover" }))!.status).toBe(400);
  expect((await post("/panes/connect", { pane: "w5:p5" }))!.status).toBe(404);
  expect((await calls()).some((c) => c[1] === "close")).toBe(false);
});
