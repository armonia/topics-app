/**
 * THE SPEND OF A CARD IS THE SUM OF ITS CALLS, each priced on its own.
 *
 * The brake priced a session's TOTALS as one request. Haiku 5.5 picks its rate
 * card per request, so the moment a session's sum passed 100k tokens of prompt
 * the whole session moved to the long card: four calls of 60k, 80k, 120k and
 * 140k came out at 30 cents instead of 20.
 *
 * Both readers the dispatcher uses now price each call with the model that
 * served it: the transcript reader (per `message.id`, `message.model`) and the
 * native engine's registry (per round). The readings are real, the arithmetic
 * by hand from the official cards ($0.10/$0.50, and $0.50/$2.50 over 100k).
 * @covers KANBAN-07, USAGE-01
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bookSessionCost, type SessionLedger } from "./task-dispatcher-spend-cap";
import { createTranscriptUsageReader, ZERO_USAGE, type SessionUsage } from "./transcript-usage";
import { addUsage } from "./dispatch-usage";
import { readNativeUsage, recordTurnUsage, resetNativeUsage } from "../providers/native-usage-registry";

const dir = mkdtempSync(join(tmpdir(), "spend-cap-per-call-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => resetNativeUsage());

const PROMPTS = [60_000, 80_000, 120_000, 140_000];
/** 60k*0.1 + 10k*0.5 = $0.011; 80k $0.013; 120k*0.5 + 10k*2.5 = $0.085; 140k $0.095. */
const PER_CALL_CENTS = 20;
/** The same totals as one request: 400k*0.5 + 40k*2.5 = $0.30. */
const AS_ONE_REQUEST_CENTS = 30;

function ledger(offset: SessionUsage = ZERO_USAGE): SessionLedger {
  return { offset, tokens: 0, cacheRead: 0, costCents: 0, unpricedCostTokens: 0, model: "claude-haiku-5-5" };
}

function transcript(name: string, models: string[]): string {
  const path = join(dir, name);
  writeFileSync(path, PROMPTS.map((p, i) => JSON.stringify({
    type: "assistant",
    message: { id: `msg_${i}`, model: models[i], usage: { input_tokens: p, output_tokens: 10_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  })).join("\n") + "\n");
  return path;
}

describe("a CLI session: the transcript reader prices each call", () => {
  test("four Haiku 5.5 calls cost 20 cents, not 30", () => {
    const reading = createTranscriptUsageReader().read(transcript("haiku.jsonl", PROMPTS.map(() => "claude-haiku-5-5")));
    expect(reading.costUsd).toBeCloseTo(0.204, 9);
    const s = ledger();
    bookSessionCost(s, reading);
    expect(s.costCents).toBe(PER_CALL_CENTS);
  });

  test("the delta from the anchor, not the session from its start", () => {
    const path = join(dir, "anchored.jsonl");
    const line = (i: number) => JSON.stringify({ type: "assistant", message: { id: `a_${i}`, model: "claude-haiku-5-5", usage: { input_tokens: PROMPTS[i], output_tokens: 10_000 } } }) + "\n";
    const r = createTranscriptUsageReader();
    writeFileSync(path, line(0));
    const anchor = r.read(path);
    writeFileSync(path, line(0) + line(1) + line(2) + line(3));
    const s = ledger(anchor);
    bookSessionCost(s, r.read(path));
    // $0.204 - $0.011 for the call before the anchor.
    expect(s.costCents).toBe(19);
  });

  test("a call on a model without a price: the per-call sum is dropped, the totals are priced", () => {
    const reading = createTranscriptUsageReader().read(transcript("mixed.jsonl", ["claude-haiku-5-5", "some-unpriced-model", "claude-haiku-5-5", "claude-haiku-5-5"]));
    expect(reading.costUsd).toBeUndefined();
    const s = ledger();
    bookSessionCost(s, reading);
    expect(s.costCents).toBe(AS_ONE_REQUEST_CENTS);
  });
});

describe("a native session: the registry prices each round", () => {
  test("four rounds with their model cost 20 cents, not 30", () => {
    for (const p of PROMPTS) recordTurnUsage("topic:native", { input: p, output: 10_000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }, "claude-haiku-5-5");
    const reading = readNativeUsage("topic:native")!;
    expect(reading.costUsd).toBeCloseTo(0.204, 9);
    const s = ledger();
    bookSessionCost(s, reading);
    expect(s.costCents).toBe(PER_CALL_CENTS);
  });

  test("a round without its model: no per-call sum from then on", () => {
    recordTurnUsage("topic:anon", { input: 60_000, output: 10_000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }, "claude-haiku-5-5");
    recordTurnUsage("topic:anon", { input: 60_000, output: 10_000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });
    recordTurnUsage("topic:anon", { input: 60_000, output: 10_000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }, "claude-haiku-5-5");
    expect(readNativeUsage("topic:anon")!.costUsd).toBeUndefined();
  });
});

describe("a coordinator and its children", () => {
  test("the per-call sums add up only while both sides have one", () => {
    const a = { ...ZERO_USAGE, costUsd: 0.1 };
    const b = { ...ZERO_USAGE, costUsd: 0.05 };
    expect(addUsage(a, b).costUsd).toBeCloseTo(0.15, 9);
    const unpriced: SessionUsage = { ...ZERO_USAGE };
    delete unpriced.costUsd;
    expect(addUsage(a, unpriced).costUsd).toBeUndefined();
  });
});
