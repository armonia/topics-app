/**
 * `slot.ts` CONTINUED AFTER A FREEZE, run as the real script (card cda99908,
 * finding 15, review of 31/10).
 *
 * The wiring is what is under test here: the SIGCONT handler, the two lines a
 * board check times the command by, and a SIGTERM heard during the new wait.
 * `gate-slot-stopped-holder.test.ts` covers the protocol under it.
 *
 * No real SIGSTOP or SIGCONT is sent. A preload loaded before the script
 * replaces `process.kill` for those two signals with a line on stderr (the
 * fake `signalTree`), waits for the run to hold its name, writes another live
 * pid into the name file (the run was frozen, reaped and its name taken) and
 * EMITS SIGCONT inside the process, as the runtime does on a real one.
 *
 * @covers SLOT-02
 */
import { describe, it, expect, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slotAcquiredLine, slotWaitingLine } from "../../shared/slot-acquired";
import { acquireSlot } from "../../scripts/gate-slot.ts";

const SLOT_SCRIPT = join(import.meta.dir, "../../scripts/slot.ts");

const PRELOAD = `
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
const nameFile = process.env.FAKE_NAME_FILE;
const real = process.kill.bind(process);
process.kill = ((pid, sig) => {
  if (sig === "SIGSTOP" || sig === "SIGCONT") { console.error("[fake] " + sig); return true; }
  return real(pid, sig);
});
const poll = setInterval(() => {
  let held = "";
  try { held = readFileSync(nameFile, "utf8"); } catch {}
  if (held !== String(process.pid)) return;
  clearInterval(poll);
  writeFileSync(nameFile, process.env.FAKE_TAKER);
  process.emit("SIGCONT");
  setTimeout(() => {
    if (process.env.FAKE_MODE === "term") { console.error("[fake] SIGTERM in"); process.emit("SIGTERM"); }
    else { console.error("[fake] taker done"); unlinkSync(nameFile); }
  }, Number(process.env.FAKE_TAKER_MS || 1500));
}, 50);
`;

const FAKE_PS = `#!/bin/sh
for p in $(echo "$4" | tr , ' '); do echo "  $p S+"; done
`;

let dir = "";
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });

const nameFile = (d: string, label: string) =>
  join(d, `name-${createHash("sha1").update(label.trim().toLowerCase()).digest("hex").slice(0, 12)}.pid`);

async function runSlot(mode: "free" | "term", extra: NodeJS.ProcessEnv = {}, cmd = "sleep 4; echo cmd-done"): Promise<{ code: number | null; stderr: string; stdout: string; ms: number; d: string }> {
  dir = mkdtempSync(join(tmpdir(), "topics-slot-continue-"));
  const slots = join(dir, "slots");
  mkdirSync(slots);
  writeFileSync(join(dir, "preload.ts"), PRELOAD);
  writeFileSync(join(dir, "ps"), FAKE_PS, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TOPICS_GATE_SLOTS: "1",
    TOPICS_GATE_SLOT_DIR: slots,
    TOPICS_GATE_PS: join(dir, "ps"),
    TOPICS_GATE_MAX_WAIT_MS: "20000",
    TOPICS_GATE_NAME_MAX_WAIT_MS: "20000",
    FAKE_NAME_FILE: nameFile(slots, "typecheck"),
    // Alive and running for the whole test: the run that took the name.
    FAKE_TAKER: String(process.pid),
    FAKE_MODE: mode,
    ...extra,
  };
  delete env.TOPICS_GATE_HELD;
  const started = Date.now();
  const child = spawn(process.execPath, ["--preload", join(dir, "preload.ts"), SLOT_SCRIPT, "typecheck", "--", cmd], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  let stdout = "";
  child.stderr.on("data", (b) => { stderr += String(b); });
  child.stdout.on("data", (b) => { stdout += String(b); });
  const code = await new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));
  return { code, stderr, stdout, ms: Date.now() - started, d: slots };
}

/** The lines of `text` that are one of `wanted`, in order (prefix match). */
const sequence = (text: string, wanted: readonly string[]) =>
  text.split("\n").map((l) => wanted.find((w) => l.startsWith(w))).filter((w): w is string => w != null);

describe("slot.ts holding its place", () => {
  it("marks it as the place of a run that queues again, so a stopped slot.ts is reaped", async () => {
    dir = mkdtempSync(join(tmpdir(), "topics-slot-continue-"));
    const slots = join(dir, "slots");
    mkdirSync(slots);
    const stopped = join(dir, "stopped");
    writeFileSync(stopped, "");
    // Whatever pid is in the stopped file reads `T`: here, the slot.ts below.
    writeFileSync(join(dir, "ps"), `#!/bin/sh
for p in $(echo "$4" | tr , ' '); do
  if grep -qx "$p" ${JSON.stringify(stopped)}; then echo "  $p T+"; else echo "  $p S+"; fi
done
`, { mode: 0o755 });
    const env: NodeJS.ProcessEnv = { ...process.env, TOPICS_GATE_SLOTS: "1", TOPICS_GATE_SLOT_DIR: slots, TOPICS_GATE_PS: join(dir, "ps") };
    delete env.TOPICS_GATE_HELD;
    const child = spawn(process.execPath, [SLOT_SCRIPT, "typecheck", "--", "sleep 3"], { env, stdio: "ignore" });
    const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
    const name = nameFile(slots, "typecheck");
    const until = Date.now() + 5_000;
    while (!existsSync(name + ".requeue") && Date.now() < until) await Bun.sleep(50);
    expect(readFileSync(name + ".requeue", "utf8")).toBe(String(child.pid));
    writeFileSync(stopped, `${child.pid}\n`);
    const prev = { dir: process.env.TOPICS_GATE_SLOT_DIR, ps: process.env.TOPICS_GATE_PS };
    process.env.TOPICS_GATE_SLOT_DIR = slots;
    process.env.TOPICS_GATE_PS = join(dir, "ps");
    try {
      const started = Date.now();
      const release = acquireSlot(1, "typecheck", { maxWaitMs: 2_000, onWait: () => {} });
      expect(release).not.toBeNull();
      expect(Date.now() - started).toBeLessThan(1_000);
      release!();
    } finally {
      process.env.TOPICS_GATE_SLOT_DIR = prev.dir;
      process.env.TOPICS_GATE_PS = prev.ps;
      if (prev.dir == null) delete process.env.TOPICS_GATE_SLOT_DIR;
      if (prev.ps == null) delete process.env.TOPICS_GATE_PS;
    }
    await exited;
  }, 30_000);
});

describe("slot.ts continued after a freeze", () => {
  it("whose name was taken: says it waits, stops its command, and goes on once it holds the name again", async () => {
    const r = await runSlot("free");
    const waiting = slotWaitingLine("typecheck");
    const acquired = slotAcquiredLine("typecheck", 0).split(":")[0]!;
    expect(sequence(r.stderr, [acquired, waiting, "[fake] SIGSTOP", "[fake] taker done", "[fake] SIGCONT"])).toEqual([
      acquired, waiting, "[fake] SIGSTOP", "[fake] taker done", "[fake] SIGCONT", acquired,
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("cmd-done");
    // The place taken back is given back at the end.
    expect(existsSync(nameFile(r.d, "typecheck"))).toBe(false);
  }, 30_000);

  it("the wall-clock cap does not run while the command waits in the queue again (review of 31/10, third round)", async () => {
    // The fake stop leaves the command running: it ends at 4 s, while a cap of
    // 2.5 s counted through the 3 s of the new wait fired at 2.5 s, exit 124.
    const r = await runSlot("free", { FAKE_TAKER_MS: "3000", TOPICS_GATE_MAX_RUN_MS: "2500", TOPICS_GATE_KILL_GRACE_MS: "500" });
    expect(r.stderr).not.toContain("wall-clock");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("cmd-done");
  }, 30_000);

  it("the cap still runs once the place is held again", async () => {
    // 2.5 s of cap, about none used before the freeze: it fires 2.5 s after the
    // place came back, well before the 20 s command ends.
    const r = await runSlot("free", { FAKE_TAKER_MS: "1000", TOPICS_GATE_MAX_RUN_MS: "2500", TOPICS_GATE_KILL_GRACE_MS: "500" }, "sleep 20; echo cmd-done");
    expect(r.code).toBe(124);
    expect(r.stdout).not.toContain("cmd-done");
    expect(r.ms).toBeGreaterThanOrEqual(3_000);
    expect(r.ms).toBeLessThan(10_000);
  }, 30_000);

  it("a SIGTERM during the new wait is heard at once, and the stopped command is continued to receive it", async () => {
    const r = await runSlot("term");
    expect(sequence(r.stderr, ["[fake] SIGSTOP", "[fake] SIGTERM in", "[fake] SIGCONT"]).slice(0, 3)).toEqual([
      "[fake] SIGSTOP", "[fake] SIGTERM in", "[fake] SIGCONT",
    ]);
    // Far from the 20 s of the name wait: the wait did not keep the script deaf.
    expect(r.ms).toBeLessThan(8_000);
    expect(r.code).not.toBe(0);
    expect(r.stdout).not.toContain("cmd-done");
  }, 30_000);
});
