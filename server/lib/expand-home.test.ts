/**
 * `~` expansion for a path a person typed: one definition for the routes that
 * validate it and the code that later uses it.
 */
import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { expandHome } from "./expand-home";

test("a leading ~ and ~/ become the home directory", () => {
  expect(expandHome("~")).toBe(homedir());
  expect(expandHome("~/bin/codex")).toBe(`${homedir()}/bin/codex`);
});

test("the input is trimmed first", () => {
  expect(expandHome("  ~/x ")).toBe(`${homedir()}/x`);
  expect(expandHome("  /abs ")).toBe("/abs");
});

test("a ~ in the middle or a ~user is left alone", () => {
  expect(expandHome("/a/~/b")).toBe("/a/~/b");
  expect(expandHome("~other/x")).toBe("~other/x");
});
