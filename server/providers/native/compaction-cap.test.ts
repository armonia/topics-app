/**
 * An absolute ceiling for the native compaction. On a 1M window the window's
 * fractions fire at 850k, and the always-on agents' chats lived between 150k
 * and 450k tokens per call without ever compacting (27/11). With a ceiling
 * the decision fires at a token count instead, and only ever lower.
 *
 * @covers CHAT-COMPACT-06
 */
import { describe, expect, test } from "bun:test";
import {
  COMPACT_AT, COMPACT_AT_UNMEASURED, COMPACT_TO,
  compact, compactionThresholds, estimateTokens, needsCompaction,
} from "./compaction";
import { compactIfNeeded } from "./context-window";
import type { AgentMessage } from "./agent-loop";
import type { CompactionMarker } from "../claude/compaction";

const MILLION = 1_000_000;
const CAP = 200_000;
const CALIBRATED = { charsPerToken: 4, calibrated: true };

/** `turns` exchanges of `tokensEach` estimated tokens per message, then the new question. */
function chat(turns: number, tokensEach: number): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (let i = 0; i < turns; i++) {
    out.push({ role: "user", content: `u${i} `.padEnd(tokensEach * 4, "u") });
    out.push({ role: "assistant", content: `a${i} `.padEnd(tokensEach * 4, "a") });
  }
  out.push({ role: "user", content: "and now?" });
  return out;
}

const decide = (history: AgentMessage[], capTokens?: number | null): boolean => {
  const { compactAt } = compactionThresholds(MILLION, { calibrated: true, capTokens });
  return needsCompaction(history, MILLION, 0, 4, compactAt);
};

describe("compactionThresholds: the ceiling only ever lowers the window's own numbers", () => {
  test("without a ceiling the window's fractions stand, calibrated or not", () => {
    for (const capTokens of [undefined, null]) {
      expect(compactionThresholds(MILLION, { calibrated: true, capTokens })).toEqual({ compactAt: COMPACT_AT, compactTo: COMPACT_TO });
      expect(compactionThresholds(MILLION, { calibrated: false, capTokens })).toEqual({ compactAt: COMPACT_AT_UNMEASURED, compactTo: COMPACT_TO });
    }
  });

  test("a ceiling under the window's trigger becomes the trigger, and the target keeps the window's ratio", () => {
    for (const calibrated of [true, false]) {
      const t = compactionThresholds(MILLION, { calibrated, capTokens: CAP });
      expect(t.compactAt * MILLION).toBeCloseTo(CAP, 6);
      expect(t.compactTo * MILLION).toBeCloseTo(CAP * (COMPACT_TO / COMPACT_AT), 6);
    }
  });

  test("a ceiling at or above the window's trigger changes nothing", () => {
    // 200k window: its own trigger is 170k, a 200k ceiling is above it.
    expect(compactionThresholds(200_000, { calibrated: true, capTokens: CAP })).toEqual({ compactAt: COMPACT_AT, compactTo: COMPACT_TO });
    expect(compactionThresholds(MILLION, { calibrated: true, capTokens: 900_000 })).toEqual({ compactAt: COMPACT_AT, compactTo: COMPACT_TO });
    // Uncalibrated the trigger is 750k: an 800k ceiling would RAISE it.
    expect(compactionThresholds(MILLION, { calibrated: false, capTokens: 800_000 })).toEqual({ compactAt: COMPACT_AT_UNMEASURED, compactTo: COMPACT_TO });
  });

  test("a malformed ceiling is no ceiling", () => {
    for (const capTokens of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(compactionThresholds(MILLION, { calibrated: true, capTokens })).toEqual({ compactAt: COMPACT_AT, compactTo: COMPACT_TO });
    }
  });
});

describe("deciding when to compact on a 1M window, with and without the ceiling", () => {
  test("THE BARRA: a 300k chat is left alone without a ceiling and compacted with one", () => {
    const history = chat(15, 10_000);
    expect(estimateTokens(history)).toBeGreaterThan(290_000);
    expect(decide(history)).toBe(false);
    expect(decide(history, CAP)).toBe(true);
  });

  test("under the ceiling nothing happens", () => {
    expect(decide(chat(7, 10_000), CAP)).toBe(false);
  });

  test("compactIfNeeded brings a capped chat under the ceiling's target, keeping the opening request", () => {
    const history = chat(15, 10_000);
    const opening = history[0];
    const seen: CompactionMarker[] = [];
    const handler = { onCompaction: (e: CompactionMarker) => { seen.push(e); } };

    expect(compactIfNeeded({ history, windowTokens: MILLION, overheadChars: 0, calibration: { ...CALIBRATED }, capTokens: CAP, handler })).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.preTokens).toBeGreaterThan(290_000);
    expect(seen[0]!.postTokens).toBeLessThanOrEqual(CAP * (COMPACT_TO / COMPACT_AT));
    expect(estimateTokens(history)).toBe(seen[0]!.postTokens);
    expect((history[0]!.content as string).startsWith(opening!.content as string)).toBe(true);
  });

  test("compactIfNeeded without a ceiling leaves the same chat whole", () => {
    const history = chat(15, 10_000);
    const before = history.length;
    const handler = { onCompaction: () => { throw new Error("must not compact"); } };
    expect(compactIfNeeded({ history, windowTokens: MILLION, overheadChars: 0, calibration: { ...CALIBRATED }, handler })).toBe(false);
    expect(history).toHaveLength(before);
  });
});

/**
 * A chat that grows 4k tokens per turn for 200 turns on a 1M window: the
 * shape of an agent's day, and the number this change exists to move. Each
 * iteration is a turn start, where the loop checks the ceiling.
 */
function simulate(capTokens: number | null): { mean: number; max: number; compactions: number } {
  let history: AgentMessage[] = [{ role: "user", content: "initial request" }];
  const sizes: number[] = [];
  let compactions = 0;
  for (let round = 0; round < 200; round++) {
    const { compactAt, compactTo } = compactionThresholds(MILLION, { calibrated: true, capTokens });
    if (needsCompaction(history, MILLION, 0, 4, compactAt)) {
      history = compact(history, { windowTokens: MILLION, charsPerToken: 4, compactAt, compactTo }).messages;
      compactions++;
    }
    sizes.push(estimateTokens(history));
    history.push(
      { role: "assistant", content: `a${round} `.padEnd(8_000, "a") },
      { role: "user", content: `u${round} `.padEnd(8_000, "u") },
    );
  }
  return { mean: sizes.reduce((a, b) => a + b, 0) / sizes.length, max: Math.max(...sizes), compactions };
}

describe("tokens per call over an agent's day", () => {
  test("with the ceiling no call goes past it, and the mean falls by more than half", () => {
    const without = simulate(null);
    const withCap = simulate(CAP);
    expect(without.compactions).toBe(0);
    expect(without.max).toBeGreaterThan(780_000);
    expect(withCap.max).toBeLessThanOrEqual(CAP + 4_000);
    expect(withCap.mean).toBeLessThan(without.mean / 2);
    // Each compaction rewrites the cache once: a handful over 200 rounds, not one per round.
    expect(withCap.compactions).toBeGreaterThan(0);
    expect(withCap.compactions).toBeLessThanOrEqual(10);
  });
});

describe("a second compaction leaves what the first one lightened as it was", () => {
  test("a lightened argument keeps its notice and its count", () => {
    const history: AgentMessage[] = [{ role: "user", content: "write it" }];
    for (let i = 0; i < 10; i++) {
      history.push(
        { role: "assistant", content: [{ type: "tool_use", id: `w${i}`, name: "write_file", input: { path: `f${i}.ts`, content: "x".repeat(5_000) } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: `w${i}`, content: "written" }] },
      );
    }
    const inputOf = (h: AgentMessage[]) => JSON.stringify((h[1]!.content as Array<{ input?: unknown }>)[0]!.input);
    const once = compact(history).messages;
    const twice = compact(once).messages;
    expect(inputOf(once)).toContain("4800 chars dropped");
    expect(inputOf(twice)).toBe(inputOf(once));
  });
});
