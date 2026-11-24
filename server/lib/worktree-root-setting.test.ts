/**
 * @covers WORKTREE-STD-01
 *
 * The worktree root typed in Settings is normalised or refused.
 */
import { describe, expect, test } from "bun:test";
import { normalizeWorktreeRoot } from "./worktree-root-setting";

describe("normalizeWorktreeRoot", () => {
  test("keeps an absolute folder and drops the trailing slash", () => {
    expect(normalizeWorktreeRoot("/data/wt/")).toBe("/data/wt");
  });

  test("expands a leading ~ against the given home", () => {
    expect(normalizeWorktreeRoot("~/work/trees", "/home/x")).toBe("/home/x/work/trees");
    expect(normalizeWorktreeRoot("~", "/home/x")).toBe("/home/x");
  });

  test("refuses empty, relative and temp-area values", () => {
    for (const bad of ["", "   ", "wt", "./wt", "/tmp", "/tmp/wt", "/private/tmp/a", "/var/tmp/a"]) {
      expect(normalizeWorktreeRoot(bad)).toBeNull();
    }
  });

  test("a folder that merely starts with the same letters as a temp area is fine", () => {
    expect(normalizeWorktreeRoot("/tmpfiles/wt")).toBe("/tmpfiles/wt");
  });
});
