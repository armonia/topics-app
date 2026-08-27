/**
 * @covers CHAT-REL-03 — the judge that decides whether a silent turn is alive
 * or stuck. The requirement's whole point is that silence alone must not kill
 * a turn, so a verdict misread off explanation text ("not alive, it looks
 * stuck") is the exact failure it forbids.
 */
import { describe, expect, test } from "bun:test";
import { buildStallJudgePrompt, judgeStall, parseStallVerdict } from "./stall-judge";

describe("parseStallVerdict — exact match, not scan-order", () => {
  test("a clean 'alive' answer parses as alive", () => {
    expect(parseStallVerdict("alive")).toBe("alive");
    expect(parseStallVerdict("  Alive.\n")).toBe("alive");
  });

  test("a clean 'stuck' answer parses as stuck", () => {
    expect(parseStallVerdict("stuck")).toBe("stuck");
    expect(parseStallVerdict("STUCK")).toBe("stuck");
  });

  test("an answer naming BOTH words never reads the wrong one off explanation text", () => {
    // "alive" appears strictly before "stuck" in the raw text; a naive
    // `text.includes("alive") ? "alive" : "stuck"` scan would misread this as
    // alive, when the model's actual verdict was the opposite.
    expect(parseStallVerdict("not alive, it looks stuck")).toBeNull();
    expect(parseStallVerdict("stuck, definitely not alive")).toBeNull();
  });

  test("an answer naming neither word is not a verdict", () => {
    expect(parseStallVerdict("I cannot tell")).toBeNull();
    expect(parseStallVerdict("")).toBeNull();
  });

  test("matches on WORD boundaries, not substrings", () => {
    // "unstuck" contains "stuck" as a substring but is not the word "stuck".
    expect(parseStallVerdict("unstuck")).toBeNull();
  });
});

describe("buildStallJudgePrompt", () => {
  test("carries the transcript tail verbatim and asks for one word", () => {
    const prompt = buildStallJudgePrompt("assistant: running tests...");
    expect(prompt).toContain("assistant: running tests...");
    expect(prompt).toContain("alive");
    expect(prompt).toContain("stuck");
  });
});

describe("judgeStall — fails safe to alive", () => {
  test("a clean judge answer of stuck is trusted", async () => {
    const verdict = await judgeStall({ complete: async () => "stuck" }, "tail");
    expect(verdict).toBe("stuck");
  });

  test("a clean judge answer of alive is trusted", async () => {
    const verdict = await judgeStall({ complete: async () => "alive" }, "tail");
    expect(verdict).toBe("alive");
  });

  test("an unparseable answer reads as alive — never recycle on a shrug", async () => {
    const verdict = await judgeStall({ complete: async () => "I'm not sure" }, "tail");
    expect(verdict).toBe("alive");
  });

  test("a throwing judge reads as alive — never recycle on a failed call", async () => {
    const verdict = await judgeStall({ complete: async () => { throw new Error("network"); } }, "tail");
    expect(verdict).toBe("alive");
  });
});
