/**
 * @covers CCLI-11
 */
import { describe, it, expect, afterAll } from "bun:test";
import { readFileSync, unlinkSync } from "node:fs";
import { writeMcpConfigForSession, topicsMcpBridgeSpec } from "./claude-code";
import { toolsForProfile } from "../mcp/topics-mcp-server";

// writeMcpConfigForSession writes to a real /tmp path (MCP_CONFIG_DIR); we clean
// up the session configs we create. The 'bridge-only' branch is pure — it never
// reads ~/.claude.json — so it's deterministic regardless of the host fleet.
const SESSIONS: string[] = [];
function track(sessionKey: string): string {
  SESSIONS.push(sessionKey);
  return sessionKey;
}
afterAll(() => {
  for (const sk of SESSIONS) {
    const safe = sk.replace(/[^A-Za-z0-9._-]/g, "_");
    try { unlinkSync(`${require("os").tmpdir()}/topics-mcp/${safe}.json`); } catch { /* best-effort */ }
  }
});

describe("writeMcpConfigForSession — bridge-only policy", () => {
  it("emits ONLY the topics bridge with the dispatch profile, strict", () => {
    const sk = track("topic:brdg1234");
    const { path, strict } = writeMcpConfigForSession(sk, { mcpPolicy: "bridge-only" });
    expect(strict).toBe(true); // the fleet is scoped away → CLI uses only this set

    const config = JSON.parse(readFileSync(path, "utf-8"));
    // No inherited servers (exa, context7, gateway…): only the bridge.
    expect(Object.keys(config.mcpServers)).toEqual(["topics"]);
    // The bridge carries --profile=dispatch so it advertises the reduced toolset.
    expect(config.mcpServers.topics.args).toContain("--profile=dispatch");
  });

  it("does NOT set the dispatch profile for the default (inherit) policy", () => {
    const spec = topicsMcpBridgeSpec("topic:plain");
    expect(spec.args).not.toContain("--profile=dispatch");
  });

  it("the dispatch profile is strictly a subset of the full toolset", () => {
    const full = toolsForProfile(undefined).map((t) => t.name);
    const dispatch = toolsForProfile("dispatch").map((t) => t.name);
    expect(dispatch.length).toBeLessThan(full.length);
    // Every dispatch tool exists in the full set (reduction only, never additions).
    for (const t of dispatch) expect(full).toContain(t);
    // Task + browser verification survive; cross-topic navigation does not.
    expect(dispatch).toContain("create_task");
    expect(dispatch).toContain("browser_read_screen");
    expect(dispatch).not.toContain("switch_topic");
    // Il fan-out c'e', sotto il governo della board (agent-census.ts).
    expect(dispatch).toContain("spawn_agent");
  });
});
