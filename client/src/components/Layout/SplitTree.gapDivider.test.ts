/**
 * Regression: a resize divider must render only BETWEEN two visible siblings.
 *
 * When two cells hold the same pane key, buildShallowGridTree dedups the second
 * to a zero-weight `__skip:` placeholder. Before the fix, SplitTree still drew a
 * divider adjacent to that invisible cell — a zero-width grab strip laid over
 * the neighbouring real divider's band, which made the real resizer read as
 * "lost" (unhittable). gapHasDivider is the pure predicate that suppresses it.
 *
 * @covers LAYOUT-01
 */
import { describe, expect, it } from "bun:test";
import { gapHasDivider } from "./splitDivider";
import { leaf, type SplitChild } from "../../state/layout/layoutTree";

const child = (weight: number, id = `p${weight}`): SplitChild => ({ weight, node: leaf(id) });

describe("gapHasDivider", () => {
  it("never renders a divider before the first child", () => {
    expect(gapHasDivider([child(1), child(1)], 0)).toBe(false);
  });

  it("renders a divider between two visible siblings", () => {
    expect(gapHasDivider([child(0.5), child(0.5)], 1)).toBe(true);
  });

  it("suppresses the divider before a zero-weight (dedup'd/skip) cell", () => {
    // [real, skip] — the gap at i=1 abuts an invisible cell → no dead divider.
    expect(gapHasDivider([child(1), child(0, "__skip:0:1")], 1)).toBe(false);
  });

  it("suppresses the divider after a zero-weight cell", () => {
    // [skip, real] — the gap at i=1 follows an invisible cell.
    expect(gapHasDivider([child(0, "__skip:0:0"), child(1)], 1)).toBe(false);
  });

  it("keeps dividers only between the visible cells of a mixed row", () => {
    // [real, real, skip, real] → dividers at i=1 (real|real) only.
    const row = [child(0.4, "a"), child(0.4, "b"), child(0, "__skip:0:2"), child(0.2, "d")];
    expect(gapHasDivider(row, 1)).toBe(true);   // a|b
    expect(gapHasDivider(row, 2)).toBe(false);  // b|skip
    expect(gapHasDivider(row, 3)).toBe(false);  // skip|d
  });

  it("is out-of-range safe", () => {
    expect(gapHasDivider([child(1)], 5)).toBe(false);
  });
});
