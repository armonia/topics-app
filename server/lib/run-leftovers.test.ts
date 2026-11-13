/**
 * @covers RUNTIME-25
 */
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { sweepRunLeftovers } from "./run-leftovers";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readPid(file: string): Promise<number> {
  for (let i = 0; i < 50 && !existsSync(file); i++) await wait(100);
  await wait(50);
  return +readFileSync(file, "utf8").trim();
}

/** A `sleep` re-parented to init: its shell exits right after backgrounding it. */
async function makeOrphan(cwd: string, pidFile: string): Promise<number> {
  const c = spawn("sh", ["-c", `sleep 600 & echo $! > ${pidFile}`], { cwd, stdio: "ignore" });
  c.unref();
  return readPid(pidFile);
}

/** A child of this process (the server): a delivery check running in the worktree. */
function makeCheck(cwd: string): number {
  const c = spawn("sleep", ["600"], { cwd, stdio: "ignore" });
  c.unref();
  return c.pid!;
}

/** A terminal: a shell under an orphaned PTY bridge, `sleep` standing for the person's command. */
async function makeTerminal(cwd: string, pidFile: string): Promise<number> {
  const inner = `sleep 600 & echo $! > ${pidFile}; wait`;
  const c = spawn("sh", ["-c", `sh -c '${inner}' pty-bridge-fake &`], { cwd, stdio: "ignore" });
  c.unref();
  return readPid(pidFile);
}

test("sweeps the orphan, keeps the delivery check and the terminal", async () => {
  const wt = mkdtempSync(join(tmpdir(), "run-leftovers-"));
  const meta = mkdtempSync(join(tmpdir(), "run-meta-"));
  const orphan = await makeOrphan(wt, join(meta, "orphan"));
  const check = makeCheck(wt);
  const terminal = await makeTerminal(wt, join(meta, "terminal"));
  try {
    expect([orphan, check, terminal].every(alive)).toBe(true);
    const found = await sweepRunLeftovers(wt);
    expect(found.map((f) => f.pid)).toContain(orphan);
    for (let i = 0; i < 30 && alive(orphan); i++) await wait(100);
    expect(alive(orphan)).toBe(false);
    expect(alive(check)).toBe(true);
    expect(alive(terminal)).toBe(true);
  } finally {
    for (const p of [orphan, check, terminal]) try { process.kill(p, "SIGKILL"); } catch { /* gone */ }
    rmSync(wt, { recursive: true, force: true });
    rmSync(meta, { recursive: true, force: true });
  }
});

test("spares the listed pid and processes outside the worktree", async () => {
  const wt = mkdtempSync(join(tmpdir(), "run-leftovers-"));
  const other = mkdtempSync(join(tmpdir(), "run-other-"));
  const meta = mkdtempSync(join(tmpdir(), "run-meta-"));
  const kept = await makeOrphan(wt, join(meta, "kept"));
  const outside = await makeOrphan(other, join(meta, "outside"));
  try {
    await sweepRunLeftovers(wt, { spare: [kept] });
    await wait(300);
    expect(alive(kept)).toBe(true);
    expect(alive(outside)).toBe(true);
  } finally {
    for (const p of [kept, outside]) try { process.kill(p, "SIGKILL"); } catch { /* gone */ }
    for (const d of [wt, other, meta]) rmSync(d, { recursive: true, force: true });
  }
});
