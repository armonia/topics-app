/**
 * Phase B · daemon-state lifecycle test (DAEMON-01).
 *
 * Exercises the lock + state file pure-fs/crypto module without
 * spinning up Bun.serve. The token-authed control endpoints
 * (DAEMON-02) ride on the existing listener so they're covered at the
 * e2e level.
 */
import { describe, expect, test, beforeAll, afterEach } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { testTmpDir } from "./helpers";

const TEST_HOME = testTmpDir("phase-b-daemon");

beforeAll(() => {
  process.env.TOPICS_HOME = TEST_HOME;
});

afterEach(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("daemon-state — lock lifecycle (DAEMON-01)", () => {

  test("acquireLock writes lock + state file with correct shape on a fresh start", async () => {
    const { acquireLock, writeState } = await import("../../server/services/daemon-state");
    acquireLock();
    const state = writeState(3333);

    const lock = JSON.parse(fs.readFileSync(join(TEST_HOME, "daemon-process.lock"), "utf-8"));
    expect(lock.pid).toBe(process.pid);
    expect(typeof lock.acquiredAt).toBe("string");

    expect(state.pid).toBe(process.pid);
    expect(state.port).toBe(3333);
    expect(state.token).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof state.startedAt).toBe("string");

    const stateOnDisk = JSON.parse(fs.readFileSync(join(TEST_HOME, "daemon-state.json"), "utf-8"));
    expect(stateOnDisk.token).toBe(state.token);
  });

  test("state file is mode 0600 (token is sensitive)", async () => {
    const { acquireLock, writeState } = await import("../../server/services/daemon-state");
    acquireLock();
    writeState(3333);
    const stat = fs.statSync(join(TEST_HOME, "daemon-state.json"));
    // Mask off file-type bits; only check the user-perm triplet.
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("rejects a second acquire while a live lock is held (LiveLockError)", async () => {
    const { acquireLock, LiveLockError } = await import("../../server/services/daemon-state");
    // First lock is by the test process itself (pid alive).
    acquireLock();
    // A "second" attempt would normally come from another process. We
    // simulate it by hand-writing a fake lock for *another* live pid
    // (just use the current one, which is alive).
    const lockPath = join(TEST_HOME, "daemon-process.lock");
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid + 1_000_000, acquiredAt: new Date().toISOString() }),
    );
    // Fall back: the file points at a pid that ESRCHs out → stale, so the
    // recovery path triggers and acquireLock proceeds. To force the live
    // path we instead seed with our own pid.
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
    );
    // Same pid → acquireLock treats this as "own re-acquire" and overwrites
    // (the contract is "reject another *live* process"). To exercise the
    // reject branch we need a sentinel pid we know is alive but != ours.
    // pid 1 (init) is always alive on macOS.
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 1, acquiredAt: new Date().toISOString() }),
    );
    expect(() => acquireLock()).toThrow(LiveLockError);
  });

  test("recovers a stale lock (dead pid → ESRCH) and overwrites", async () => {
    const { acquireLock } = await import("../../server/services/daemon-state");
    fs.mkdirSync(TEST_HOME, { recursive: true });
    // 999_999 is virtually guaranteed to be unused on macOS.
    fs.writeFileSync(
      join(TEST_HOME, "daemon-process.lock"),
      JSON.stringify({ pid: 999_999, acquiredAt: "2020-01-01T00:00:00.000Z" }),
    );
    expect(() => acquireLock()).not.toThrow();
    const lock = JSON.parse(fs.readFileSync(join(TEST_HOME, "daemon-process.lock"), "utf-8"));
    expect(lock.pid).toBe(process.pid);
  });

  test("recovers a stale lock whose pid is alive but predates the last boot (reboot pid-reuse)", async () => {
    const { acquireLock } = await import("../../server/services/daemon-state");
    fs.mkdirSync(TEST_HOME, { recursive: true });
    // pid 1 (launchd/init) is always alive, but a lock "acquired" in 2020
    // necessarily predates this boot — i.e. the recorded pid was recycled by
    // the OS after a reboot. Must recover, not throw LiveLockError.
    fs.writeFileSync(
      join(TEST_HOME, "daemon-process.lock"),
      JSON.stringify({ pid: 1, acquiredAt: "2020-01-01T00:00:00.000Z" }),
    );
    expect(() => acquireLock()).not.toThrow();
    const lock = JSON.parse(fs.readFileSync(join(TEST_HOME, "daemon-process.lock"), "utf-8"));
    expect(lock.pid).toBe(process.pid);
  });

  test("releaseLock removes both files; idempotent when files are missing", async () => {
    const { acquireLock, writeState, releaseLock } = await import("../../server/services/daemon-state");
    acquireLock();
    writeState(3333);
    expect(fs.existsSync(join(TEST_HOME, "daemon-process.lock"))).toBe(true);
    expect(fs.existsSync(join(TEST_HOME, "daemon-state.json"))).toBe(true);
    releaseLock();
    expect(fs.existsSync(join(TEST_HOME, "daemon-process.lock"))).toBe(false);
    expect(fs.existsSync(join(TEST_HOME, "daemon-state.json"))).toBe(false);
    // Second call is a no-op.
    expect(() => releaseLock()).not.toThrow();
  });

  test("readState returns null on missing or corrupt files", async () => {
    const { readState } = await import("../../server/services/daemon-state");
    expect(readState()).toBeNull();
    fs.mkdirSync(TEST_HOME, { recursive: true });
    fs.writeFileSync(join(TEST_HOME, "daemon-state.json"), "not json");
    expect(readState()).toBeNull();
    fs.writeFileSync(
      join(TEST_HOME, "daemon-state.json"),
      JSON.stringify({ pid: "string-not-num" }),
    );
    expect(readState()).toBeNull();
  });

  test("atomic write: tmp file gone after rename", async () => {
    const { acquireLock, writeState } = await import("../../server/services/daemon-state");
    acquireLock();
    writeState(3333);
    const dir = fs.readdirSync(TEST_HOME);
    expect(dir.some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  test("uptimeMsSince computes a non-negative duration", async () => {
    const { uptimeMsSince } = await import("../../server/services/daemon-state");
    const past = new Date(Date.now() - 1000).toISOString();
    expect(uptimeMsSince(past)).toBeGreaterThanOrEqual(900);
    const future = new Date(Date.now() + 5_000).toISOString();
    expect(uptimeMsSince(future)).toBe(0);
  });
});
