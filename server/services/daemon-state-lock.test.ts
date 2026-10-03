/**
 * The singleton lock is taken EXCLUSIVELY.
 *
 * `acquireLock` read the lock, judged it, then wrote its own with tmp+rename,
 * which overwrites whatever is there. Two servers booting on the same home in
 * the same instant (both seeing "no lock" or "dead pid") both wrote and both
 * went on to open the DB and run migrations. The race is reproduced without
 * timing: the competitor writes its lock exactly while we are judging the
 * stale one (inside the liveness probe).
 * @covers RUNTIME-14
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { acquireLock, LiveLockError } from "./daemon-state";

const HOME_VERA = process.env.TOPICS_HOME;
const realKill = process.kill;
let home: string;
let lockFile: string;
let competitor: ReturnType<typeof Bun.spawn> | null = null;

const DEAD_PID = 999_999;
const lockBody = (pid: number) => JSON.stringify({ pid, acquiredAt: new Date().toISOString() });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "daemon-lock-"));
  lockFile = join(home, "daemon-process.lock");
  process.env.TOPICS_HOME = home;
});

afterEach(() => {
  process.kill = realKill;
  competitor?.kill();
  competitor = null;
  if (HOME_VERA === undefined) delete process.env.TOPICS_HOME; else process.env.TOPICS_HOME = HOME_VERA;
  rmSync(home, { recursive: true, force: true });
});

describe("acquireLock", () => {
  test("no lock: taken", () => {
    const lock = acquireLock();
    expect(lock.pid).toBe(process.pid);
    expect(JSON.parse(readFileSync(lockFile, "utf-8")).pid).toBe(process.pid);
  });

  test("a live holder: refused", () => {
    competitor = Bun.spawn(["sleep", "30"]);
    writeFileSync(lockFile, lockBody(competitor.pid));
    expect(() => acquireLock()).toThrow(LiveLockError);
    expect(JSON.parse(readFileSync(lockFile, "utf-8")).pid).toBe(competitor.pid);
  });

  test("a dead holder: recovered", () => {
    writeFileSync(lockFile, lockBody(DEAD_PID));
    expect(acquireLock().pid).toBe(process.pid);
    expect(JSON.parse(readFileSync(lockFile, "utf-8")).pid).toBe(process.pid);
  });

  test("our own lock: taken again", () => {
    writeFileSync(lockFile, lockBody(process.pid));
    expect(acquireLock().pid).toBe(process.pid);
  });

  test("a competitor that takes the stale lock while we judge it wins, and we stop", () => {
    competitor = Bun.spawn(["sleep", "30"]);
    const winner = competitor.pid;
    writeFileSync(lockFile, lockBody(DEAD_PID));
    // The other server, booting at the same instant, recovered the same stale
    // lock a moment before us: its lock lands while we probe the dead pid.
    process.kill = ((pid: number, sig?: string | number) => {
      if (pid === DEAD_PID) {
        writeFileSync(lockFile, lockBody(winner));
        const err = new Error("ESRCH") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      return realKill.call(process, pid, sig as never);
    }) as typeof process.kill;

    expect(() => acquireLock()).toThrow(LiveLockError);
    expect(JSON.parse(readFileSync(lockFile, "utf-8")).pid).toBe(winner);
  });
});
