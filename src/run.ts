// Run a CLI and return stdout, or null on failure/timeout.
//
// - The child is killed after `timeout` ms.
// - Completion is decided by the process exit, not by stdout EOF: a killed
//   child's own subprocess can keep the pipe open, and waiting for EOF would
//   stall the caller until that orphan exits.
// - stderr is ignored (an unread pipe can fill up and block the child).
export async function run(cmd: string[], timeout = 3000): Promise<string | null> {
  try {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", timeout });
    const out = new Response(p.stdout).text();
    const code = await p.exited;
    if (code !== 0) return null;
    return await out;
  } catch {
    return null;
  }
}

export async function runJson(cmd: string[], timeout = 3000): Promise<any | null> {
  const out = await run(cmd, timeout);
  if (out === null) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}
