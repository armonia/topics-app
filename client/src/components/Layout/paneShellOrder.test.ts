/**
 * THE INVARIANT: the order of the mounted shells does not depend on the order of
 * the tabs. Everything below is a permutation of the same set of keys, and the
 * answer has to be the same list every time - that identity is what spares React
 * the `insertBefore` that reloads a browser pane.
 *
 * @covers LAYOUT-01
 */
import { test, expect } from "bun:test";
import { paneShellOrder } from "./paneShellOrder";

interface Cell { key: string }
const cells = (...keys: string[]): Cell[] => keys.map((key) => ({ key }));
const keyOf = (c: Cell) => c.key;
const keys = (c: Cell[]) => c.map(keyOf);

test("any permutation of the same panes renders in the same shell order", () => {
  const reference = keys(paneShellOrder(cells("chat", "browser", "terminal"), keyOf));
  for (const permutation of [
    ["browser", "terminal", "chat"],
    ["terminal", "chat", "browser"],
    ["chat", "terminal", "browser"],
  ]) {
    expect(keys(paneShellOrder(cells(...permutation), keyOf))).toEqual(reference);
  }
});

test("a new pane joins without displacing the ones already mounted", () => {
  const before = keys(paneShellOrder(cells("b", "d"), keyOf));
  // "a" sorts first and "c" in the middle: neither may change the relative
  // order of "b" and "d", or mounting a pane would reload its neighbours.
  const after = keys(paneShellOrder(cells("d", "a", "b", "c"), keyOf));
  expect(after.filter((k) => before.includes(k))).toEqual(before);
});

test("closing a pane leaves the order of the survivors untouched", () => {
  const before = keys(paneShellOrder(cells("x", "y", "z"), keyOf));
  const after = keys(paneShellOrder(cells("z", "x"), keyOf));
  expect(after).toEqual(before.filter((k) => k !== "y"));
});

test("the input list is not mutated: the tab order stays the caller's", () => {
  const input = cells("z", "a");
  paneShellOrder(input, keyOf);
  expect(keys(input)).toEqual(["z", "a"]);
});
