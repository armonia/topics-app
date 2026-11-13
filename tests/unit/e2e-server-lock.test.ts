import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { acquireServerLock, lockDirFor } from "../e2e/helpers/server-lock";

describe("acquireServerLock", () => {
  test("a second taker waits until the first releases", async () => {
    const key = `unit-${Date.now()}-a`;
    const release = await acquireServerLock(key);
    let second = false;
    // Same pid counts as the owner, so simulate another holder with a foreign live pid.
    release();
    mkdirSync(lockDirFor(key));
    writeFileSync(join(lockDirFor(key), "pid"), String(process.ppid));
    const waiting = acquireServerLock(key, 5_000).then((r) => {
      second = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(second).toBe(false);
    rmSync(lockDirFor(key), { recursive: true, force: true });
    (await waiting)();
    expect(second).toBe(true);
  });

  test("a lock left by a dead process is taken over", async () => {
    const key = `unit-${Date.now()}-b`;
    mkdirSync(lockDirFor(key));
    writeFileSync(join(lockDirFor(key), "pid"), "2147483646");
    const release = await acquireServerLock(key, 2_000);
    release();
  });
});
