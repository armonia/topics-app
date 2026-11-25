/** @covers MACHINE-01 */
import { describe, expect, test } from "bun:test";
import { isNodeAllowedRequest, isTopicsServerAgent, serverAgentHost, shouldLearnNodeDevice } from "./node-scope";

describe("the node scope", () => {
  test("every call a primary makes on its node with the node cookie is open", () => {
    const calls: Array<[string, string]> = [
      ["POST", "/api/nodes/runs"],
      ["GET", "/api/nodes/runs/run-1"],
      ["GET", "/api/nodes/runs/__probe__"],
      ["DELETE", "/api/nodes/runs/run-1"],
      ["GET", "/api/nodes/runs/run-1/bundle"],
      ["GET", "/api/providers/snapshot"],
      ["GET", "/api/version"],
      ["GET", "/api/system/machine-metrics"],
      ["GET", "/api/system/machine-security"],
      ["GET", "/api/system/machine-readout"],
      ["GET", "/api/nodes/worktrees"],
      ["PUT", "/api/nodes/worktree-policy"],
      ["POST", "/api/nodes/worktrees/gc"],
    ];
    for (const [m, p] of calls) expect(isNodeAllowedRequest(p, m), `${m} ${p}`).toBe(true);
  });

  test("what a human does is shut: commands, topics, sessions, pairing, settings, devices, the socket", () => {
    const shut: Array<[string, string]> = [
      ["POST", "/api/sessions/s-1/commands/run"],
      ["POST", "/api/topics"],
      ["POST", "/api/terminal/sessions"],
      ["POST", "/api/auth/pair/approve"],
      ["GET", "/api/auth/pair/pending"],
      ["PATCH", "/api/settings"],
      ["GET", "/api/auth/devices"],
      ["DELETE", "/api/auth/devices/d-1"],
      ["POST", "/api/nodes/delegated-requests/r-1/approve"],
      ["GET", "/api/nodes/delegated-requests"],
      ["PATCH", "/api/nodes/runs/run-1"],
      ["POST", "/api/nodes/runs/run-1/bundle"],
      ["GET", "/api/nodes/runs/run-1/bundle/extra"],
      ["POST", "/api/providers/snapshot"],
      ["GET", "/api/machines/health"],
      ["GET", "/ws"],
      ["DELETE", "/api/nodes/worktrees"],
      ["POST", "/api/nodes/worktree-policy"],
      ["GET", "/api/nodes/worktrees/gc"],
    ];
    for (const [m, p] of shut) expect(isNodeAllowedRequest(p, m), `${m} ${p}`).toBe(false);
  });

  test("a Topics server is told apart by the user agent it sends its nodes, a browser is not one", () => {
    expect(isTopicsServerAgent("Topics/2.4.51 (studio-pc)")).toBe(true);
    expect(serverAgentHost("Topics/2.4.51 (studio-pc)")).toBe("studio-pc");
    for (const ua of [null, "", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X)", "Bun/1.3.0", "curl/8.7.1"]) {
      expect(isTopicsServerAgent(ua)).toBe(false);
      expect(serverAgentHost(ua)).toBeNull();
    }
    expect(shouldLearnNodeDevice("/api/nodes/runs/__probe__", "Topics/2.4.51 (studio-pc)")).toBe(true);
    expect(shouldLearnNodeDevice("/api/topics", "Topics/2.4.51 (studio-pc)")).toBe(false);
    expect(shouldLearnNodeDevice("/api/nodes/runs", "Mozilla/5.0 (Macintosh)")).toBe(false);
  });
});

