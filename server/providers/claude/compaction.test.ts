/**
 * @covers CHAT-COMPACT-01
 */
import { describe, expect, test } from "bun:test";
import { parseCompactBoundary, isCompactBoundary } from "./compaction";

describe("parseCompactBoundary", () => {
  test("non-boundary frames return null", () => {
    expect(parseCompactBoundary(null)).toBeNull();
    expect(parseCompactBoundary({ type: "assistant" })).toBeNull();
    expect(parseCompactBoundary({ type: "system", subtype: "init" })).toBeNull();
    expect(parseCompactBoundary({ type: "result" })).toBeNull();
  });

  test("auto trigger + pre_tokens under compact_metadata", () => {
    const m = parseCompactBoundary({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 152000 },
    });
    expect(m).not.toBeNull();
    expect(m!.trigger).toBe("auto");
    expect(m!.preTokens).toBe(152000);
  });

  test("manual trigger", () => {
    const m = parseCompactBoundary({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual" },
    });
    expect(m!.trigger).toBe("manual");
    expect(m!.preTokens).toBeUndefined();
  });

  test("tolerates alternative metadata field names", () => {
    const m = parseCompactBoundary({
      type: "system",
      subtype: "compact_boundary",
      metadata: { reason: "automatic", preTokens: 99 },
    });
    expect(m!.trigger).toBe("auto");
    expect(m!.preTokens).toBe(99);
  });

  test("missing metadata degrades to unknown trigger, no tokens", () => {
    const m = parseCompactBoundary({ type: "system", subtype: "compact_boundary" });
    expect(m!.trigger).toBe("unknown");
    expect(m!.preTokens).toBeUndefined();
  });

  test("negative / non-numeric token counts are dropped", () => {
    const m = parseCompactBoundary({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: -5 },
    });
    expect(m!.preTokens).toBeUndefined();
  });

  test("isCompactBoundary guard", () => {
    expect(isCompactBoundary({ type: "system", subtype: "compact_boundary" })).toBe(true);
    expect(isCompactBoundary({ type: "system", subtype: "other" })).toBe(false);
    expect(isCompactBoundary(42)).toBe(false);
  });
});
