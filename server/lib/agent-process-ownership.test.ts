/** @covers KANBAN-78 */
import { readFileSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  AGENT_OWNER_ENV,
  AGENT_PROCESS_GRACE_MS,
  closedOwnersFromPs,
  ownedProcessTargetsFromPs,
  parseOwnerProcessTable,
  readOwnerProcessTable,
  reconcileOwnedAgentProcesses,
  stopOwnedAgentProcesses,
  verifiedOwnerProcessTable,
  withAgentProcessOwner,
  type OwnerProcessStopDeps,
} from "./agent-process-ownership";

const serverPid = 7000;
const baseTable = [
  "1 0 1 /sbin/launchd",
  `${serverPid + 1} 1 ${serverPid + 1} /usr/libexec/supervisor`,
  `${serverPid} ${serverPid + 1} ${serverPid + 1} bun server.ts`,
  `${serverPid + 2} ${serverPid} ${serverPid + 1} node TOPICS_OWNER=topic:alpha`,
  "8000 1 8000 node TOPICS_OWNER=topic:alpha",
  "8001 1 8001 node TOPICS_OWNER=topic:beta",
  "8002 1 8002 node without-owner",
].join("\n");

const ownerTable = (pid: number, owner: string, pgid = pid) => [
  "1 0 1 /sbin/launchd",
  `${serverPid + 1} 1 ${serverPid + 1} /usr/libexec/supervisor`,
  `${serverPid} ${serverPid + 1} ${serverPid + 1} bun server.ts`,
  `${pid} 1 ${pgid} bun -e TOPICS_OWNER=${owner}`,
].join("\n");

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function canReadMarkedEnvironment(): Promise<boolean> {
  const owner = `topic:ps-probe-${crypto.randomUUID()}`;
  const probe = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    env: withAgentProcessOwner({ PATH: process.env.PATH ?? "/usr/bin:/bin" }, owner),
    stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true,
  });
  try {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const table = await readOwnerProcessTable();
      if (table === null) return false;
      if (ownedProcessTargetsFromPs(table, new Set([owner]), process.pid)?.pids.includes(probe.pid)) return true;
      await Bun.sleep(50);
    }
    return false;
  } finally {
    if (pidAlive(probe.pid)) { try { process.kill(probe.pid, "SIGKILL"); } catch {} }
  }
}

const psEnvironmentReadable = await canReadMarkedEnvironment();
if (!psEnvironmentReadable) {
  console.warn("[SKIP agent ownership integration] ps -E plus KERN_PROCARGS2 did not expose TOPICS_OWNER on Bun in this runtime");
}

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, "utf8").trim();
    await Bun.sleep(25);
  }
  throw new Error(`child did not write ${path}`);
}

async function waitForPidToExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await Bun.sleep(25);
  }
  return !pidAlive(pid);
}

describe("agent process ownership", () => {
  test("tags only the requested owner and parses process rows", () => {
    expect(AGENT_OWNER_ENV).toBe("TOPICS_OWNER");
    expect(AGENT_PROCESS_GRACE_MS).toBe(10_000);
    expect(withAgentProcessOwner({ PATH: "/bin" }, "topic:alpha")).toEqual({ PATH: "/bin", TOPICS_OWNER: "topic:alpha" });
    expect(parseOwnerProcessTable(baseTable)).toHaveLength(7);
    expect(closedOwnersFromPs(baseTable, (key) => key === "topic:beta", serverPid)).toEqual(["topic:alpha"]);
  });

  test("targets marked pids without signalling the server's protected process groups", () => {
    expect(ownedProcessTargetsFromPs(baseTable, new Set(["topic:alpha"]), serverPid)).toEqual({
      pids: [serverPid + 2, 8000],
      pgids: [8000],
    });
    expect(ownedProcessTargetsFromPs(baseTable, new Set(["topic:beta"]), serverPid)).toEqual({
      pids: [8001],
      pgids: [8001],
    });
  });

  test("an argv lookalike is not accepted as process ownership", () => {
    const raw = `${baseTable}\n8003 1 8003 bun -e TOPICS_OWNER=topic:alpha`;
    const verified = verifiedOwnerProcessTable(raw, new Map([
      [serverPid + 2, "topic:alpha"],
      [8000, "topic:alpha"],
      [8001, "topic:beta"],
    ]));
    const rows = parseOwnerProcessTable(verified);
    expect(rows.find((row) => row.pid === 8003)?.owner).toBeNull();
    expect(ownedProcessTargetsFromPs(verified, new Set(["topic:alpha"]), serverPid)?.pids).toEqual([serverPid + 2, 8000]);
  });

  test("boot closes owners absent from live topics and keeps another session", async () => {
    const signals: Array<[number, string]> = [];
    const rows = [
      "1 0 1 /sbin/launchd",
      `${serverPid + 1} 1 ${serverPid + 1} /usr/libexec/supervisor`,
      `${serverPid} ${serverPid + 1} ${serverPid + 1} bun server.ts`,
      "8100 1 8100 bun TOPICS_OWNER=topic:deleted",
      "8101 1 8101 bun TOPICS_OWNER=topic:live",
      "8102 1 8102 bun TOPICS_OWNER=terminal:dormant",
    ].join("\n");
    const stopped = await reconcileOwnedAgentProcesses((key) => key === "topic:live" || key === "terminal:dormant", {
      serverPid,
      scan: async () => rows,
      signal: (pid, sig) => signals.push([pid, sig]),
      wait: async () => {},
      graceMs: 0,
    });
    expect(stopped).toBe(1);
    expect(signals).toEqual([[-8100, "SIGTERM"], [8100, "SIGTERM"], [-8100, "SIGKILL"], [8100, "SIGKILL"]]);
  });

  test("a missing or failed ps scan signals nothing", async () => {
    const signals: Array<[number, string]> = [];
    const deps: OwnerProcessStopDeps = {
      serverPid,
      scan: async () => null,
      signal: (pid, sig) => signals.push([pid, sig]),
      wait: async () => {},
    };
    expect(await stopOwnedAgentProcesses(new Set(["topic:alpha"]), deps)).toBe(0);
    await expect(stopOwnedAgentProcesses(new Set(["topic:alpha"]), { ...deps, scan: async () => { throw new Error("ps denied"); } })).resolves.toBe(0);
    expect(signals).toEqual([]);
  });

  test("only still-marked owners receive the delayed KILL", async () => {
    const signals: Array<[number, string]> = [];
    const scans = [ownerTable(8200, "topic:alpha"), ownerTable(8201, "topic:beta")];
    expect(await stopOwnedAgentProcesses(new Set(["topic:alpha"]), {
      serverPid,
      scan: async () => scans.shift() ?? "",
      signal: (pid, sig) => signals.push([pid, sig]),
      wait: async () => {},
      graceMs: 0,
    })).toBe(1);
    expect(signals).toEqual([[-8200, "SIGTERM"], [8200, "SIGTERM"]]);
  });

  test("server boot is wired to the ownership reconciler", () => {
    const source = readFileSync(new URL("../../server.ts", import.meta.url), "utf8");
    expect(source).toContain("import { reconcileOwnedAgentProcesses } from \"./server/lib/agent-process-ownership\"");
    expect(source).toContain("void reconcileOwnedAgentProcesses((sessionKey) => {");
    expect(source).toContain("WHERE terminal.id = ?");
    expect(source).not.toContain("terminal.status = 'active'");
  });

  test.skipIf(!psEnvironmentReadable)("marked CLI Bash descendants and setsid children die while other owners survive", async () => {
    const root = mkdtempSync(join(tmpdir(), "topics-owned-proc-"));
    const sleepFile = join(root, "sleep.pid");
    const pythonFile = join(root, "python.pid");
    const owner = `topic:test-${crypto.randomUUID()}`;
    const carrierSource = [
      'const { spawn } = require("node:child_process");',
      `spawn("/bin/bash", ["-lc", "( nohup sleep 300 </dev/null >/dev/null 2>&1 & echo $! > '${sleepFile}' )"], { stdio: "ignore" });`,
      `spawn("python3", ["-c", ${JSON.stringify(`import os,time; os.setsid(); open(${JSON.stringify(pythonFile)}, 'w').write(str(os.getpid())); time.sleep(300)`)}], { stdio: "ignore" });`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const otherOwner = `topic:other-${crypto.randomUUID()}`;
    const other = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      env: withAgentProcessOwner({ ...process.env }, otherOwner),
      stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true,
    });
    const unmarkedEnv = { ...process.env };
    delete unmarkedEnv[AGENT_OWNER_ENV];
    const unmarked = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      env: unmarkedEnv,
      stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true,
    });
    const carrier = Bun.spawn([process.execPath, "-e", carrierSource], {
      env: withAgentProcessOwner({ ...process.env }, owner),
      stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true,
    });
    let sleepPid: number | null = null;
    let pythonPid: number | null = null;
    try {
      sleepPid = Number(await waitForFile(sleepFile));
      pythonPid = Number(await waitForFile(pythonFile));
      const table = await readOwnerProcessTable();
      if (table === null) throw new Error("ps -E became unavailable after child spawn");
      const targets = ownedProcessTargetsFromPs(table, new Set([owner]), process.pid);
      expect(targets?.pids).toContain(carrier.pid);
      expect(targets?.pids).toContain(pythonPid);
      await stopOwnedAgentProcesses(new Set([owner]), { graceMs: 100 });
      expect(await waitForPidToExit(carrier.pid)).toBe(true);
      expect(await waitForPidToExit(pythonPid)).toBe(true);
      expect(await waitForPidToExit(sleepPid)).toBe(true);
      expect(pidAlive(other.pid)).toBe(true);
      expect(pidAlive(unmarked.pid)).toBe(true);
    } finally {
      for (const pid of [carrier.pid, other.pid, unmarked.pid, sleepPid, pythonPid]) {
        if (pid && pidAlive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
