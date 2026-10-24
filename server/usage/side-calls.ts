/**
 * The ledger of side calls: every `complete()` a provider answers, priced and
 * written down under what it was for.
 *
 * WHY IT EXISTS. A chat turn leaves its cost on the message row; a call made
 * OUTSIDE a turn (a card title, a goal judge, a commit message) left nothing.
 * `usage_records` had zero rows and the native engine dropped the usage of
 * `complete()` on the floor. On 9-12/10 the board created 1119 cards and 1102
 * of them got a title from Sonnet 5.5, each one writing its prompt to the
 * one-hour cache (14.1M tokens in four days): tens of dollars of subscription
 * quota, visible only by reading CLI transcripts one by one.
 *
 * ONE DOOR. `meterCompletions` wraps the provider's `complete` where providers
 * are made (`providers/index.ts:createProvider`), so a caller cannot forget it:
 * a new side call is metered the day it is written, and filed as "other" until
 * it says what it is (`CompletionOptions.purpose`).
 *
 * EVERY CALL, measured or not. A provider that reports no usage (ACP has none
 * on the wire) still leaves a row, with the tokens and the cost NULL and
 * `measured = 0`: a missing row would make the count lie low without saying
 * so. A call that fails or throws leaves a row too, with its reason, because a
 * CLI that dies late has already spent its tokens.
 *
 * TWO TRACES. A row in `usage_records` (what `/api/usage/projects` sums) and a
 * `[sidecall]` line in the server log, in the same shape as `[native] round:`,
 * so a measurement can be taken from the log alone.
 */
import type { Database } from "bun:sqlite";
import type { AIProvider, CompletionOptions, CompletionResult } from "../providers/types";
import { calculateCostWithCache, modelPrice } from "./pricing";

let ledger: Database | null = null;

/** Where rows go. Unset (tests, scripts) = log line only. */
export function configureSideCallLedger(db: Database | null): void {
  ledger = db;
}

export interface SideCall {
  at: number;
  purpose: string;
  provider: string;
  model: string;
  /** The chat the call answered, when it answered one (`CompletionOptions.sessionKey`). */
  sessionKey?: string;
  /** False when the provider reported no usage: every count below is then null. */
  measured: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  cacheCreation1hTokens: number | null;
  /** Null when not measured, or when the model has no price: never a zero that reads as free. */
  costUsd: number | null;
  durationMs: number;
  /** Why the call failed, when it did. */
  error?: string;
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * One call, priced. The provider's own price wins when it sends one (the CLI's
 * `total_cost_usd`, the native engine's rounds); otherwise the shares are
 * priced with the same table as a chat turn. Without a usage nothing is
 * invented: the row says "not measured".
 *
 * `runModel` is the model the call ran on as the PROVIDER knows it
 * (`completionModel`), used when the answer does not name its own.
 */
export function sideCallOf(args: {
  provider: string;
  options: CompletionOptions | undefined;
  result: CompletionResult | null;
  /** The error a call threw, when it threw. */
  thrown?: unknown;
  runModel: string;
  durationMs: number;
  at: number;
}): SideCall {
  const u = args.result?.usage;
  const model = u?.model || args.runModel || "unknown";
  const failure = args.thrown !== undefined ? errorText(args.thrown) : args.result?.error;
  const base = {
    at: args.at,
    purpose: args.options?.purpose ?? "other",
    provider: args.provider,
    model,
    ...(args.options?.sessionKey ? { sessionKey: args.options.sessionKey } : {}),
    durationMs: args.durationMs,
    ...(failure ? { error: failure.slice(0, 200) } : {}),
  };
  if (!u) {
    return {
      ...base,
      measured: false,
      promptTokens: null,
      completionTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      cacheCreation1hTokens: null,
      costUsd: null,
    };
  }
  const read = n(u.cacheReadTokens);
  const write = n(u.cacheCreationTokens);
  const write1h = Math.min(n(u.cacheCreation1hTokens), write);
  const own = typeof u.costUsd === "number" && Number.isFinite(u.costUsd) ? Math.max(0, u.costUsd) : null;
  const costUsd = own ?? (modelPrice(model)
    ? calculateCostWithCache({
      model,
      freshInputTokens: Math.max(0, n(u.promptTokens) - read - write),
      outputTokens: n(u.completionTokens),
      cacheReadTokens: read,
      cacheCreationTokens: write - write1h,
      cacheCreation1hTokens: write1h,
    })
    : null);
  return {
    ...base,
    measured: true,
    promptTokens: n(u.promptTokens),
    completionTokens: n(u.completionTokens),
    cacheReadTokens: read,
    cacheCreationTokens: write,
    cacheCreation1hTokens: write1h,
    costUsd,
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function formatSideCallLog(c: SideCall): string {
  const head = `[sidecall] at=${new Date(c.at).toISOString()} purpose=${c.purpose} provider=${c.provider} model=${c.model}`
    + (c.sessionKey ? ` session=${c.sessionKey}` : "");
  const body = c.measured
    ? ` input=${(c.promptTokens ?? 0) - (c.cacheReadTokens ?? 0) - (c.cacheCreationTokens ?? 0)} cache_read=${c.cacheReadTokens} `
      + `cache_write=${c.cacheCreationTokens} cache_write_1h=${c.cacheCreation1hTokens} output=${c.completionTokens} `
      + `usd=${c.costUsd === null ? "?" : c.costUsd.toFixed(4)}`
    : " unmeasured";
  return `${head}${body} ms=${c.durationMs}${c.error ? ` failed=${JSON.stringify(c.error)}` : ""}`;
}

/**
 * Writes the log line and, when a ledger is set, the row. A call that answered
 * a chat takes that chat's `session_key` and `topic_id`; the others are filed
 * under `side-call`, with no topic.
 */
export function recordSideCall(c: SideCall): void {
  console.log(formatSideCallLog(c));
  if (!ledger) return;
  // `query` keeps the compiled statement on the connection: one parse per
  // process, not one per title.
  ledger.query(
    `INSERT INTO usage_records (timestamp, session_key, topic_id, model, input_tokens, output_tokens, total_tokens, cost_usd,
       purpose, provider, cache_read_tokens, cache_creation_tokens, cache_creation_1h_tokens, duration_ms, measured, error)
     VALUES (?, ?, (SELECT id FROM topics WHERE session_key = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    c.at, c.sessionKey ?? "side-call", c.sessionKey ?? null, c.model,
    c.promptTokens, c.completionTokens, c.measured ? (c.promptTokens ?? 0) + (c.completionTokens ?? 0) : null, c.costUsd,
    c.purpose, c.provider, c.cacheReadTokens, c.cacheCreationTokens, c.cacheCreation1hTokens, c.durationMs,
    c.measured ? 1 : 0, c.error ?? null,
  );
}

/**
 * Wraps `provider.complete` so every call is recorded, the ones that fail
 * included. The wrapper hands back the result (or the error) untouched, and
 * the write happens on a later turn of the event loop: the caller resumes
 * first, so a busy database cannot delay a title, and a broken one cannot
 * fail it.
 */
export function meterCompletions<P extends AIProvider>(provider: P): P {
  const inner = provider.complete.bind(provider);
  provider.complete = async (messages, options) => {
    const started = Date.now();
    let result: CompletionResult | null = null;
    let thrown: unknown;
    try {
      const answer = await inner(messages, options);
      result = answer;
      return answer;
    } catch (err) {
      thrown = err ?? new Error("complete() rejected");
      throw err;
    } finally {
      const durationMs = Date.now() - started;
      setImmediate(() => {
        try {
          recordSideCall(sideCallOf({
            provider: provider.name,
            options,
            result,
            thrown,
            runModel: runModelOf(provider, options),
            durationMs,
            at: started,
          }));
        } catch (err) {
          // The measure never stops the work: a broken ledger costs a row, not a title.
          console.warn(`[sidecall] not recorded: ${errorText(err)}`);
        }
      });
    }
  };
  return provider;
}

/**
 * The model the call ran on: the provider's own answer when it has one (the
 * CLI's one-shots do not run on the chat default), else the model asked for,
 * else the provider's default.
 */
function runModelOf(provider: AIProvider, options: CompletionOptions | undefined): string {
  try {
    return provider.completionModel?.(options) || options?.model || provider.defaultModel?.() || "";
  } catch {
    return options?.model ?? "";
  }
}
