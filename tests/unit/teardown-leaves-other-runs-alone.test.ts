/**
 * A teardown does not touch another run's port.
 *
 * THE FAULT, observed rather than imagined. The global-teardown runs ALWAYS,
 * including when the global-setup refused to start because another run held the
 * lock on the port. The teardown then killed whatever was listening on that
 * port, without asking whose it was: the server of the very run the lock was
 * protecting. That is the opposite of what the lock exists for.
 *
 * On 2026-08-25 at 01:37 a refused run printed
 * `Killed stale processes on port 13334: 45374` and killed another agent's
 * suite mid-run. The lock had done its job; the teardown undid it.
 *
 * `liveLockHolder` is the missing question - "is this port mine?" - and these
 * tests hold the answers that matter. The normal case, MY run tearing itself
 * down, has to stay identical: if `liveLockHolder` reported a holder even when
 * the lock is mine, the teardown would stop cleaning and leave orphan processes
 * every run. The cure would be worse than the disease.
 *
 * @covers E2E-LOCK-01
 */
import { describe, expect, test } from "bun:test";
import { liveLockHolder, type LockFs, type LockRecord } from "../e2e/helpers/run-lock";

const fakeFs = (record: LockRecord | null): LockFs => ({
  read: () => (record ? JSON.stringify(record) : null),
  write: () => {},
  remove: () => {},
});

const record = (pid: number): LockRecord => ({ pid, startedAt: "2026-08-25T01:37:00Z", cwd: "/altro/repo", port: 13334 });

describe("is this port mine?", () => {
  test("a LIVE other run's lock announces itself: hands off", () => {
    const h = liveLockHolder(13334, { fs: fakeFs(record(45374)), isAlive: () => true });
    expect(h?.pid).toBe(45374);
    expect(h?.cwd, "the message must be able to say WHOSE the port is").toBe("/altro/repo");
  });

  test("a DEAD process's lock protects nothing", () => {
    // Otherwise a lock left behind by a crash would block the port's cleanup
    // forever, and orphan processes would pile up.
    expect(liveLockHolder(13334, { fs: fakeFs(record(45374)), isAlive: () => false })).toBeNull();
  });

  test("MY lock does not protect me from myself", () => {
    // The normal case: my own run tearing down must clean as it always did.
    // If this returned a holder, the cure would be worse than the fault.
    expect(liveLockHolder(13334, { fs: fakeFs(record(process.pid)), isAlive: () => true })).toBeNull();
  });

  test("no lock: nothing to protect", () => {
    expect(liveLockHolder(13334, { fs: fakeFs(null), isAlive: () => true })).toBeNull();
  });

  test("an unreadable lock is not a holder", () => {
    // A half-written file must not block cleanup: without this, a crash midway
    // through writing the lock freezes the port forever.
    const broken: LockFs = { read: () => "{ non json", write: () => {}, remove: () => {} };
    expect(liveLockHolder(13334, { fs: broken, isAlive: () => true })).toBeNull();
  });
});

describe("the teardown asks before killing", () => {
  test("the source consults the lock holder before the kill on the port", () => {
    // The tests above prove what the function answers; this proves the teardown
    // CALLS it, and first. Without it the five above would stay green while the
    // fault came back: that is exactly how it survived.
    const src = require("node:fs").readFileSync(
      require("node:path").join(import.meta.dir, "..", "e2e", "global-teardown.ts"),
      "utf8",
    ) as string;
    const call = src.indexOf("liveLockHolder(TEST_PORT)");
    const kill = src.indexOf("lsof -ti :${TEST_PORT}");
    expect(call, "the teardown does not consult the lock").toBeGreaterThan(-1);
    expect(kill).toBeGreaterThan(-1);
    expect(call, "consults the lock AFTER killing: useless").toBeLessThan(kill);
  });
});
