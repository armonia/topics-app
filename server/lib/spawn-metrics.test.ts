import { describe, expect, test } from "bun:test";
import { recordServerSpawn, serverSpawnCounts } from "./spawn-metrics";

describe("server process counters", () => {
  test("groups recent spawns by cause and drops events outside the window", () => {
    const now = Date.now();
    const before = serverSpawnCounts(now).counts.gitStatus.watcher ?? 0;
    recordServerSpawn("gitStatus", "watcher", now - 1000);
    recordServerSpawn("gitStatus", "watcher", now - 1000);
    recordServerSpawn("lsof", "detectionCwd", now - 16 * 60_000);
    const snapshot = serverSpawnCounts(now);
    expect(snapshot.windowMinutes).toBe(15);
    expect(snapshot.counts.gitStatus.watcher).toBe(before + 2);
    expect(snapshot.counts.lsof.detectionCwd).toBeUndefined();
  });
});
