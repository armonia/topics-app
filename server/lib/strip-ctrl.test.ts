/**
 * The cleaner of text that came from outside, once for every route. Pins the
 * three things a route relies on: control characters go, the ends are trimmed,
 * and the empty string stays distinct from "not a string".
 *
 * @covers MACHINE-03
 */
import { expect, test } from "bun:test";
import { stripCtrl, stripCtrlOrNull } from "./strip-ctrl";

test("removes control characters and trims", () => {
  expect(stripCtrl("  a\u0000b\nc\u007f\t ")).toBe("abc");
});

test("trims the ends and keeps inner spaces", () => {
  expect(stripCtrl("  a b  ")).toBe("a b");
});

test("anything that is not a string is null", () => {
  for (const v of [undefined, null, 1, {}, ["a"]]) expect(stripCtrl(v)).toBeNull();
});

test("an empty result is kept as an empty string by default", () => {
  expect(stripCtrl("\n\t ")).toBe("");
});

test("stripCtrlOrNull reads empty as missing", () => {
  expect(stripCtrlOrNull("\n\t ")).toBeNull();
  expect(stripCtrlOrNull(" x ")).toBe("x");
  expect(stripCtrlOrNull(3)).toBeNull();
});
