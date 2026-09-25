#!/usr/bin/env bun
// agello: talk to a coding agent in a herdr pane from the browser.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json";
import { startServer } from "../src/server.ts";

const NAME = "agello";
const DEFAULT_PORT = 8765;
const STATE_DIR = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), NAME);

const HELP = `${NAME} ${pkg.version}: talk to a coding agent in a herdr pane from the browser

Usage:
  ${NAME} start [options]      Start a bridge server in the background
  ${NAME} stop [--port N|--all] Stop a running server
  ${NAME} status [--json]      List running servers
  ${NAME} open [--port N]      Open the bridge page in the default browser
  ${NAME} help | --version

start options:
  --pane <id>            herdr pane of the agent (default: $HERDR_PANE_ID)
  --port <n>             port (default: ${DEFAULT_PORT})
  --session <id>         expected agent session id (default: session seen at start)
  --browser <key>        terminal-browser key for the screen panel (default: same herdr tab)
  --allow-origin <o>     extra allowed origin for embedding, repeatable ("null" for file://)
  --open                 open the page after starting
  --foreground           run in this process instead of the background

Requires: bun, herdr. Optional: terminal-browser (screen panel).
State and logs: ${STATE_DIR}
`;

type Instance = {
  pid: number;
  port: number;
  pane: string;
  session?: string;
  url: string;
  log: string;
  startedAt: string;
};

// ---------- state files ----------

const statePath = (port: number) => join(STATE_DIR, `${port}.json`);
const logPath = (port: number) => join(STATE_DIR, `${port}.log`);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readInstance(port: number): Promise<Instance | null> {
  const f = Bun.file(statePath(port));
  if (!(await f.exists())) return null;
  try {
    const inst = (await f.json()) as Instance;
    if (isAlive(inst.pid)) return inst;
  } catch {}
  rmSync(statePath(port), { force: true }); // stale
  return null;
}

async function listInstances(): Promise<Instance[]> {
  if (!existsSync(STATE_DIR)) return [];
  const ports = readdirSync(STATE_DIR)
    .map((f) => f.match(/^(\d+)\.json$/)?.[1])
    .filter(Boolean)
    .map(Number);
  const all = await Promise.all(ports.map(readInstance));
  return all.filter((i): i is Instance => !!i).sort((a, b) => a.port - b.port);
}

async function fetchStatus(url: string): Promise<any | null> {
  try {
    const res = await fetch(`${url}/status`, { signal: AbortSignal.timeout(4000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

function openUrl(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" });
}

const fail = (msg: string): never => {
  console.error(`${NAME}: ${msg}`);
  process.exit(1);
};

// ---------- commands ----------

async function cmdStart(argv: string[]) {
  const { values: o } = parseArgs({
    args: argv,
    options: {
      pane: { type: "string", default: process.env.HERDR_PANE_ID },
      port: { type: "string", default: String(DEFAULT_PORT) },
      session: { type: "string" },
      browser: { type: "string" },
      "allow-origin": { type: "string", multiple: true, default: [] },
      open: { type: "boolean", default: false },
      foreground: { type: "boolean", default: false },
    },
  });
  const port = Number(o.port);
  if (!o.pane) fail("--pane is required (HERDR_PANE_ID is not set; run inside herdr or pass --pane)");
  if (!Bun.which("herdr")) fail("herdr not found on PATH");
  mkdirSync(STATE_DIR, { recursive: true });

  const existing = await readInstance(port);
  if (existing) {
    console.log(`already running: ${existing.url} (pane ${existing.pane}, pid ${existing.pid})`);
    if (o.open) openUrl(existing.url);
    return;
  }

  if (o.foreground) {
    const srv = await startServer({
      port,
      pane: o.pane!,
      session: o.session,
      browser: o.browser,
      allowOrigins: o["allow-origin"] as string[],
    });
    const inst: Instance = {
      pid: process.pid,
      port,
      pane: srv.pane,
      session: srv.session,
      url: srv.url,
      log: logPath(port),
      startedAt: new Date().toISOString(),
    };
    await Bun.write(statePath(port), JSON.stringify(inst, null, 2));
    const shutdown = () => {
      srv.stop();
      rmSync(statePath(port), { force: true });
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    console.log(`listening ${srv.url} pane=${srv.pane} session=${srv.session} transcript=${srv.transcript}`);
    if (o.open) openUrl(srv.url);
    return;
  }

  // Background: re-run this CLI with --foreground, detached, logging to a file.
  const args = argv.filter((a) => a !== "--open");
  const log = openSync(logPath(port), "a");
  const child = spawn(process.execPath, [import.meta.path, "start", "--foreground", ...args], {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, HERDR_PANE_ID: o.pane },
  });
  child.unref();

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || !isAlive(child.pid!)) fail(`server exited; see ${logPath(port)}`);
    if ((await readInstance(port)) && (await fetchStatus(url))) {
      console.log(`started: ${url} (pane ${o.pane}, pid ${child.pid})`);
      console.log(`log: ${logPath(port)}`);
      if (o.open) openUrl(url);
      return;
    }
    await Bun.sleep(200);
  }
  fail(`server did not become ready in 15s; see ${logPath(port)}`);
}

async function cmdStop(argv: string[]) {
  const { values: o } = parseArgs({
    args: argv,
    options: { port: { type: "string" }, all: { type: "boolean", default: false } },
  });
  const targets = o.all
    ? await listInstances()
    : [await readInstance(Number(o.port ?? DEFAULT_PORT))].filter((i): i is Instance => !!i);
  if (!targets.length) {
    console.log("not running");
    return;
  }
  for (const inst of targets) {
    process.kill(inst.pid, "SIGTERM");
    const deadline = Date.now() + 3000;
    while (isAlive(inst.pid) && Date.now() < deadline) await Bun.sleep(100);
    if (isAlive(inst.pid)) process.kill(inst.pid, "SIGKILL");
    rmSync(statePath(inst.port), { force: true });
    console.log(`stopped: ${inst.url} (pid ${inst.pid})`);
  }
}

async function cmdStatus(argv: string[]) {
  const { values: o } = parseArgs({ args: argv, options: { json: { type: "boolean", default: false } } });
  const list = await listInstances();
  const rows = await Promise.all(list.map(async (i) => ({ ...i, agent: await fetchStatus(i.url) })));
  if (o.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (!rows.length) {
    console.log("no running servers");
    return;
  }
  for (const r of rows) {
    const a = r.agent;
    const state = !a ? "unreachable" : a.alive ? a.status : `dead (${a.reason})`;
    const name = a?.label ? `${a.label} (${r.pane})` : r.pane;
    console.log(`${r.url}  pane=${name}  agent=${state}  pid=${r.pid}`);
  }
}

async function cmdOpen(argv: string[]) {
  const { values: o } = parseArgs({ args: argv, options: { port: { type: "string" } } });
  const inst = await readInstance(Number(o.port ?? DEFAULT_PORT));
  if (!inst) fail(`not running on port ${o.port ?? DEFAULT_PORT}; run \`${NAME} start\``);
  openUrl(inst!.url);
  console.log(inst!.url);
}

// ---------- main ----------

const [cmd, ...rest] = Bun.argv.slice(2);
switch (cmd) {
  case "start":
    await cmdStart(rest);
    break;
  case "stop":
    await cmdStop(rest);
    break;
  case "status":
    await cmdStatus(rest);
    break;
  case "open":
    await cmdOpen(rest);
    break;
  case "--version":
  case "-v":
    console.log(pkg.version);
    break;
  case undefined:
  case "help":
  case "--help":
  case "-h":
    console.log(HELP);
    break;
  default:
    fail(`unknown command: ${cmd}\n\n${HELP}`);
}
