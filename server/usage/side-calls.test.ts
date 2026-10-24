/**
 * The side-call ledger: every `complete()` leaves a row and a log line, priced
 * when the provider measured it, said "not measured" when it did not, marked
 * when it failed; and recording it never touches the answer.
 *
 * Runs the real migration on a real SQLite: the row is only worth something if
 * the columns it writes exist in the schema production runs.
 *
 * @covers USAGE-24
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CodexProvider } from "../providers/codex";
import type { AIProvider, CompletionOptions, CompletionResult } from "../providers/types";
import { createProvider } from "../providers";
import { configureSideCallLedger, formatSideCallLog, meterCompletions, recordSideCall, sideCallOf, type SideCall } from "./side-calls";

const MIGRATIONS = join(import.meta.dir, "..", "db", "migrations");

/** `usage_records` as 001 made it, then the ledger migration; `topics` for the chat-bound rows. */
function ledgerDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE usage_records (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), timestamp INTEGER NOT NULL,
    session_key TEXT NOT NULL, topic_id TEXT, model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0.0)`);
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY, session_key TEXT UNIQUE)`);
  db.run(readFileSync(join(MIGRATIONS, "20261024190000-usage-records-side-calls.sql"), "utf8"));
  return db;
}

/** The ledger writes on a later turn of the event loop: wait for it. */
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A provider that answers with a fixed result, as the CLI or native engine would. */
function fakeProvider(result: CompletionResult | Error, extra: Partial<AIProvider> = {}): AIProvider {
  return {
    name: "fake",
    defaultModel: () => "claude-sonnet-5-5",
    complete: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
    ...extra,
  } as unknown as AIProvider;
}

type Row = Record<string, unknown>;
const rowsOf = (db: Database): Row[] => db.query(`SELECT session_key, topic_id, purpose, provider, model, input_tokens, output_tokens,
  total_tokens, cost_usd, cache_read_tokens, cache_creation_tokens, cache_creation_1h_tokens, measured, error FROM usage_records`).all() as Row[];

afterEach(() => configureSideCallLedger(null));

describe("sideCallOf", () => {
  test("the provider's own price wins", () => {
    const call = sideCallOf({
      provider: "claude-code",
      options: { purpose: "card-title" },
      result: { content: "x", usage: { promptTokens: 12_813, completionTokens: 21, cacheCreationTokens: 12_810, cacheCreation1hTokens: 12_810, model: "claude-sonnet-5-5", costUsd: 0.0794 } },
      runModel: "",
      durationMs: 900,
      at: 1,
    });
    expect(call.costUsd).toBe(0.0794);
    expect(call.purpose).toBe("card-title");
    expect(call.model).toBe("claude-sonnet-5-5");
    expect(call.measured).toBe(true);
  });

  test("without a price the shares are priced with the table, writes at their TTL", () => {
    // Haiku 5.5: input 0.1, output 0.5, read 0.1x. One-hour write = 2x input.
    const call = sideCallOf({
      provider: "native",
      options: { model: "claude-haiku-5-5" },
      result: { content: "x", usage: { promptTokens: 1_000_000 + 10_000 + 20_000, completionTokens: 100_000, cacheReadTokens: 10_000, cacheCreationTokens: 20_000, cacheCreation1hTokens: 20_000 } },
      runModel: "claude-haiku-5-5",
      durationMs: 1,
      at: 1,
    });
    // Over 100k of prompt: the long card, 0.5 in and 2.5 out.
    // fresh 1M x 0.5 + read 10k x 0.05 + write1h 20k x 1.0 + out 100k x 2.5
    expect(call.costUsd).toBeCloseTo(0.5 + 0.0005 + 0.02 + 0.25, 6);
    expect(call.purpose).toBe("other");
    expect(call.cacheCreation1hTokens).toBe(20_000);
  });

  test("no usage: a call all the same, its tokens and cost NULL, never zeros", () => {
    const call = sideCallOf({ provider: "acp", options: { purpose: "chat-name" }, result: { content: "x" }, runModel: "m", durationMs: 1, at: 1 });
    expect(call).toMatchObject({
      measured: false, purpose: "chat-name", provider: "acp", model: "m",
      promptTokens: null, completionTokens: null, cacheReadTokens: null, costUsd: null,
    });
  });

  test("a measured call on a model without a price: tokens kept, cost NULL, not zero", () => {
    const call = sideCallOf({ provider: "muse", options: undefined, result: { content: "x", usage: { promptTokens: 58_614, completionTokens: 15, model: "muse-wonder-1.0" } }, runModel: "", durationMs: 1, at: 1 });
    expect(call).toMatchObject({ measured: true, promptTokens: 58_614, completionTokens: 15, costUsd: null });
  });

  test("the log line carries the fresh share, not the prompt total", () => {
    const line = formatSideCallLog({
      at: 0, purpose: "card-title", provider: "claude-code", model: "claude-sonnet-5-5", measured: true,
      promptTokens: 12_813, completionTokens: 21, cacheReadTokens: 0, cacheCreationTokens: 12_810,
      cacheCreation1hTokens: 12_810, costUsd: 0.0794, durationMs: 900,
    });
    expect(line).toBe("[sidecall] at=1970-01-01T00:00:00.000Z purpose=card-title provider=claude-code model=claude-sonnet-5-5 input=3 cache_read=0 cache_write=12810 cache_write_1h=12810 output=21 usd=0.0794 ms=900");
  });

  test("the log line of an unmeasured, failed call says both", () => {
    const line = formatSideCallLog({
      at: 0, purpose: "goal-judge", provider: "codex", model: "gpt-5.6", measured: false,
      promptTokens: null, completionTokens: null, cacheReadTokens: null, cacheCreationTokens: null,
      cacheCreation1hTokens: null, costUsd: null, durationMs: 40, error: "exit 1",
    });
    expect(line).toBe('[sidecall] at=1970-01-01T00:00:00.000Z purpose=goal-judge provider=codex model=gpt-5.6 unmeasured ms=40 failed="exit 1"');
  });
});

describe("recordSideCall and meterCompletions", () => {
  test("a metered completion writes one row with its purpose and shares", async () => {
    const db = ledgerDb();
    configureSideCallLedger(db);
    const result: CompletionResult = { content: "Titolo", usage: { promptTokens: 12_813, completionTokens: 21, cacheReadTokens: 0, cacheCreationTokens: 12_810, cacheCreation1hTokens: 12_810, model: "claude-sonnet-5-5", costUsd: 0.0794 } };
    const provider = meterCompletions(fakeProvider(result));

    const out = await provider.complete([{ role: "user", content: "t" }], { purpose: "card-title" } as CompletionOptions);
    await settled();

    expect(out).toBe(result);
    expect(rowsOf(db)).toEqual([{
      session_key: "side-call", topic_id: null, purpose: "card-title", provider: "fake", model: "claude-sonnet-5-5",
      input_tokens: 12_813, output_tokens: 21, total_tokens: 12_834, cost_usd: 0.0794,
      cache_read_tokens: 0, cache_creation_tokens: 12_810, cache_creation_1h_tokens: 12_810, measured: 1, error: null,
    }]);
  });

  test("a provider without a usage still leaves its row: NULL tokens, measured 0", async () => {
    // Codex before `--json`, ACP always, Muse before its `run.usage`: the call
    // happened and spent something nobody can read. A missing row made the
    // count lie low without saying so.
    const db = ledgerDb();
    configureSideCallLedger(db);
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await meterCompletions(fakeProvider({ content: "Titolo" }, { name: "acp" } as Partial<AIProvider>))
        .complete([{ role: "user", content: "t" }], { purpose: "chat-name", model: "some-acp-model" });
      await settled();
      expect(rowsOf(db)).toEqual([{
        session_key: "side-call", topic_id: null, purpose: "chat-name", provider: "acp", model: "some-acp-model",
        input_tokens: null, output_tokens: null, total_tokens: null, cost_usd: null,
        cache_read_tokens: null, cache_creation_tokens: null, cache_creation_1h_tokens: null, measured: 0, error: null,
      }]);
      expect(log.mock.calls.flat().join("\n")).toContain("provider=acp model=some-acp-model unmeasured");
    } finally {
      log.mockRestore();
    }
  });

  test("a call that answered with a failure leaves a row with its reason", async () => {
    const db = ledgerDb();
    configureSideCallLedger(db);
    const result: CompletionResult = { content: "Error: CLI exited with code 1", error: "exit 1" };
    const out = await meterCompletions(fakeProvider(result)).complete([{ role: "user", content: "t" }], { purpose: "card-title" });
    await settled();
    expect(out).toBe(result);
    expect(rowsOf(db)).toMatchObject([{ purpose: "card-title", measured: 0, error: "exit 1" }]);
  });

  test("a call that throws propagates its error and leaves a row with it", async () => {
    // A CLI that times out may have spent its tokens: the count must see it.
    const db = ledgerDb();
    configureSideCallLedger(db);
    const provider = meterCompletions(fakeProvider(new Error("Completion timed out")));
    const error = await provider.complete([{ role: "user", content: "t" }], { purpose: "goal-judge" }).then(() => null, (e: Error) => e);
    await settled();
    expect(error?.message).toBe("Completion timed out");
    expect(rowsOf(db)).toMatchObject([{ purpose: "goal-judge", measured: 0, input_tokens: null, error: "Completion timed out" }]);
  });

  test("the caller has the answer before the row is written", async () => {
    // The spec says recording never delays the call. A busy database used to
    // hold the title behind a synchronous INSERT.
    const db = ledgerDb();
    configureSideCallLedger(db);
    await meterCompletions(fakeProvider({ content: "ok", usage: { promptTokens: 1, completionTokens: 1 } })).complete([{ role: "user", content: "t" }]);
    expect(db.query(`SELECT COUNT(*) AS n FROM usage_records`).get()).toEqual({ n: 0 });
    await settled();
    expect(db.query(`SELECT COUNT(*) AS n FROM usage_records`).get()).toEqual({ n: 1 });
  });

  test("the statement is compiled once, not once per call", async () => {
    const db = ledgerDb();
    configureSideCallLedger(db);
    const prepare = spyOn(db, "prepare");
    const provider = meterCompletions(fakeProvider({ content: "ok", usage: { promptTokens: 1, completionTokens: 1 } }));
    for (let i = 0; i < 3; i++) await provider.complete([{ role: "user", content: "t" }]);
    await settled();
    expect(db.query(`SELECT COUNT(*) AS n FROM usage_records`).get()).toEqual({ n: 3 });
    // The test's own reads go through `query` too: count the ledger's INSERT only.
    expect(prepare.mock.calls.filter((args) => String(args[0]).includes("INSERT INTO usage_records")).length).toBeLessThanOrEqual(1);
  });

  test("a fallback reply is filed under its chat, with its topic", async () => {
    // It answers a precise chat: `side-call` with no topic counted it among
    // the calls outside chats and kept it out of its project.
    const db = ledgerDb();
    db.run(`INSERT INTO topics (id, session_key) VALUES ('t-1', 'topic:alpha')`);
    configureSideCallLedger(db);
    await meterCompletions(fakeProvider({ content: "hi", usage: { promptTokens: 10, completionTokens: 2 } }))
      .complete([{ role: "user", content: "t" }], { purpose: "chat-reply", sessionKey: "topic:alpha", userFacing: true });
    await settled();
    expect(rowsOf(db)).toMatchObject([{ session_key: "topic:alpha", topic_id: "t-1", purpose: "chat-reply" }]);
  });

  test("a broken ledger does not break the call", async () => {
    const db = ledgerDb();
    db.close();
    configureSideCallLedger(db);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result: CompletionResult = { content: "ok", usage: { promptTokens: 1, completionTokens: 1 } };
      const out = await meterCompletions(fakeProvider(result)).complete([{ role: "user", content: "t" }]);
      await settled();
      expect(out).toBe(result);
      expect(warn.mock.calls.flat().join(" ")).toContain("[sidecall] not recorded");
    } finally {
      warn.mockRestore();
    }
  });

  test("without a ledger the call is only logged", () => {
    const call: SideCall = {
      at: 0, purpose: "other", provider: "x", model: "m", measured: true, promptTokens: 1, completionTokens: 1,
      cacheReadTokens: 0, cacheCreationTokens: 0, cacheCreation1hTokens: 0, costUsd: 0, durationMs: 0,
    };
    expect(() => recordSideCall(call)).not.toThrow();
  });
});

describe("the row names the model the call ran on", () => {
  test("an answer without its model takes the provider's one-shot model, not the chat default", async () => {
    // Claude CLI one-shots run on `claude-sonnet-5-5` while the chat default
    // can be Opus: labelled with `defaultModel()`, a card title read as Opus.
    const db = ledgerDb();
    configureSideCallLedger(db);
    const provider = fakeProvider({ content: "ok", usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.001 } }, {
      defaultModel: () => "claude-opus-5-5[1m]",
      completionModel: (o?: CompletionOptions) => o?.model ?? "claude-sonnet-5-5",
    } as Partial<AIProvider>);
    await meterCompletions(provider).complete([{ role: "user", content: "t" }], { purpose: "card-title" });
    await settled();
    expect(rowsOf(db)[0]?.model).toBe("claude-sonnet-5-5");
  });
});

describe("a Codex one-shot names the model it ran on", () => {
  test("the model passed to the CLI, not unknown", async () => {
    // Reproduced in review: autoname on Codex ran on gpt-5.6-luna and the row
    // said model=unknown. Codex had no `completionModel`.
    const db = ledgerDb();
    configureSideCallLedger(db);
    const codex = new CodexProvider({ type: "codex" } as never);
    codex.complete = async () => ({ content: "ok", usage: { promptTokens: 5, completionTokens: 1 } });
    await meterCompletions(codex).complete([{ role: "user", content: "t" }], { model: "gpt-5.6-luna", purpose: "chat-name" });
    await settled();
    expect(rowsOf(db)[0]?.model).toBe("gpt-5.6-luna");
  });

  test("with no model asked or configured, the one config.toml gives the CLI", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    const before = process.env.CODEX_HOME;
    try {
      writeFileSync(join(home, "config.toml"), `model = "gpt-6-sol"\n`);
      process.env.CODEX_HOME = home;
      expect(new CodexProvider({ type: "codex" } as never).completionModel()).toBe("gpt-6-sol");
      expect(new CodexProvider({ type: "codex", model: "gpt-6-astra" } as never).completionModel()).toBe("gpt-6-astra");
    } finally {
      if (before === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = before;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("the API provider (type claude)", () => {
  test("reports its cache shares, runs the model asked, and the row costs what the API bills", async () => {
    // Reproduced in review: input 3, 12,810 written to the cache, output 21 on
    // Sonnet 5.5. With `input_tokens` alone the row cost $0.000216; the bill,
    // at the official prices ($2 in, $10 out, 5-minute writes 1.25x), is
    // 3*2 + 12,810*2.5 + 21*10 = 32,241 millionths.
    const db = ledgerDb();
    configureSideCallLedger(db);
    const provider = createProvider({ type: "claude", apiKey: "sk-ant-fake" } as never);
    let asked: string | undefined;
    const client = {
      messages: {
        create: async (params: { model: string }) => {
          asked = params.model;
          return {
            model: params.model,
            content: [{ type: "text", text: "Titolo" }],
            usage: {
              input_tokens: 3, output_tokens: 21, cache_read_input_tokens: 0, cache_creation_input_tokens: 12_810,
              cache_creation: { ephemeral_5m_input_tokens: 12_810, ephemeral_1h_input_tokens: 0 },
            },
          };
        },
      },
    };
    Object.assign(provider as object, { started: true, client: Promise.resolve(client) });

    const out = await provider.complete([{ role: "user", content: "title this" }], { model: "claude-sonnet-5-5", purpose: "card-title" });
    await settled();

    expect(asked).toBe("claude-sonnet-5-5");
    expect(out.usage).toEqual({
      promptTokens: 12_813, completionTokens: 21, cacheReadTokens: 0, cacheCreationTokens: 12_810,
      cacheCreation1hTokens: 0, model: "claude-sonnet-5-5",
    });
    const [row] = rowsOf(db);
    expect(row).toMatchObject({ provider: "claude", model: "claude-sonnet-5-5", input_tokens: 12_813, cache_creation_tokens: 12_810, measured: 1 });
    expect(row?.cost_usd as number).toBeCloseTo(0.032241, 9);
  });
});

describe("createProvider", () => {
  test("every provider the factory builds is metered", () => {
    // One door: a caller that builds a provider gets the ledger without asking.
    const provider = createProvider({ type: "native", defaultWorkspace: "/tmp" });
    const inner = Object.getPrototypeOf(provider).complete as AIProvider["complete"];
    expect(provider.complete).not.toBe(inner);
  });
});
