/**
 * WHAT THE LOOP ACTUALLY PUTS IN THE REQUEST BODY.
 *
 * Three defects, all invisible from the outside because the body was never
 * asserted on, only the stream that came back:
 *
 *   - `max_tokens` defaulted to 16384, half the CLI's cap: a single
 *     `write_file` above ~16k tokens of output could never succeed here.
 *   - the effort tier became a fixed `budget_tokens` for EVERY model, which the
 *     5 family rejects (the parameter is removed there) and which, at `low`,
 *     sent no thinking at all where thinking cannot be switched off.
 *   - a tool result entered the history whole: two 400k reads in one round
 *     were enough to push a 200k window past its limit, and the 400 repeated
 *     on every later turn of the session.
 *
 * Driven against a fake `fetch`, like `round-cut.test.ts` next door: the body
 * is captured on its way out, the stream coming back is a string.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runAgentTurn, type AgentMessage, type AgentTurnOptions, type Block } from "./agent-loop";
import { RESULT_HEAD_CHARS, RESULT_TAIL_CHARS } from "./compaction";
import type { StreamHandler } from "../types";

const HOME_VERA = process.env.HOME;
let homeDir: string;
let ws: string;
const realFetch = globalThis.fetch;

function sse(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

const healthyRound = sse([
  { type: "message_start", message: { usage: { input_tokens: 10 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fatto" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
]);

/** The model reads a file, then the next round closes the turn. */
const readRound = sse([
  { type: "message_start", message: { usage: { input_tokens: 10 } } },
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_read", name: "read_file", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"big.txt"}' } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } },
]);

const silent: StreamHandler = {
  onTextDelta: () => {},
  onToolStart: () => {},
  onToolResult: () => {},
  onDone: () => {},
  onError: () => {},
};

async function turn(over: Partial<AgentTurnOptions>, ...bodies: string[]) {
  const sent: Array<Record<string, unknown>> = [];
  let n = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    const body = bodies[Math.min(n++, bodies.length - 1)]!;
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  const history: AgentMessage[] = [{ role: "user", content: "vai" }];
  await runAgentTurn(
    { model: "claude-haiku-4-5-20251001", history, toolContext: { workspace: ws }, autonomy: "auto-apply", ...over },
    silent,
  );
  return { sent, history };
}

describe("la forma della richiesta", () => {
  beforeAll(() => {
    homeDir = mkdtempSync(join(tmpdir(), "native-shape-home-"));
    ws = mkdtempSync(join(tmpdir(), "native-shape-ws-"));
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    writeFileSync(
      join(homeDir, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "finto-ma-fresco", refreshToken: "r", expiresAt: Date.now() + 3_600_000 } }),
    );
    // 100k chars: under the tool's own cap, over the per-result budget.
    writeFileSync(join(ws, "big.txt"), Array.from({ length: 2000 }, (_, i) => `riga ${i} ` + "x".repeat(40)).join("\n"));
    process.env.HOME = homeDir;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    if (HOME_VERA === undefined) delete process.env.HOME; else process.env.HOME = HOME_VERA;
    for (const d of [homeDir, ws]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* scratch */ } }
  });

  describe("max_tokens", () => {
    test("senza impostazione e' 64000, il tetto del catalogo CLI, non 16384", async () => {
      const { sent } = await turn({}, healthyRound);
      expect(sent[0]!.max_tokens).toBe(64_000);
    });

    test("un tetto passato dal chiamante viene onorato", async () => {
      const { sent } = await turn({ maxTokens: 32_000 }, healthyRound);
      expect(sent[0]!.max_tokens).toBe(32_000);
    });

    test("su un modello a budget il tetto sale sopra il budget, mai il contrario", async () => {
      const { sent } = await turn({ maxTokens: 8_000, effort: "high" }, healthyRound);
      expect(sent[0]!.thinking).toEqual({ type: "enabled", budget_tokens: 10_000 });
      expect(sent[0]!.max_tokens as number).toBeGreaterThan(10_000);
    });
  });

  describe("effort", () => {
    test("sulla famiglia 5 va adaptive + output_config.effort, e low resta un pensiero", async () => {
      const { sent } = await turn({ model: "claude-opus-5", effort: "low" }, healthyRound);
      expect(sent[0]!.thinking).toEqual({ type: "adaptive" });
      expect(sent[0]!.output_config).toEqual({ effort: "low" });
      expect(JSON.stringify(sent[0])).not.toContain("budget_tokens");
    });

    test("la finestra lunga non cambia la generazione: l'id nudo va all'API, il thinking e' adaptive", async () => {
      const { sent } = await turn({ model: "claude-sonnet-5[1m]", effort: "xhigh" }, healthyRound);
      expect(sent[0]!.model).toBe("claude-sonnet-5");
      expect(sent[0]!.thinking).toEqual({ type: "adaptive" });
      expect(sent[0]!.output_config).toEqual({ effort: "xhigh" });
    });

    test("su un modello vecchio resta budget_tokens e nessun output_config", async () => {
      const { sent } = await turn({ effort: "medium" }, healthyRound);
      expect(sent[0]!.thinking).toEqual({ type: "enabled", budget_tokens: 4_000 });
      expect("output_config" in sent[0]!).toBe(false);
    });
  });

  describe("i risultati dei tool", () => {
    test("un risultato enorme entra nella storia a testa e coda, con il cartello", async () => {
      const { history } = await turn({}, readRound, healthyRound);
      const results = history[2]!.content as Block[];
      expect(results[0]!.type).toBe("tool_result");
      const body = String(results[0]!.content);
      expect(body.length).toBeLessThan(RESULT_HEAD_CHARS + RESULT_TAIL_CHARS + 200);
      expect(body).toContain("chars omitted");
      expect(body).toContain("riga 0 ");
      expect(body).toContain("riga 1999 ");
    });
  });
});
