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
 * TWO TRACES. A row in `usage_records` (what `/api/usage/projects` sums) and a
 * `[sidecall]` line in the server log, in the same shape as `[native] round:`,
 * so a measurement can be taken from the log alone.
 */
import type { Database } from "bun:sqlite";
import type { AIProvider, CompletionOptions, CompletionResult } from "../providers/types";
import { calculateCostWithCache } from "./pricing";

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
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheCreation1hTokens: number;
  costUsd: number;
  durationMs: number;
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * One call, priced. The provider's own price wins when it sends one (the CLI
 * does, `total_cost_usd`); otherwise the shares are priced with the same table
 * as a chat turn. Without a usage there is nothing to say, and nothing is
 * invented.
 */
export function sideCallOf(args: {
  provider: string;
  options: CompletionOptions | undefined;
  result: CompletionResult;
  fallbackModel: string;
  durationMs: number;
  at: number;
}): SideCall | null {
  const u = args.result.usage;
  if (!u) return null;
  const model = u.model || args.options?.model || args.fallbackModel || "unknown";
  const read = n(u.cacheReadTokens);
  const write = n(u.cacheCreationTokens);
  const write1h = Math.min(n(u.cacheCreation1hTokens), write);
  const costUsd = typeof u.costUsd === "number" && Number.isFinite(u.costUsd)
    ? Math.max(0, u.costUsd)
    : calculateCostWithCache({
      model,
      freshInputTokens: Math.max(0, n(u.promptTokens) - read - write),
      outputTokens: n(u.completionTokens),
      cacheReadTokens: read,
      cacheCreationTokens: write - write1h,
      cacheCreation1hTokens: write1h,
    });
  return {
    at: args.at,
    purpose: args.options?.purpose ?? "other",
    provider: args.provider,
    model,
    promptTokens: n(u.promptTokens),
    completionTokens: n(u.completionTokens),
    cacheReadTokens: read,
    cacheCreationTokens: write,
    cacheCreation1hTokens: write1h,
    costUsd,
    durationMs: args.durationMs,
  };
}

export function formatSideCallLog(c: SideCall): string {
  return `[sidecall] at=${new Date(c.at).toISOString()} purpose=${c.purpose} provider=${c.provider} model=${c.model} `
    + `input=${c.promptTokens - c.cacheReadTokens - c.cacheCreationTokens} cache_read=${c.cacheReadTokens} `
    + `cache_write=${c.cacheCreationTokens} cache_write_1h=${c.cacheCreation1hTokens} output=${c.completionTokens} `
    + `usd=${c.costUsd.toFixed(4)} ms=${c.durationMs}`;
}

/** Writes the log line and, when a ledger is set, the row. */
export function recordSideCall(c: SideCall): void {
  console.log(formatSideCallLog(c));
  if (!ledger) return;
  ledger.prepare(
    `INSERT INTO usage_records (timestamp, session_key, model, input_tokens, output_tokens, total_tokens, cost_usd,
       purpose, provider, cache_read_tokens, cache_creation_tokens, cache_creation_1h_tokens, duration_ms)
     VALUES (?, 'side-call', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    c.at, c.model, c.promptTokens, c.completionTokens, c.promptTokens + c.completionTokens, c.costUsd,
    c.purpose, c.provider, c.cacheReadTokens, c.cacheCreationTokens, c.cacheCreation1hTokens, c.durationMs,
  );
}

/**
 * Wraps `provider.complete` so every answer is recorded. The wrapper returns the
 * result untouched and records AFTER it, so a slow or broken ledger cannot
 * delay or fail a title. A call that throws has no usage to record.
 */
export function meterCompletions<P extends AIProvider>(provider: P): P {
  const inner = provider.complete.bind(provider);
  provider.complete = async (messages, options) => {
    const started = Date.now();
    const result = await inner(messages, options);
    try {
      const call = sideCallOf({
        provider: provider.name,
        options,
        result,
        fallbackModel: safeDefaultModel(provider),
        durationMs: Date.now() - started,
        at: started,
      });
      if (call) recordSideCall(call);
    } catch (err) {
      // The measure never stops the work: a broken ledger costs a row, not a title.
      console.warn(`[sidecall] not recorded: ${(err as Error)?.message ?? err}`);
    }
    return result;
  };
  return provider;
}

function safeDefaultModel(provider: AIProvider): string {
  try { return provider.defaultModel?.() ?? ""; } catch { return ""; }
}
