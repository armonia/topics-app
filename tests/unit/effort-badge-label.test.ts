/**
 * @covers COMPOSER-BAR-01
 * The effort chip falls back to "auto" instead of disappearing (card 067a1f5b).
 */
import { describe, expect, test } from "bun:test";
import { effortBadgeLabel } from "../../client/src/lib/effortBadgeLabel";

describe("effortBadgeLabel", () => {
  test("shows the tier when one is known", () => {
    expect(effortBadgeLabel("high")).toBe("high");
  });
  test("falls back to auto when no tier is known (provider Automatic)", () => {
    expect(effortBadgeLabel(null)).toBe("auto");
    expect(effortBadgeLabel(undefined)).toBe("auto");
    expect(effortBadgeLabel("")).toBe("auto");
  });
});
