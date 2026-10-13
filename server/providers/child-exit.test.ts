import { describe, test, expect } from "bun:test";
import { spawn } from "child_process";
import { childExited } from "./child-exit";

/** @covers CCLI-01 */

describe("childExited", () => {
  test("settles at the real exit, not at the cap", async () => {
    const proc = spawn("sleep", ["5"]);
    const t0 = Date.now();
    const done = childExited(proc, 4_000);
    proc.kill("SIGTERM");
    await done;
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  test("a child that ignores SIGTERM is waited for only up to the cap", async () => {
    const proc = spawn("sh", ["-c", "trap '' TERM; sleep 5"]);
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    const done = childExited(proc, 300);
    proc.kill("SIGTERM");
    await done;
    const waited = Date.now() - t0;
    proc.kill("SIGKILL");
    expect(waited).toBeGreaterThanOrEqual(280);
    expect(waited).toBeLessThan(1_500);
  });

  test("an already exited child settles at once", async () => {
    const proc = spawn("true");
    await new Promise((r) => proc.once("exit", r));
    const t0 = Date.now();
    await childExited(proc, 4_000);
    expect(Date.now() - t0).toBeLessThan(50);
  });
});
