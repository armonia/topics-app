/**
 * @covers KANBAN-20
 */
import { describe, test, expect } from "bun:test";
import { createExternalSessionsService } from "./external-sessions";
import type { ExternalClaudeSession } from "../lib/external-claude-sessions";

const NOW = 1_700_000_000_000;

function session(over: Partial<ExternalClaudeSession> = {}): ExternalClaudeSession {
  return {
    sessionId: "s1",
    cwd: "/repo",
    projectPath: "/repo",
    projectId: "p:/repo",
    branch: "main",
    entrypoint: "cli",
    lastActivityMs: NOW - 1000,
    state: "active",
    transcriptPath: "/t/s1.jsonl",
    ...over,
  };
}

function make(sessions: () => ExternalClaudeSession[], over: Partial<Parameters<typeof createExternalSessionsService>[0]> = {}) {
  const broadcasts: any[] = [];
  let scans = 0;
  let clock = NOW;
  const svc = createExternalSessionsService({
    knownSessionIds: () => [],
    candidatePaths: () => ["/repo"],
    projectIdFor: (p) => `p:${p}`,
    broadcast: (m) => broadcasts.push(m),
    now: () => clock,
    scan: (() => { scans++; return sessions(); }) as any,
    ...over,
  });
  return { svc, broadcasts, scans: () => scans, tick: (ms: number) => { clock += ms; } };
}

describe("external sessions service", () => {
  test("caches the scan within the TTL and re-scans after it", () => {
    const h = make(() => [session()]);
    h.svc.list();
    h.svc.list();
    expect(h.scans()).toBe(1);
    h.tick(11_000);
    h.svc.list();
    expect(h.scans()).toBe(2);
  });

  test("a failing scan keeps the previous census (never reads as 'repo free')", () => {
    let boom = false;
    const h = make(() => { if (boom) throw new Error("fs gone"); return [session()]; }, { log: () => {} });
    expect(h.svc.list()).toHaveLength(1);
    boom = true;
    h.tick(11_000);
    expect(h.svc.activeAt("/repo")).toHaveLength(1);
  });

  test("byProject rolls up counts and the newest activity", () => {
    const h = make(() => [
      session({ sessionId: "a", lastActivityMs: NOW - 1000 }),
      session({ sessionId: "b", lastActivityMs: NOW - 5000, state: "idle" }),
      session({ sessionId: "c", cwd: "/other", projectPath: "/other", projectId: "p:/other" }),
    ]);
    expect(h.svc.byProject()).toEqual([
      { projectId: "p:/repo", projectPath: "/repo", total: 2, active: 1, lastActivityMs: NOW - 1000 },
      { projectId: "p:/other", projectPath: "/other", total: 1, active: 1, lastActivityMs: NOW - 1000 },
    ]);
  });

  test("activeAt matches subdirectories, ignores idle and sibling name prefixes", () => {
    const h = make(() => [
      session({ sessionId: "deep", cwd: "/repo/packages/api" }),
      session({ sessionId: "old", cwd: "/repo", state: "idle" }),
      session({ sessionId: "sibling", cwd: "/repo-old" }),
    ]);
    expect(h.svc.activeAt("/repo").map((s) => s.sessionId)).toEqual(["deep"]);
  });

  test("the poll broadcasts only when the census actually changes", async () => {
    let current = [session()];
    const h = make(() => current);
    const stop = h.svc.start(5);
    expect(h.broadcasts).toHaveLength(1);
    expect(h.broadcasts[0]).toMatchObject({ type: "external-sessions" });

    // Same census re-scanned several times → still one broadcast.
    await Bun.sleep(40);
    expect(h.broadcasts).toHaveLength(1);

    // A state flip IS a change → exactly one more broadcast.
    current = [session({ state: "idle" })];
    await Bun.sleep(40);
    stop();
    expect(h.broadcasts).toHaveLength(2);
    expect(h.broadcasts[1].sessions[0].state).toBe("idle");
  });
});
