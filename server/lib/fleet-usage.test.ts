import { describe, it, expect, beforeEach } from "bun:test";
import {
  parsePsRows,
  summarizeFleet,
  resolveFleetRoots,
  registerFleetSocket,
  _resetFleetSockets,
  type PsRow,
} from "./fleet-usage";

describe("parsePsRows", () => {
  it("keeps the command intact when it contains spaces", () => {
    const rows = parsePsRows(
      "  100     1  12345   3.4 /usr/bin/node /path/to/pty-bridge.js --socket /tmp/topics-pty-bridge-abc.sock\n",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      pid: 100,
      ppid: 1,
      rssKB: 12345,
      cpu: 3.4,
      command: "/usr/bin/node /path/to/pty-bridge.js --socket /tmp/topics-pty-bridge-abc.sock",
    });
  });

  it("skips the header and any malformed line instead of throwing", () => {
    const rows = parsePsRows("  PID  PPID   RSS %CPU COMMAND\n\ngarbage\n 7 1 100 0.0 bun\n");
    expect(rows.map(r => r.pid)).toEqual([7]);
  });
});

describe("resolveFleetRoots", () => {
  beforeEach(_resetFleetSockets);

  it("finds a sidecar by its --socket argument, never by ppid", () => {
    registerFleetSocket("pty-bridge", "/tmp/topics-pty-bridge-abc.sock");
    const rows = parsePsRows(
      [
        " 10 1 1000 0.0 bun run server.ts",
        // launchd-reparented: ppid 1, NOT a descendant of the server
        " 20 1 2000 0.0 node pty-bridge.js --socket /tmp/topics-pty-bridge-abc.sock",
      ].join("\n"),
    );
    expect(resolveFleetRoots(rows, 10)).toEqual([
      { kind: "server", pid: 10 },
      { kind: "pty-bridge", pid: 20 },
    ]);
  });

  it("ignores a sidecar socket belonging to another data instance", () => {
    registerFleetSocket("pty-bridge", "/tmp/topics-pty-bridge-prod.sock");
    const rows = parsePsRows(
      [
        " 10 1 1000 0.0 bun run server.ts",
        " 30 1 9000 0.0 node pty-bridge.js --socket /tmp/topics-pty-bridge-e2e-13334.sock",
      ].join("\n"),
    );
    expect(resolveFleetRoots(rows, 10)).toEqual([{ kind: "server", pid: 10 }]);
  });
});

describe("summarizeFleet", () => {
  const rows: PsRow[] = parsePsRows(
    [
      " 10 1  90000  2.0 bun run server.ts",
      " 20 1  30000  1.0 node pty-bridge.js --socket /tmp/s.sock",
      " 21 20 2000000 40.0 claude",
      " 22 21 500000 10.0 chrome-headless-shell",
      " 40 1  540000 29.0 webrtc-bridge --socket /tmp/w.sock",
      " 99 1  10000  5.0 unrelated-process",
    ].join("\n"),
  );

  it("sums the whole descendant tree of every root, not just the roots", () => {
    const out = summarizeFleet(rows, [
      { kind: "server", pid: 10 },
      { kind: "pty-bridge", pid: 20 },
      { kind: "webrtc-bridge", pid: 40 },
    ]);
    // 90000 + 30000 + 2000000 + 500000 + 540000 KB
    expect(out.memoryMB).toBe(Math.round(90000 / 1024) + Math.round((30000 + 2000000 + 500000) / 1024) + Math.round(540000 / 1024));
    expect(out.processCount).toBe(5);
    expect(out.cpuPercent).toBe(82);
    // The unrelated process is not ours and must not be billed to Topics.
    expect(out.roots.every(r => r.pid !== 99)).toBe(true);
  });

  it("bills a pid to exactly one root even when two roots reach it", () => {
    const out = summarizeFleet(rows, [
      { kind: "pty-bridge", pid: 20 },
      // 21 is already inside 20's tree; adding it as a root must not double count
      { kind: "ai-bridge", pid: 21 },
    ]);
    expect(out.processCount).toBe(3);
    expect(out.memoryMB).toBe(Math.round((30000 + 2000000 + 500000) / 1024));
  });

  it("drops a root that is no longer running", () => {
    const out = summarizeFleet(rows, [
      { kind: "server", pid: 10 },
      { kind: "ai-bridge", pid: 777 },
    ]);
    expect(out.roots.map(r => r.kind)).toEqual(["server"]);
  });
});
