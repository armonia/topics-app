/**
 * THE NATIVE RUNTIME SAYS WHEN THE MODEL STARTS REASONING, BEFORE ANY TEXT.
 *
 * The client reserves the reasoning row on `stream:thinking_start` (card
 * 045ef721). The CLI path sent it; this runtime (provider Topics) did not, so
 * the row was born at the end of the turn and pushed the transcript (card
 * 40ea050c). The open and the close of a `thinking` block are the signal,
 * whether or not a summary delta ever arrives.
 *
 * @covers USAGE-20
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runAgentTurn, type AgentMessage } from "./agent-loop";
import type { StreamHandler } from "../types";

const HOME_VERA = process.env.HOME;
let homeDir: string;
let ws: string;
const realFetch = globalThis.fetch;

const sse = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

async function trace(body: string): Promise<string[]> {
  globalThis.fetch = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
  const seen: string[] = [];
  const handler: StreamHandler = {
    onThinkingStart: () => { seen.push("thinking_start"); },
    onThinkingDelta: (t) => { seen.push(`thinking:${t}`); },
    onThinkingEnd: () => { seen.push("thinking_end"); },
    onTextDelta: (t) => { seen.push(`text:${t}`); },
    onToolStart: () => {},
    onToolResult: () => {},
    onDone: () => {},
    onError: (e) => { seen.push(`error:${e}`); },
  };
  const history: AgentMessage[] = [{ role: "user", content: "pensa e rispondi" }];
  await runAgentTurn({ model: "claude-opus-5", history, toolContext: { workspace: ws }, autonomy: "auto-apply" }, handler);
  return seen;
}

describe("the reasoning signal of the native runtime", () => {
  beforeAll(() => {
    homeDir = mkdtempSync(join(tmpdir(), "native-think-home-"));
    ws = mkdtempSync(join(tmpdir(), "native-think-ws-"));
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    writeFileSync(
      join(homeDir, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "fake-but-fresh", refreshToken: "r", expiresAt: Date.now() + 3_600_000 } }),
    );
    process.env.HOME = homeDir;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    if (HOME_VERA === undefined) delete process.env.HOME; else process.env.HOME = HOME_VERA;
    for (const d of [homeDir, ws]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* scratch */ } }
  });

  test("the block opening comes before its text, the closing after it, the answer last", async () => {
    const seen = await trace(sse([
      { type: "message_start", message: { usage: { input_tokens: 10 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "ragiono" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "fatto" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
    ]));
    expect(seen).toEqual(["thinking_start", "thinking:ragiono", "thinking_end", "text:fatto"]);
  });

  test("a reasoning block with no streamed text still announces itself", async () => {
    const seen = await trace(sse([
      { type: "message_start", message: { usage: { input_tokens: 10 } } },
      { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "x" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    ]));
    expect(seen).toEqual(["thinking_start", "thinking_end", "text:ok"]);
  });
});
