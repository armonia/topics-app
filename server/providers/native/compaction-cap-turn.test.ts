/**
 * The agent's compaction ceiling means nothing unless the TURN carries it.
 * `compactionThresholds` is proven in `compaction-cap.test.ts`; this drives
 * the real `NativeProvider` against a stubbed Anthropic endpoint and proves
 * the wire: `agent-engine.json` → the agent that owns the workspace → the
 * turn's options (in the server) and the turn's spec (in its own process).
 *
 * @covers CHAT-COMPACT-06
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NativeProvider } from "./provider";
import { runAgentTurn, type AgentMessage } from "./agent-loop";
import { closeMcpFleet } from "./mcp-fleet";
import type { StreamHandler } from "../types";
import type { TurnSpec } from "./turn-host";
import { stopOwnAiBridges } from "../../../scripts/stray-ai-bridges";

const CAP = 30_000;

const answer = [
  { type: "message_start", message: { usage: { input_tokens: 10 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

const REAL_HOME = process.env.HOME;
const realFetch = globalThis.fetch;
const ENV_KEYS = ["DATA_DIR", "TOPICS_AI_BRIDGE_SOCKET", "TOPICS_MCP_CONFIG_FILE", "TOPICS_NATIVE_MCP", "JARVIS_CHANNELS_HOME", "APP_DATA_DIR", "TOPICS_AI_BRIDGE", "TOPICS_NATIVE_DETACHED"];
const envBackup: Record<string, string | undefined> = {};
let home: string;
let agentWorkspace: string;
let otherWorkspace: string;

/**
 * Seven turns of 10k estimated tokens each, in one chat: how many compactions
 * did it see? Seven, not five: the last six messages are never cut, so a
 * shorter chat has no turn old enough to drop and nothing to compact.
 */
async function compactionsOver(workspace: string): Promise<number> {
  globalThis.fetch = (async (url: unknown, init?: unknown) => {
    const target = typeof url === "string" ? url : (url as Request | URL).toString();
    if (!target.endsWith("/v1/messages")) return realFetch(url as never, init as never);
    return new Response(answer, { status: 200 });
  }) as unknown as typeof fetch;
  let compactions = 0;
  const handler: StreamHandler = {
    onTextDelta: () => {}, onToolStart: () => {}, onToolResult: () => {}, onDone: () => {}, onError: () => {},
    onCompaction: () => { compactions++; },
  };
  const provider = new NativeProvider({ type: "native", defaultWorkspace: workspace, model: "claude-haiku-4-5-20251001" });
  for (let i = 0; i < 7; i++) await provider.sendChat(`topic:cap-${workspace}`, `t${i} `.padEnd(40_000, "x"), handler);
  return compactions;
}

/** The spec the provider hands to the turn's own process, captured before it starts. */
async function detachedSpecFor(workspace: string): Promise<TurnSpec> {
  process.env.TOPICS_AI_BRIDGE = "1";
  delete process.env.TOPICS_NATIVE_DETACHED;
  globalThis.fetch = (async () => new Response(answer, { status: 200 })) as unknown as typeof fetch;
  const provider = new NativeProvider({ type: "native", defaultWorkspace: workspace, model: "claude-haiku-4-5-20251001" });
  let captured: TurnSpec | null = null;
  // `null` = "the broker could not start it": the turn then runs in the server, as in production.
  (provider as unknown as { runDetached: (k: string, s: unknown, spec: TurnSpec) => Promise<null> }).runDetached = async (_k, _s, spec) => {
    captured = spec;
    return null;
  };
  try {
    await provider.sendChat(`topic:cap-spec-${workspace}`, "ciao", { onTextDelta: () => {}, onToolStart: () => {}, onToolResult: () => {}, onDone: () => {}, onError: () => {} });
  } finally {
    delete process.env.TOPICS_AI_BRIDGE;
  }
  if (!captured) throw new Error("the provider never built a detached spec");
  return captured;
}

beforeAll(() => {
  for (const k of ENV_KEYS) { envBackup[k] = process.env[k]; delete process.env[k]; }
  home = mkdtempSync(join(tmpdir(), "native-cap-home-"));
  agentWorkspace = mkdtempSync(join(tmpdir(), "native-cap-agent-"));
  otherWorkspace = mkdtempSync(join(tmpdir(), "native-cap-other-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "fake-but-fresh", refreshToken: "r", expiresAt: Date.now() + 3_600_000 } }),
  );
  process.env.HOME = home;
  // Its own state dir: the detached path looks for turns left running there.
  process.env.DATA_DIR = join(home, "data");
  mkdirSync(process.env.DATA_DIR, { recursive: true });
  // The detached path asks the broker for a turn left running: its own socket,
  // and `stopOwnAiBridges` below ends any daemon this file had to spawn.
  process.env.TOPICS_AI_BRIDGE_SOCKET = join(home, "ai-bridge.sock");

  const engineHome = join(home, "jarvis-channels");
  mkdirSync(engineHome, { recursive: true });
  writeFileSync(join(engineHome, "engine.json"), JSON.stringify({ agents: { main: { workspace: agentWorkspace } } }));
  process.env.JARVIS_CHANNELS_HOME = engineHome;

  const appDataDir = join(home, ".topics");
  process.env.APP_DATA_DIR = appDataDir;
  mkdirSync(appDataDir, { recursive: true });
  writeFileSync(join(appDataDir, "agent-engine.json"), JSON.stringify({ agents: { main: { compactAtTokens: CAP } } }));

  // No fleet: the turn's weight is the messages and the coding tools, nothing mounted from the machine.
  process.env.TOPICS_MCP_CONFIG_FILE = join(home, "mcp.json");
  writeFileSync(process.env.TOPICS_MCP_CONFIG_FILE, JSON.stringify({ mcpServers: {} }));
});

afterAll(async () => {
  await stopOwnAiBridges();
  closeMcpFleet();
  globalThis.fetch = realFetch;
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  for (const d of [home, agentWorkspace, otherWorkspace]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* scratch */ } }
});

/** One model round as SSE: a `read_file` call, or the closing answer. */
function round(n: number, last: boolean): string {
  const events = last
    ? [
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fatto" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    ]
    : [
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `tu${n}`, name: "read_file", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ path: "big.txt" }) } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
    ];
  return [{ type: "message_start", message: { usage: { input_tokens: 10 } } }, ...events].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

describe("the agent's ceiling reaches the turn", () => {
  test("THE BARRA: the agent's own chat compacts past its ceiling, an ordinary chat with the same traffic does not", async () => {
    // ~70k estimated tokens by the seventh turn: past a 30k ceiling, far under a 200k window's 170k.
    expect(await compactionsOver(agentWorkspace)).toBeGreaterThan(0);
    expect(await compactionsOver(otherWorkspace)).toBe(0);
  });

  test("the turn's own process gets the ceiling in its spec, and an ordinary chat's spec stays as it was", async () => {
    expect((await detachedSpecFor(agentWorkspace)).compactAtTokens).toBe(CAP);
    expect("compactAtTokens" in (await detachedSpecFor(otherWorkspace))).toBe(false);
  });
});

describe("the ceiling is checked when a turn starts, never mid-turn", () => {
  test("a tool-heavy turn over the ceiling compacts once, and every round still carries the request", async () => {
    // Seven old exchanges of 10k estimated tokens (past a 30k ceiling), then the
    // request, then five rounds that each read a 40k-character file: compacting
    // on every round would cut again and again until the request itself went.
    writeFileSync(join(agentWorkspace, "big.txt"), "r".repeat(40_000));
    const REQUEST = "REQUEST-OF-THIS-TURN: summarise big.txt";
    const history: AgentMessage[] = [];
    for (let i = 0; i < 7; i++) {
      history.push({ role: "user", content: `u${i} `.padEnd(40_000, "u") }, { role: "assistant", content: `a${i} `.padEnd(40_000, "a") });
    }
    history.push({ role: "user", content: REQUEST });
    const bodies: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      bodies.push(String(init?.body ?? ""));
      return new Response(round(bodies.length, bodies.length > 5), { status: 200 });
    }) as unknown as typeof fetch;
    let compactions = 0;
    const out = await runAgentTurn({
      model: "claude-haiku-4-5-20251001", history, sessionId: "topic:cap-midturn",
      toolContext: { workspace: agentWorkspace }, autonomy: "auto-apply", compactAtTokens: CAP,
    }, {
      onTextDelta: () => {}, onToolStart: () => {}, onToolResult: () => {}, onDone: () => {}, onError: () => {},
      onCompaction: () => { compactions++; },
    });
    expect(out.turnEnd.end).toBe("end_turn");
    expect(bodies).toHaveLength(6);
    expect(compactions).toBe(1);
    for (const body of bodies) expect(body).toContain(REQUEST);
  });
});
