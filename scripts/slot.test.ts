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
  * @covers SLOT-01
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SLOT = join(import.meta.dir, "slot.ts");
let dir = "";

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "slot-test-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** Runs the wrapper the way package.json does, and hands back exit code + output. */
async function slot(cmd: string, opts: { slots?: number; ms?: number; graceMs?: number; label?: string; maxWaitMs?: number } = {}) {
  const p = Bun.spawn(["bun", "run", SLOT, opts.label ?? "t", "--", cmd], {
    env: {
      ...process.env,
      TOPICS_GATE_SLOT_DIR: dir,
      TOPICS_GATE_SLOTS: String(opts.slots ?? 1),
      ...(opts.maxWaitMs != null ? { TOPICS_GATE_MAX_WAIT_MS: String(opts.maxWaitMs) } : {}),
      // Di default il tetto è un'ora: nessun test può aspettarlo, e lasciarlo al
      // valore vero significherebbe non misurarlo mai.
      ...(opts.ms != null ? { TOPICS_GATE_MAX_RUN_MS: String(opts.ms) } : {}),
      ...(opts.graceMs != null ? { TOPICS_GATE_KILL_GRACE_MS: String(opts.graceMs) } : {}),
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

describe("un comando appeso viene abbattuto", () => {
  // Il 2026-08-14 c'erano tre alberi `bun test` vivi da 12, 18 e 22 ore con
  // pochi minuti di CPU in tutto: fermi, non lenti. Non davano né verde né
  // rosso e tenevano il loro slot. Questi test misurano che ora danno rosso.
  test("oltre il tetto di wall-clock esce 124, non resta appeso", async () => {
    const started = Date.now();
    const r = await slot("sleep 30", { ms: 1_000, graceMs: 500 });
    expect(r.code).toBe(124);
    expect(r.err).toContain("wall-clock");
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  test("si porta via l'albero, non solo la shell", async () => {
    // Il difetto vero non era la shell appesa ma i suoi figli: uccidere il solo
    // pid del wrapper lascia in piedi proprio i processi che tengono la memoria.
    const pidFile = join(dir, "nipote.pid");
    const r = await slot(`sleep 30 & echo $! > ${pidFile}; wait`, { ms: 1_000, graceMs: 500 });
    expect(r.code).toBe(124);
    const grandchild = Number(readFileSync(pidFile, "utf8").trim());
    expect(Number.isFinite(grandchild)).toBe(true);
    // Il kill al gruppo è asincrono: si concede qualche giro prima di giudicare.
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try { process.kill(grandchild, 0); await Bun.sleep(100); } catch { alive = false; }
    }
    expect(alive).toBe(false);
  }, 30_000);

  test("un comando che finisce in tempo non viene toccato", async () => {
    // La misura opposta: senza questa, un tetto sempre-scattante passerebbe
    // il test qui sopra e ucciderebbe ogni gate della macchina.
    const r = await slot("echo in-tempo", { ms: 30_000 });
    expect(r.code).toBe(0);
    expect(r.out).toContain("in-tempo");
    expect(r.err).not.toContain("wall-clock");
  }, 30_000);

  test("il tetto si può spegnere con 0", async () => {
    const r = await slot("sleep 1; echo senza-tetto", { ms: 0 });
    expect(r.code).toBe(0);
    expect(r.out).toContain("senza-tetto");
  }, 30_000);

  test("lo slot torna libero anche quando il comando viene abbattuto", async () => {
    await slot("sleep 30", { ms: 1_000, graceMs: 500 });
    expect(readdirSync(dir).filter((f) => f.endsWith(".pid"))).toEqual([]);
  }, 30_000);
});

describe("it actually excludes", () => {
  test("one slot means one at a time, not two", async () => {
    // The measurement that makes this a throttle instead of a comment: two 1.5s
    // commands through a single slot cannot both be done in 1.5s. Two DIFFERENT
    // names, so what is measured is the count and not the per-name lock below.
    const started = Date.now();
    const [a, b] = await Promise.all([
      slot("sleep 1.5", { slots: 1, label: "alpha" }),
      slot("sleep 1.5", { slots: 1, label: "beta" }),
    ]);
    const elapsed = Date.now() - started;
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(elapsed).toBeGreaterThan(2_800);
  }, 20_000);

  test("two slots let two DIFFERENT gates through together", async () => {
    const started = Date.now();
    await Promise.all([
      slot("sleep 1.5", { slots: 2, label: "alpha" }),
      slot("sleep 1.5", { slots: 2, label: "beta" }),
    ]);
    expect(Date.now() - started).toBeLessThan(2_800);
  }, 20_000);

  test("two slots do NOT let the same gate through twice: one lint at a time", async () => {
    // Card 363bbbc8: three worktrees delivering together started three `eslint`
    // (1.3 GB for two of them) because the count was free. The name lock is
    // what stops that, and it is bounded like everything else here: past the
    // wait the second one runs anyway rather than blocking a gate.
    const started = Date.now();
    const [a, b] = await Promise.all([
      slot("sleep 1.5", { slots: 2, label: "lint" }),
      slot("sleep 1.5", { slots: 2, label: "lint", maxWaitMs: 15_000 }),
    ]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(Date.now() - started).toBeGreaterThan(2_800);
  }, 25_000);

  test("the slot comes back when the command is done", async () => {
    await slot("echo x");
    expect(readdirSync(dir).filter((f) => f.endsWith(".pid"))).toEqual([]);
  });
});
