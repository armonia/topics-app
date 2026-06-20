import { describe, test, expect } from "bun:test";
import { calculateCost } from "./pricing";

// Regression coverage for the fuzzy-match fix: findPricing must not let a short
// model name match a LONGER key (e.g. "gpt-4o" → "gpt-4o-mini") and bill at the
// wrong rate. gpt-4o input = $2.50/M, gpt-4o-mini input = $0.15/M.
describe("calculateCost — model pricing resolution", () => {
  test("gpt-4o bills at the gpt-4o rate, not the longer gpt-4o-mini key", () => {
    expect(calculateCost("gpt-4o", 1_000_000, 0)).toBe(2.5);
  });

  test("gpt-4o-mini still resolves to its own (cheaper) rate", () => {
    expect(calculateCost("gpt-4o-mini", 1_000_000, 0)).toBeCloseTo(0.15, 6);
  });

  test("a longer/versioned name containing a known key still matches it", () => {
    expect(calculateCost("gpt-4o-2024-08-06", 1_000_000, 0)).toBe(2.5);
  });

  test("an unknown model is not billed (returns 0)", () => {
    expect(calculateCost("totally-unknown-model-xyz", 1_000_000, 1_000_000)).toBe(0);
  });
});
