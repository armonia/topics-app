/**
 * A STOPPED HOLDER DOES NOT HOLD (card cda99908, findings 2 and 15).
 *
 * Both freezers of the server send SIGSTOP to whole trees, `slot.ts` included,
 * and `kill(pid, 0)` reads a stopped process as alive. Before the fix a frozen
 * `typecheck` kept its name file and its numbered slot: every other run of the
 * gate waited the full name deadline and then started "alongside", together.
 *
 * The holder here is the parent of the test process: alive, never signalled.
 * Whether it is stopped is what the fake probe says, so no real signal is sent.
 *
 * @covers SLOT-02
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSlot } from "../../scripts/gate-slot.ts";

let dir = "";
const fresh = (): string => {
  dir = mkdtempSync(join(tmpdir(), "topics-slot-stopped-"));
  process.env.TOPICS_GATE_SLOT_DIR = dir;
  return dir;
};

afterEach(() => {
  delete process.env.TOPICS_GATE_SLOT_DIR;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

// Same key as `nameLockPath` in the module: the file a holder of that name writes.
const nameFile = (d: string, label: string) =>
  join(d, `name-${createHash("sha1").update(label.trim().toLowerCase()).digest("hex").slice(0, 12)}.pid`);

const holder = process.ppid;
const WAIT_MS = 250;

describe("the gate slot, against a stopped holder", () => {
  it("a stopped holder of the name and of the only slot lets the next run in at once", () => {
    const d = fresh();
    writeFileSync(nameFile(d, "typecheck"), String(holder));
    writeFileSync(join(d, "0.pid"), String(holder));
    const heard: string[] = [];
    const started = Date.now();
    const release = acquireSlot(1, "typecheck", {
      maxWaitMs: WAIT_MS,
      onWait: (m) => heard.push(m),
      stopped: (pids) => new Set(pids.filter((p) => p === holder)),
    });
    expect(release).not.toBeNull();
    expect(Date.now() - started).toBeLessThan(WAIT_MS);
    expect(heard).toEqual([]);
    expect(readFileSync(nameFile(d, "typecheck"), "utf8")).toBe(String(process.pid));
    expect(readFileSync(join(d, "0.pid"), "utf8")).toBe(String(process.pid));
    release!();
  });

  it("a running holder still holds: the next run waits, as before", () => {
    const d = fresh();
    writeFileSync(nameFile(d, "typecheck"), String(holder));
    const heard: string[] = [];
    const release = acquireSlot(1, "typecheck", { maxWaitMs: WAIT_MS, onWait: (m) => heard.push(m), stopped: () => new Set() });
    expect(heard.some((m) => m.includes("running alongside"))).toBe(true);
    expect(readFileSync(nameFile(d, "typecheck"), "utf8")).toBe(String(holder));
    release?.();
  });

  it("a release never removes a file another run has taken since", () => {
    const d = fresh();
    const release = acquireSlot(1, "lint", { maxWaitMs: WAIT_MS, stopped: () => new Set() });
    expect(release).not.toBeNull();
    // This run was frozen, reaped, and its place taken by the next one.
    writeFileSync(nameFile(d, "lint"), String(holder));
    writeFileSync(join(d, "0.pid"), String(holder));
    release!();
    expect(existsSync(nameFile(d, "lint"))).toBe(true);
    expect(existsSync(join(d, "0.pid"))).toBe(true);
  });
});
