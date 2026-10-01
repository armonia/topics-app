/**
 * The palette keeps its result order while the query stays the same.
 * @covers CMD-01
 */
import { describe, expect, test } from "bun:test";
import { keepOrder, rankOf } from "./paletteStableOrder";

const rows = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (list: { id: string }[]) => list.map((r) => r.id);

describe("keepOrder", () => {
  test("with no ranking yet, the fresh order is the order", () => {
    expect(ids(keepOrder(rows("a", "b", "c"), null))).toEqual(["a", "b", "c"]);
  });

  test("a row that moved to the top in the fresh order stays where it was", () => {
    const rank = rankOf(rows("a", "b", "c", "d"));
    expect(ids(keepOrder(rows("c", "a", "b", "d"), rank))).toEqual(["a", "b", "c", "d"]);
  });

  test("a row the ranking has not seen follows the ranked ones", () => {
    const rank = rankOf(rows("a", "b"));
    expect(ids(keepOrder(rows("new", "b", "a"), rank))).toEqual(["a", "b", "new"]);
  });

  test("a row that left the results is gone, the rest keep their order", () => {
    const rank = rankOf(rows("a", "b", "c"));
    expect(ids(keepOrder(rows("c", "a"), rank))).toEqual(["a", "c"]);
  });
});
