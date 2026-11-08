/**
 * The one copy of three helpers that used to exist four times each: control
 * character stripping, HTML escaping, home expansion.
 * @covers DEDUP-HELPERS-01
 */
import { describe, expect, test } from "bun:test";
import { stripCtrl, stripCtrlOrNull } from "./strip-ctrl";
import { escapeHtml } from "./escape-html";
import { expandHome } from "./expand-home";
import { isConflicted } from "../../shared/git-status";
import { mediaErrorHtml } from "../media-error-page";

describe("stripCtrl", () => {
  test("non-strings are null, control characters go, the rest is trimmed", () => {
    expect(stripCtrl(5)).toBeNull();
    expect(stripCtrl(" a\u0000b\n ")).toBe("ab");
  });
  test("the empty result: '' for stripCtrl, null for stripCtrlOrNull", () => {
    expect(stripCtrl("\u0001 ")).toBe("");
    expect(stripCtrlOrNull("\u0001 ")).toBeNull();
    expect(stripCtrlOrNull(" x ")).toBe("x");
  });
});

describe("escapeHtml", () => {
  test("all five characters, & first", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
  test("the media error page escapes the apostrophe too", () => {
    const html = mediaErrorHtml({ path: "/a'b", title: "t", detail: "d" });
    expect(html).toContain("/a&#39;b");
  });
});

describe("expandHome", () => {
  test("~, ~/x and ~/x or backslash form, trimmed; other text is untouched", () => {
    expect(expandHome(" ~ ", "/h")).toBe("/h");
    expect(expandHome("~/bin", "/h")).toBe("/h/bin");
    expect(expandHome("~\\bin", "/h")).toBe("/h\\bin");
    expect(expandHome("/abs", "/h")).toBe("/abs");
  });
});

describe("isConflicted", () => {
  test.each(["UU", "AU", "UD", "UA", "DU", "AA", "DD"])("%s is a conflict", (c) => {
    expect(isConflicted(c)).toBe(true);
  });
  test.each(["M ", " M", "A ", "D ", "??", "AD", "DA"])("%s is not", (c) => {
    expect(isConflicted(c)).toBe(false);
  });
});
