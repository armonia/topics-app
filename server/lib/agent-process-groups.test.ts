/**
 * Persistent ownership and safe termination of agent command groups.
 *
 * @covers CMDRUN-02, CMDRUN-03
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentProcessGroupRegistry } from "./agent-process-groups";
import { readProcessGroupId } from "./process-tree";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function registry(deps: ConstructorParameters<typeof AgentProcessGroupRegistry>[0] = {}) {
  const root = mkdtempSync(join(tmpdir(), "topics-agent-groups-"));
  roots.push(root);
  const file = join(root, "agent-process-groups.json");
  return new AgentProcessGroupRegistry({ ...deps, path: () => file });
}

function isPidGone(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, timeoutMs = 3000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() >= end) return value;
    await Bun.sleep(25);
  }
}

describe("agent process group ownership", () => {
  test("sends KILL after the 10-second grace when TERM is ignored", async () => {
    let clock = 0;
    let alive = true;
    const signals: string[] = [];
    const groups = registry({
      serverPgid: async () => 999,
      groupAlive: () => alive,
      signalGroup: (_pgid, signal) => { signals.push(signal); if (signal === "SIGKILL") alive = false; },
      wait: async (ms) => { clock += ms; },
      now: () => clock,
      pidLstart: () => "leader-start",
    });
    groups.register({ id: "ignore-term", pid: 1200, pgid: 1200, pidLstart: "leader-start", sessionKey: "session:term", topicId: "topic", source: "run_command" });

    expect(await groups.stopForSession("session:term", 10_000)).toBe(1);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(clock).toBe(10_000);
    expect(groups.list()).toEqual([]);
  });

  test("boot cleanup closes a persisted group whose session no longer exists", async () => {
    const child = Bun.spawn(["sh", "-c", "sleep 300"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    try {
      await Bun.sleep(50);
      const path = mkdtempSync(join(tmpdir(), "topics-agent-groups-"));
      roots.push(path);
      const file = join(path, "agent-process-groups.json");
      const first = new AgentProcessGroupRegistry({ path: () => file });
      first.register({ id: "stale", pid: child.pid, pgid: child.pid, sessionKey: "gone", topicId: "topic", source: "run_command" });

      const boot = new AgentProcessGroupRegistry({ path: () => file });
      expect(await boot.reconcile(() => false, 2000)).toBe(1);
      expect(await until(() => isPidGone(child.pid), Boolean)).toBe(true);
      expect(boot.list()).toEqual([]);
    } finally {
      if (!isPidGone(child.pid)) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
      await child.exited.catch(() => {});
    }
  });

  test("does not signal an unregistered group", async () => {
    const child = Bun.spawn(["sh", "-c", "sleep 300"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    try {
      const groups = registry();
      expect(await groups.stopForSession("owner", 10)).toBe(0);
      expect(isPidGone(child.pid)).toBe(false);
    } finally {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
      await child.exited.catch(() => {});
    }
  });

  test("preserves a declared long-lived command through owner closure and boot", async () => {
    let alive = true;
    const signals: string[] = [];
    const groups = registry({
      serverPgid: async () => 999,
      groupAlive: () => alive,
      signalGroup: (_pgid, signal) => { signals.push(signal); if (signal === "SIGTERM") alive = false; },
      pidLstart: () => "leader-start",
    });
    groups.register({
      id: "long-lived", pid: 1300, pgid: 1300, pidLstart: "leader-start",
      sessionKey: "session:server", topicId: "topic", source: "run_command", preserveOnOwnerClose: true,
    });

    expect(await groups.stopForSession("session:server", 0)).toBe(0);
    expect(await groups.reconcile(() => false, 0)).toBe(0);
    expect(signals).toEqual([]);
    expect(groups.list()).toHaveLength(1);

    expect(await groups.stopById("long-lived", 0)).toBe(true);
    expect(signals).toEqual(["SIGTERM"]);
  });

  test("does not adopt or signal a legacy group without a recorded identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "topics-agent-groups-"));
    roots.push(root);
    const file = join(root, "agent-process-groups.json");
    writeFileSync(file, JSON.stringify({ groups: [{
      id: "unverified", pid: 1400, pgid: 1400, sessionKey: "gone", topicId: "topic", source: "run_command",
    }] }));
    const signals: string[] = [];
    const groups = new AgentProcessGroupRegistry({
      path: () => file,
      serverPgid: async () => 999,
      groupAlive: () => true,
      signalGroup: (_pgid, signal) => { signals.push(signal); },
    });

    expect(await groups.reconcile(() => false, 0)).toBe(0);
    expect(signals).toEqual([]);
  });

  test("refuses a group that shares the server process group", async () => {
    const serverPgid = readProcessGroupId(process.pid)!;
    const signals: string[] = [];
    const groups = registry({
      serverPgid: async () => serverPgid,
      groupAlive: () => true,
      signalGroup: (_pgid, signal) => { signals.push(signal); },
      pidLstart: () => "leader-start",
    });
    groups.register({ id: "server-group", pid: serverPgid, pgid: serverPgid, pidLstart: "leader-start", sessionKey: "unsafe", topicId: null, source: "run_command" });

    expect(await groups.stopForSession("unsafe", 10)).toBe(0);
    expect(signals).toEqual([]);
  });
});
