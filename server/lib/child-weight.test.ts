/**
 * @covers KANBAN-63
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEstimate, weightOf } from "./child-weight";
import { createTranscriptUsageReader } from "../services/transcript-usage";

const usage = (over: Partial<{ billableTokens: number; cacheReadTokens: number; costUsd: number }> = {}) => ({
  inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0, billableTokens: 0, ...over,
});

describe("weightOf", () => {
  test("nothing measured, no weight", () => {
    expect(weightOf(usage(), null)).toBeNull();
  });
  test("tokens without a context keep the context fields null", () => {
    expect(weightOf(usage({ billableTokens: 900, costUsd: 0.126 }), null)).toEqual({
      usedTokens: null, windowTokens: null, estimated: false, billableTokens: 900, cacheReadTokens: 0, costCents: 13,
    });
  });
  test("a context measure carries its estimated flag", () => {
    const w = weightOf(usage({ billableTokens: 10 }), { used: 120_000, size: 1_000_000, estimated: true });
    expect([w?.usedTokens, w?.windowTokens, w?.estimated]).toEqual([120_000, 1_000_000, true]);
  });
});

describe("transcript last call", () => {
  test("the context is the prompt of the last call that consumed something", () => {
    const dir = mkdtempSync(join(tmpdir(), "child-weight-"));
    try {
      const line = (id: string, input: number, cacheRead: number, cacheWrite: number) => JSON.stringify({
        type: "assistant", message: { id, model: "claude-sonnet-5", usage: { input_tokens: input, output_tokens: 5, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite } },
      }) + "\n";
      const path = join(dir, "s.jsonl");
      writeFileSync(path, line("m1", 10, 1000, 200) + line("m2", 20, 5000, 0) + line("m3", 0, 0, 0));
      expect(createTranscriptUsageReader().read(path).lastCall).toEqual({ contextTokens: 5020, model: "claude-sonnet-5" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("childEstimate", () => {
  const mem = () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE subagents (id TEXT, runtime TEXT, state TEXT, created_at TEXT, ended_at TEXT)");
    return db;
  };
  const MIN = 60_000;
  const add = (db: Database, id: string, runtime: string | null, minutes: number, state = "retired") => {
    const start = Date.parse("2026-11-01T10:00:00Z");
    db.run("INSERT INTO subagents VALUES (?, ?, ?, ?, ?)", [id, runtime, state, new Date(start).toISOString(), new Date(start + minutes * MIN + Number(id.replace(/\D/g, "")) * 1000).toISOString()]);
  };
  test("no estimate below the sample floor", () => {
    const db = mem();
    add(db, "a1", "topics", 3);
    add(db, "a2", "topics", 4);
    expect(childEstimate(db, "topics")).toBeUndefined();
  });
  test("the departure quantile of the finished children of the same runtime, nulls count as the CLI", () => {
    const db = mem();
    [2, 4, 6, 8, 50].forEach((m, i) => add(db, `c${i}`, i % 2 ? null : "claude-code", m));
    [1, 1, 1, 1, 1].forEach((m, i) => add(db, `t${i}`, "topics", m));
    add(db, "r9", "claude-code", 999, "running");
    const cli = childEstimate(db, "claude-code");
    // 0.7 of [2, 4, 6, 8, 50] min: 6 + 0.8 * 2 = 7.6
    expect(Math.round((cli?.departureMs ?? 0) / MIN)).toBe(8);
    expect(cli?.historyMs.map((ms) => Math.round(ms / MIN))).toEqual([2, 4, 6, 8, 50]);
    expect(Math.round((childEstimate(db, "topics")?.departureMs ?? 0) / MIN)).toBe(1);
  });
});
