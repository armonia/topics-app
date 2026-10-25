import { describe, expect, test } from "bun:test";
import { isAbsoluteServerPath } from "./absolute-path";

describe("isAbsoluteServerPath", () => {
  test("on Windows a drive-letter or UNC folder is absolute (the PC node registers its repos this way)", () => {
    expect(isAbsoluteServerPath("C:\\Users\\zorah\\repo", "win32")).toBe(true);
    expect(isAbsoluteServerPath("E:/topics-nodo/repos/x", "win32")).toBe(true);
    expect(isAbsoluteServerPath("\\\\server\\share\\repo", "win32")).toBe(true);
  });

  test("on Windows a drive-relative or relative path is refused", () => {
    expect(isAbsoluteServerPath("C:repo", "win32")).toBe(false);
    expect(isAbsoluteServerPath("repo\\sub", "win32")).toBe(false);
  });

  test("on macOS and Linux nothing changes: only a leading slash is absolute", () => {
    expect(isAbsoluteServerPath("/Users/a/repo", "darwin")).toBe(true);
    expect(isAbsoluteServerPath("/home/a/repo", "linux")).toBe(true);
    expect(isAbsoluteServerPath("C:\\repo", "darwin")).toBe(false);
    expect(isAbsoluteServerPath("repo", "linux")).toBe(false);
  });

  test("anything that is not a non-empty string is refused", () => {
    expect(isAbsoluteServerPath("", "linux")).toBe(false);
    expect(isAbsoluteServerPath(undefined, "win32")).toBe(false);
    expect(isAbsoluteServerPath(42, "darwin")).toBe(false);
  });
});
