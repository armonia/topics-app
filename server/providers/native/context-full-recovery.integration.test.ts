/**
 * A FULL CONTEXT MUST NOT KILL THE CHAT.
 *
 * -- The defect (card 18bdf214, measured on the live database) ---------------
 * Two topics on the native runtime stopped answering and never recovered.
 * Every send ended in:
 *
 *   [StreamWS] Error for topic:6b9605e5: API 400
 *   {"type":"invalid_request_error","message":"prompt is too long:
 *    1000176 tokens > 1000000 maximum"}
 *
 * Compaction was not being skipped: `compaction_markers` still holds its
 * receipt for that topic, `pre=1115713 -> post=480494`. Compaction REPORTED
 * success while producing a request still twice the ceiling, because it
 * assumed 4 characters per token on content that makes 1.9, and because it
 * emptied tool results while leaving their ARGUMENTS whole, and those were 77%
 * of the remaining weight.
 *
 * From there the chat was dead for good: a 400 is not retryable
 * (`classifyFailure` rules it "give-up", and rightly so, since the same request
 * earns the same error), the in-memory history stayed identical, and every
 * later message repeated that same error. In the chat: "provider error".
 *
 * This test drives the turn against a fake `fetch` that answers EXACTLY like
 * the real API: first the 400 with the count inside, then a healthy round.
 * What has to happen in between (recalibrate the estimate on the real number,
 * recompact, say so in the chat, redo the round by itself) is the whole point
 * of the card.
 * @covers CHAT-COMPACT-04
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runAgentTurn, type AgentMessage } from "./agent-loop";
import { estimateTokens, DEFAULT_CHARS_PER_TOKEN } from "./compaction";
import type { StreamHandler } from "../types";
import type { RetryPolicy } from "./retry";

const REAL_HOME = process.env.HOME;
let homeDir: string;
let ws: string;
let credentialsPath: string;
const realFetch = globalThis.fetch;

const FAST: RetryPolicy = { maxAttempts: 3, baseMs: 1, capMs: 4, jitter: () => 1 };

function sse(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

/**
 * A healthy round that declares a HUGE but real prompt: this is where the loop
 * learns how many characters make a token in this conversation, without
 * waiting to crash into the ceiling first.
 */
function healthyRound(promptTokens: number): string {
  return sse([
    { type: "message_start", message: { usage: { input_tokens: promptTokens } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "eccomi" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
  ]);
}

/**
 * The REAL characters-per-token ratio on agent content, measured on the live
 * case: 1,921,976 characters for 1,000,176 tokens. It is the number the code
 * assumed to be 4, and that gap is the whole defect.
 */
const REAL_RATIO = 1.92;

/**
 * The fake API, and why it is NOT a script.
 *
 * A script ("answer 400 the first time, 200 the second") would only prove the
 * loop can count to two: it would pass even if recompaction freed nothing.
 * Here the ceiling is REAL. The request is weighed the way the vendor weighs
 * it and refused while it is too big, so the turn only passes if compaction
 * genuinely made it fit.
 */
function apiWithCeiling(maxTokens: number) {
  return (body: string): Response => {
    const tokens = Math.ceil(body.length / REAL_RATIO);
    if (tokens > maxTokens) {
      return new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: `prompt is too long: ${tokens} tokens > ${maxTokens} maximum`,
          },
        }),
        { status: 400 },
      );
    }
    return new Response(healthyRound(tokens), { status: 200 });
  };
}

interface Ledger {
  done: number;
  errors: string[];
  retries: Array<{ reason: string; attempt: number }>;
  compactions: Array<{ preTokens?: number; postTokens?: number }>;
  text: string;
}

function fresh(): Ledger {
  return { done: 0, errors: [], retries: [], compactions: [], text: "" };
}

function handler(reg: Ledger): StreamHandler {
  return {
    onTextDelta: (d) => { reg.text += d; },
    onToolStart: () => {},
    onToolResult: () => {},
    onDone: () => { reg.done++; },
    onError: (e: string) => { reg.errors.push(e); },
    onRetry: (i) => { reg.retries.push({ reason: i.reason, attempt: i.attempt }); },
    onCompaction: (m) => { reg.compactions.push(m) },
  };
}

/**
 * A synthetic history over the ceiling, shaped like the real one: the weight
 * sits in the call ARGUMENTS (the body of the files written), not in the
 * results. It is the shape the old compaction could not lighten.
 */
function historyOverCeiling(rounds: number, argSize: number): AgentMessage[] {
  const h: AgentMessage[] = [{ role: "user", content: "Rifammi il parser da capo." }];
  for (let i = 0; i < rounds; i++) {
    h.push({
      role: "assistant",
      content: [
        { type: "text", text: `Giro ${i}.` },
        { type: "tool_use", id: `t${i}`, name: "write_file", input: { path: `src/f${i}.ts`, content: "x".repeat(argSize) } },
      ],
    });
    h.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "scritto" }] });
  }
  return h;
}

function mountApi(api: (body: string) => Response) {
  let n = 0;
  const bodies: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    bodies.push(body);
    n++;
    return api(body);
  }) as unknown as typeof fetch;
  return { calls: () => n, bodies };
}

describe("una chat col contesto pieno si rimette in moto da sola", () => {
  beforeAll(() => {
    homeDir = mkdtempSync(join(tmpdir(), "ctx-full-home-"));
    ws = mkdtempSync(join(tmpdir(), "ctx-full-ws-"));
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    credentialsPath = join(homeDir, ".claude", ".credentials.json");
    process.env.HOME = homeDir;
  });

  beforeEach(() => {
    writeFileSync(
      credentialsPath,
      JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3_600_000 } }),
    );
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
    for (const d of [homeDir, ws]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* scratch */ } }
  });

  test("il 400 «prompt is too long» non chiude il turno: si compatta e si risponde", async () => {
    const reg = fresh();
    // The haiku ceiling (200k), weighed the way the real API weighs it.
    const s = mountApi(apiWithCeiling(200_000));
    // MANY light rounds, on purpose: once the arguments are lightened, the
    // 4-chars-per-token estimate says "we fit" (~120k tokens) while the API,
    // which counts for real, finds ~250k. The defect in a test tube.
    const history = historyOverCeiling(1_200, 3_000);
    const before = estimateTokens(history);

    const out = await runAgentTurn(
      { model: "claude-haiku-4-5-20251001", history, toolContext: { workspace: ws }, autonomy: "auto-apply", retryPolicy: FAST },
      handler(reg),
    );

    // BEFORE: the turn died here, and so did every later turn.
    expect(reg.errors).toEqual([]);
    expect(out.turnEnd.end).toBe("end_turn");
    expect(reg.text).toBe("eccomi");
    expect(reg.done).toBe(1);
    // The first request was refused by the real ceiling, the second went
    // through: compaction actually made the conversation fit.
    expect(s.calls()).toBe(2);
    expect(Math.ceil(s.bodies[0]!.length / REAL_RATIO)).toBeGreaterThan(200_000);
    expect(Math.ceil(s.bodies[1]!.length / REAL_RATIO)).toBeLessThanOrEqual(200_000);
    // The in-memory history was replaced, so the NEXT turn starts light:
    // that is what takes the chat out of the error loop.
    expect(estimateTokens(history)).toBeLessThan(before / 2);
  });

  test("in chat arriva una frase leggibile, non un failure di rete", async () => {
    const reg = fresh();
    mountApi(apiWithCeiling(200_000));
    await runAgentTurn(
      { model: "claude-haiku-4-5-20251001", history: historyOverCeiling(1_200, 3_000), toolContext: { workspace: ws }, autonomy: "auto-apply", retryPolicy: FAST },
      handler(reg),
    );
    // The live notice that says WHY nothing is moving...
    expect(reg.retries.map((r) => r.reason)).toContain("contesto pieno: compatto e riprovo");
    // ...and the permanent divider in the transcript, with weight before and after.
    expect(reg.compactions.length).toBeGreaterThan(0);
    const m = reg.compactions[reg.compactions.length - 1]!;
    expect(m.postTokens!).toBeLessThan(m.preTokens!);
  });

  test("se il contesto pieno non si sblocca, la resa è leggibile e non si gira a vuoto", async () => {
    // A ceiling no compaction can reach: the turn must GIVE UP after two
    // attempts rather than retry forever.
    const reg = fresh();
    const s = mountApi(apiWithCeiling(500));
    const failure = await runAgentTurn(
      { model: "claude-haiku-4-5-20251001", history: historyOverCeiling(1_200, 3_000), toolContext: { workspace: ws }, autonomy: "auto-apply", retryPolicy: FAST },
      handler(reg),
    ).catch((e: Error) => e);

    // It stops after two recompactions at most, and sooner if one of them
    // frees nothing: the ceiling is not the only brake, the other one is
    // "compacting has stopped helping".
    expect(s.calls()).toBeGreaterThanOrEqual(2);
    expect(s.calls()).toBeLessThanOrEqual(1 + 2);
    const detail = failure instanceof Error ? failure.message : String(failure);
    // Not "API 400: {json}": a sentence saying what happened and what to do.
    expect(detail).toContain("Contesto pieno");
    expect(detail).toContain("Apri una chat nuova");
  });

  test("un giro andato bene calibra la stima, così il 400 non arriva nemmeno", async () => {
    // The part that PREVENTS instead of repairing: the prompt the API says it
    // counted gives the real ratio, and from there on the threshold is judged
    // on a measured number instead of the assumed 4 characters.
    const reg = fresh();
    mountApi(apiWithCeiling(200_000));
    const history = historyOverCeiling(20, 1_000);
    const calibration = { charsPerToken: DEFAULT_CHARS_PER_TOKEN };
    await runAgentTurn(
      { model: "claude-haiku-4-5-20251001", history, calibration, toolContext: { workspace: ws }, autonomy: "auto-apply", retryPolicy: FAST },
      handler(reg),
    );
    expect(reg.errors).toEqual([]);
    // MORE CAUTIOUS than the real ratio, and that is fine: we count the
    // characters of the content, the API also weighs the JSON scaffolding
    // around them. A lower ratio means "I estimate myself heavier", which is
    // the error on the safe side.
    expect(calibration.charsPerToken).toBeLessThan(DEFAULT_CHARS_PER_TOKEN);
    expect(calibration.charsPerToken).toBeLessThanOrEqual(REAL_RATIO);
    expect(calibration.charsPerToken).toBeGreaterThan(1);
  });
});
