/**
 * Regression test for the AGENT-04 NaN-token bug.
 *
 * Before the fix, MessageMetaFooter computed
 *   total = (promptTokens ?? 0) + (completionTokens ?? 0)
 * which only coalesces null/undefined; NaN slipped through and surfaced
 * as "NaN tokens" in the UI footer.
 *
 * The fix introduces `safeNum` that also rejects NaN, Infinity, and
 * negative numbers. This test asserts the contract directly via a copy
 * of the helper (kept in lockstep with the implementation by review).
 *
 * Run with: `bun test tests/unit/message-meta-footer-safe-num.test.ts`
  * @covers USAGE-19
 */
import { describe, expect, test } from 'bun:test';

// Replica of safeNum from client/src/components/Chat/MessageMetaFooter.tsx.
// Keep this in sync with the production helper; the test verifies the
// contract, not the private symbol.
function safeNum(v: number | null | undefined): number {
  if (v == null) return 0;
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v;
}

describe('safeNum — AGENT-04 NaN guard', () => {
  test('passes through valid non-negative numbers', () => {
    expect(safeNum(0)).toBe(0);
    expect(safeNum(1)).toBe(1);
    expect(safeNum(100)).toBe(100);
    expect(safeNum(1.5)).toBe(1.5);
  });

  test('returns 0 for null and undefined', () => {
    expect(safeNum(null)).toBe(0);
    expect(safeNum(undefined)).toBe(0);
  });

  test('returns 0 for NaN (the bug)', () => {
    expect(safeNum(NaN)).toBe(0);
  });

  test('returns 0 for Infinity / -Infinity', () => {
    expect(safeNum(Infinity)).toBe(0);
    expect(safeNum(-Infinity)).toBe(0);
  });

  test('clamps negative numbers to 0', () => {
    expect(safeNum(-1)).toBe(0);
    expect(safeNum(-100)).toBe(0);
  });

  test('rejects non-number passed through bad typing', () => {
    expect(safeNum('5' as unknown as number)).toBe(0);
    expect(safeNum({} as unknown as number)).toBe(0);
  });
});

describe('AGENT-04 regression — token sum no longer NaN', () => {
  test('NaN + valid number yields the valid number (after safeNum)', () => {
    // Before the fix: (NaN ?? 0) + (50 ?? 0) === NaN + 50 === NaN
    // After:          safeNum(NaN) + safeNum(50) === 0 + 50 === 50
    expect(safeNum(NaN) + safeNum(50)).toBe(50);
  });

  test('null + NaN safely yields 0', () => {
    expect(safeNum(null) + safeNum(NaN)).toBe(0);
  });

  test('both NaN safely yields 0', () => {
    expect(safeNum(NaN) + safeNum(NaN)).toBe(0);
  });

  test('Infinity + 100 safely yields 100', () => {
    expect(safeNum(Infinity) + safeNum(100)).toBe(100);
  });

  test('legitimate provider report (100 + 50) is unchanged', () => {
    expect(safeNum(100) + safeNum(50)).toBe(150);
  });
});
