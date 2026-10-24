/**
 * The side-call ledger: every `complete()` leaves a priced row, and recording
 * it never touches the answer.
 *
 * Runs the real migration on a real SQLite: the row is only worth something if
 * the columns it writes exist in the schema production runs.
 *
 * @covers USAGE-24
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";
import type { AIProvider, CompletionOptions, CompletionResult } from "../providers/types";
import { createProvider } from "../providers";
import { configureSideCallLedger, formatSideCallLog, meterCompletions, recordSideCall, sideCallOf } from "./side-calls";

const MIGRATIONS = join(import.meta.dir, "..", "db", "migrations");

function ledgerDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE usage_records (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), timestamp INTEGER NOT NULL,
    session_key TEXT NOT NULL, topic_id TEXT, model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0.0)`);
  db.run(readFileSync(join(MIGRATIONS, "20261024140000-usage-records-side-calls.sql"), "utf8"));
  return db;
}

/** A provider that answers with a fixed result, as the CLI or native engine would. */
function fakeProvider(result: CompletionResult | Error): AIProvider {
  return {
    name: "fake",
    defaultModel: () => "claude-sonnet-5-5",
    complete: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as AIProvider;
}

afterEach(() => configureSideCallLedger(null));

describe("sideCallOf", () => {
  test("the provider's own price wins", () => {
    const call = sideCallOf({
      provider: "claude-code",
      options: { purpose: "card-title" },
      result: { content: "x", usage: { promptTokens: 12_813, completionTokens: 21, cacheCreationTokens: 12_810, cacheCreation1hTokens: 12_810, model: "claude-sonnet-5-5", costUsd: 0.0794 } },
      fallbackModel: "",
      durationMs: 900,
      at: 1,
    });
    expect(call?.costUsd).toBe(0.0794);
    expect(call?.purpose).toBe("card-title");
    expect(call?.model).toBe("claude-sonnet-5-5");
  });

  test("without a price the shares are priced with the table, writes at their TTL", () => {
    // Haiku 5.5: input 0.1, output 0.5, read 0.1x. One-hour write = 2x input.
    const call = sideCallOf({
      provider: "native",
      options: { model: "claude-haiku-5-5" },
      result: { content: "x", usage: { promptTokens: 1_000_000 + 10_000 + 20_000, completionTokens: 100_000, cacheReadTokens: 10_000, cacheCreationTokens: 20_000, cacheCreation1hTokens: 20_000, requests: 100 } },
      fallbackModel: "",
      durationMs: 1,
      at: 1,
    });
    // fresh 1M x 0.1 + read 10k x 0.01 + write1h 20k x 0.2 + out 100k x 0.5
    expect(call?.costUsd).toBeCloseTo(0.1 + 0.0001 + 0.004 + 0.05, 6);
    expect(call?.purpose).toBe("other");
    expect(call?.cacheCreation1hTokens).toBe(20_000);
  });

  test("no usage, no row: nothing is invented", () => {
    expect(sideCallOf({ provider: "x", options: undefined, result: { content: "x" }, fallbackModel: "m", durationMs: 1, at: 1 })).toBeNull();
  });

  test("the log line carries the fresh share, not the prompt total", () => {
    const line = formatSideCallLog({
      at: 0, purpose: "card-title", provider: "claude-code", model: "claude-sonnet-5-5",
      promptTokens: 12_813, completionTokens: 21, cacheReadTokens: 0, cacheCreationTokens: 12_810,
      cacheCreation1hTokens: 12_810, costUsd: 0.0794, durationMs: 900,
    });
    expect(line).toBe("[sidecall] at=1970-01-01T00:00:00.000Z purpose=card-title provider=claude-code model=claude-sonnet-5-5 input=3 cache_read=0 cache_write=12810 cache_write_1h=12810 output=21 usd=0.0794 ms=900");
  });
});

describe("recordSideCall and meterCompletions", () => {
  test("a metered completion writes one row with its purpose and shares", async () => {
    const db = ledgerDb();
    configureSideCallLedger(db);
    const result: CompletionResult = { content: "Titolo", usage: { promptTokens: 12_813, completionTokens: 21, cacheReadTokens: 0, cacheCreationTokens: 12_810, cacheCreation1hTokens: 12_810, model: "claude-sonnet-5-5", costUsd: 0.0794 } };
    const provider = meterCompletions(fakeProvider(result));

    const out = await provider.complete([{ role: "user", content: "t" }], { purpose: "card-title" } as CompletionOptions);

    expect(out).toBe(result);
    const rows = db.query(`SELECT session_key, purpose, provider, model, input_tokens, output_tokens, total_tokens, cost_usd,
      cache_read_tokens, cache_creation_tokens, cache_creation_1h_tokens FROM usage_records`).all();
    expect(rows).toEqual([{
      session_key: "side-call", purpose: "card-title", provider: "fake", model: "claude-sonnet-5-5",
      input_tokens: 12_813, output_tokens: 21, total_tokens: 12_834, cost_usd: 0.0794,
      cache_read_tokens: 0, cache_creation_tokens: 12_810, cache_creation_1h_tokens: 12_810,
    }]);
  });

  test("a broken ledger does not break the call", async () => {
    const db = ledgerDb();
    db.close();
    configureSideCallLedger(db);
    const result: CompletionResult = { content: "ok", usage: { promptTokens: 1, completionTokens: 1 } };
    const out = await meterCompletions(fakeProvider(result)).complete([{ role: "user", content: "t" }]);
    expect(out).toBe(result);
  });

  test("a failed call propagates its error and writes nothing", async () => {
    const db = ledgerDb();
    configureSideCallLedger(db);
    const provider = meterCompletions(fakeProvider(new Error("boom")));
    const error = await provider.complete([{ role: "user", content: "t" }]).then(() => null, (e: Error) => e);
    expect(error?.message).toBe("boom");
    expect(db.query(`SELECT COUNT(*) AS n FROM usage_records`).get()).toEqual({ n: 0 });
  });

  test("without a ledger the call is only logged", () => {
    expect(() => recordSideCall({
      at: 0, purpose: "other", provider: "x", model: "m", promptTokens: 1, completionTokens: 1,
      cacheReadTokens: 0, cacheCreationTokens: 0, cacheCreation1hTokens: 0, costUsd: 0, durationMs: 0,
    })).not.toThrow();
  });
});

describe("createProvider", () => {
  test("every provider the factory builds is metered", async () => {
    // One door: a caller that builds a provider gets the ledger without asking.
    const db = ledgerDb();
    configureSideCallLedger(db);
    const provider = createProvider({ type: "native", defaultWorkspace: "/tmp" });
    const inner = Object.getPrototypeOf(provider).complete as AIProvider["complete"];
    expect(provider.complete).not.toBe(inner);
  });
});
