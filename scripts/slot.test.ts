/**
 * THE GATE SEMAPHORE, measured rather than asserted.
 *
 * This wrapper sits in front of every expensive gate — `test:unit`, `typecheck`,
 * `lint`, `check:deadcode` — so a bug here is a bug in every gate at once, and
 * in every agent turn that runs one. The two things worth pinning are therefore
 * opposite: that it really does exclude (or the throttle is decoration), and
 * that it can never refuse to run a command (or one bad slot file stops the
 * whole board).
 *
 * Each test gets its own slot directory: this file executes INSIDE `test:unit`,
 * which is holding a real slot while it runs.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SLOT = join(import.meta.dir, "slot.ts");
let dir = "";

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "slot-test-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** Runs the wrapper the way package.json does, and hands back exit code + output. */
async function slot(cmd: string, opts: { slots?: number; ms?: number } = {}) {
  const p = Bun.spawn(["bun", "run", SLOT, "t", "--", cmd], {
    env: {
      ...process.env,
      TOPICS_GATE_SLOT_DIR: dir,
      TOPICS_GATE_SLOTS: String(opts.slots ?? 1),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, out, err };
}

describe("the command always runs", () => {
  test("output comes through and a success stays a success", async () => {
    const r = await slot("echo ciao");
    expect(r.code).toBe(0);
    expect(r.out).toContain("ciao");
  });

  test("the exit code is the command's, not the wrapper's", async () => {
    // A gate that fails must still fail. Swallowing this is how a red suite
    // would start reporting green through the throttle.
    expect((await slot("exit 7")).code).toBe(7);
  });

  test("with the throttle switched off it still runs", async () => {
    const r = await slot("echo senza-freno", { slots: 0 });
    expect(r.code).toBe(0);
    expect(r.out).toContain("senza-freno");
  });

  test("a slot held by a DEAD process is not a slot: it gets reaped", async () => {
    // Without this, one killed run parks a slot until reboot and the gate that
    // needed it waits ten minutes for nothing.
    writeFileSync(join(dir, "0.pid"), "999999");
    const started = Date.now();
    const r = await slot("echo passato", { slots: 1 });
    expect(r.code).toBe(0);
    expect(r.out).toContain("passato");
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("it actually excludes", () => {
  test("one slot means one at a time, not two", async () => {
    // The measurement that makes this a throttle instead of a comment: two 1.5s
    // commands through a single slot cannot both be done in 1.5s.
    const started = Date.now();
    const [a, b] = await Promise.all([slot("sleep 1.5", { slots: 1 }), slot("sleep 1.5", { slots: 1 })]);
    const elapsed = Date.now() - started;
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(elapsed).toBeGreaterThan(2_800);
  }, 20_000);

  test("two slots let two through together", async () => {
    const started = Date.now();
    await Promise.all([slot("sleep 1.5", { slots: 2 }), slot("sleep 1.5", { slots: 2 })]);
    expect(Date.now() - started).toBeLessThan(2_800);
  }, 20_000);

  test("the slot comes back when the command is done", async () => {
    await slot("echo x");
    expect(readdirSync(dir).filter((f) => f.endsWith(".pid"))).toEqual([]);
  });
});
