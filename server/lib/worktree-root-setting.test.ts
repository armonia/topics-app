/**
 * @covers WORKTREE-STD-01
 * @covers WORKTREE-STD-08
 *
 * The worktree root typed in Settings is normalised or refused.
 */
import { describe, expect, test } from "bun:test";
import { normalizeWorktreeRoot, worktreeRootRefusal, type PathCheckOptions, type RootDiskFacts } from "./worktree-root-setting";

describe("normalizeWorktreeRoot", () => {
  test("keeps an absolute folder and drops the trailing slash", () => {
    expect(normalizeWorktreeRoot("/data/wt/")).toBe("/data/wt");
  });

  test("expands a leading ~ against the given home", () => {
    expect(normalizeWorktreeRoot("~/work/trees", "/home/x")).toBe("/home/x/work/trees");
    // `~` alone is the home itself: never a root, since every folder of the person would be judged.
    expect(normalizeWorktreeRoot("~", "/home/x")).toBeNull();
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

describe("worktreeRootRefusal: a root must hold nothing but Topics' worktrees", () => {
  const home = "/home/x";
  const facts = (over: Partial<RootDiskFacts> = {}): RootDiskFacts => ({
    projectPaths: [], nonEmpty: () => false, isTopicsRoot: () => false, ...over,
  });
  const verdict = (raw: string, over: Partial<RootDiskFacts> = {}, opts: PathCheckOptions = {}) =>
    worktreeRootRefusal(raw, facts(over), { home, platform: "linux", osTmp: "/tmp", env: {}, ...opts });

  test("one refusal per class, each with its reason", () => {
    expect(verdict("trees")).toEqual({ refusal: "relative" });
    expect(verdict("/tmp/wt")).toEqual({ refusal: "temp" });
    expect(verdict("/")).toEqual({ refusal: "filesystem-root" });
    expect(verdict("~")).toEqual({ refusal: "home" });
    expect(verdict("/home/x")).toEqual({ refusal: "home" });
    expect(verdict("/home")).toEqual({ refusal: "home-ancestor" });
    expect(verdict("/usr/local/wt")).toEqual({ refusal: "system" });
    expect(verdict("/Volumes")).toEqual({ refusal: "system" });
    expect(verdict("/data/repo/.wt", { projectPaths: ["/data/repo"] })).toEqual({ refusal: "inside-project" });
    expect(verdict("/home/x/Projects", { projectPaths: ["/home/x/Projects/app"] })).toEqual({ refusal: "contains-project" });
    expect(verdict("/home/x/Documents", { nonEmpty: () => true })).toEqual({ refusal: "not-empty" });
  });

  test("an empty or new folder is fine, and so is a non-empty one that carries Topics' sentinel", () => {
    expect(verdict("~/worktrees")).toEqual({ root: "/home/x/worktrees" });
    expect(verdict("/data/wt", { nonEmpty: () => true, isTopicsRoot: () => true })).toEqual({ root: "/data/wt" });
    expect(verdict("/data/repo-trees", { projectPaths: ["/data/repo"] })).toEqual({ root: "/data/repo-trees" });
  });

  test("the OS temp folder is a temp area too, as written and as resolved", () => {
    expect(verdict("/scratch/tmp-of-os/wt", {}, { osTmp: "/scratch/tmp-of-os" })).toEqual({ refusal: "temp" });
  });

  test("Windows: an absolute path is accepted, temp and system folders compared without case", () => {
    const win: PathCheckOptions = {
      platform: "win32", home: "C:\\Users\\ann", osTmp: "C:\\Users\\ann\\AppData\\Local\\Temp",
      env: { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files" },
    };
    expect(verdict("D:\\worktrees", {}, win)).toEqual({ root: "D:\\worktrees" });
    expect(verdict("c:\\users\\ann\\appdata\\local\\temp\\wt", {}, win)).toEqual({ refusal: "temp" });
    expect(verdict("C:\\WINDOWS\\wt", {}, win)).toEqual({ refusal: "system" });
    expect(verdict("C:\\", {}, win)).toEqual({ refusal: "filesystem-root" });
    expect(verdict("C:\\Users", {}, win)).toEqual({ refusal: "home-ancestor" });
    expect(verdict("wt", {}, win)).toEqual({ refusal: "relative" });
  });

  test("the resolver ignores a hand-written home or system root the same way", () => {
    expect(normalizeWorktreeRoot("/home/x", "/home/x", { platform: "linux", osTmp: "/tmp", env: {} })).toBeNull();
    expect(normalizeWorktreeRoot("/", "/home/x", { platform: "linux", osTmp: "/tmp", env: {} })).toBeNull();
  });
});
