/**
 * @covers RUNTIME-25
 */
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { sweepRunLeftovers } from "./run-leftovers";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function leaveDetachedChild(cwd: string): Promise<number> {
  // `setsid` is absent on macOS: `detached` gives the same new session.
  const c = spawn("sleep", ["600"], { cwd, detached: true, stdio: "ignore" });
  c.unref();
  await wait(100);
  return c.pid!;
}

test("a detached child with cwd in the worktree is gone after the sweep", async () => {
  const wt = mkdtempSync(join(tmpdir(), "run-leftovers-"));
  const pid = await leaveDetachedChild(wt);
  try {
    expect(alive(pid)).toBe(true);
    const found = await sweepRunLeftovers(wt);
    expect(found.map((f) => f.pid)).toContain(pid);
    for (let i = 0; i < 30 && alive(pid); i++) await wait(100);
    expect(alive(pid)).toBe(false);
  } finally {
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    rmSync(wt, { recursive: true, force: true });
  }
});

test("spares the listed pid and processes outside the worktree", async () => {
  const wt = mkdtempSync(join(tmpdir(), "run-leftovers-"));
  const other = mkdtempSync(join(tmpdir(), "run-other-"));
  const kept = await leaveDetachedChild(wt);
  const outside = await leaveDetachedChild(other);
  try {
    await sweepRunLeftovers(wt, { spare: [kept] });
    await wait(300);
    expect(alive(kept)).toBe(true);
    expect(alive(outside)).toBe(true);
  } finally {
    for (const p of [kept, outside]) try { process.kill(p, "SIGKILL"); } catch { /* gone */ }
    rmSync(wt, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});
