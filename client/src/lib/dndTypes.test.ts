/**
 * Tests for the tab-drag scope helpers. Scope is what enforces "main tabs only
 * drop in main, project tabs only within the same project": each tab drag tags
 * itself with a scope-derived dataTransfer TYPE, and every drop target accepts
 * only drags carrying its own scope marker.
 *
 * @covers LAYOUT-02
 */
import { describe, test, expect } from "bun:test";
import { paneTabScopeType, dragMatchesScope, DND_TYPES } from "./dndTypes";

describe("paneTabScopeType", () => {
  test("is deterministic for the same scope", () => {
    expect(paneTabScopeType("main")).toBe(paneTabScopeType("main"));
    expect(paneTabScopeType("/Users/me/proj")).toBe(paneTabScopeType("/Users/me/proj"));
  });

  test("distinct scopes produce distinct markers", () => {
    const main = paneTabScopeType("main");
    const projA = paneTabScopeType("/Users/me/projA");
    const projB = paneTabScopeType("/Users/me/projB");
    expect(new Set([main, projA, projB]).size).toBe(3);
  });

  test("marker is a safe, opaque lowercase ascii token", () => {
    // projectPaths can contain slashes, spaces, uppercase — the marker must not.
    const marker = paneTabScopeType("/Users/Me/My Project (v2)");
    expect(marker).toMatch(/^application\/x-pane-scope-[a-z0-9]+$/);
    expect(marker).toBe(marker.toLowerCase());
  });
});

describe("dragMatchesScope", () => {
  const typesFor = (scope: string): string[] => [
    DND_TYPES.PANE_TAB,
    DND_TYPES.PANE_TAB_GROUP,
    paneTabScopeType(scope),
  ];

  test("same scope matches", () => {
    expect(dragMatchesScope(typesFor("main"), "main")).toBe(true);
    expect(dragMatchesScope(typesFor("/p/a"), "/p/a")).toBe(true);
  });

  test("main tab is rejected by a project tab bar and vice-versa", () => {
    expect(dragMatchesScope(typesFor("main"), "/p/a")).toBe(false);
    expect(dragMatchesScope(typesFor("/p/a"), "main")).toBe(false);
  });

  test("project A tab is rejected by project B", () => {
    expect(dragMatchesScope(typesFor("/p/a"), "/p/b")).toBe(false);
  });

  test("undefined scope keeps legacy unrestricted behavior", () => {
    expect(dragMatchesScope(typesFor("main"), undefined)).toBe(true);
    expect(dragMatchesScope([], undefined)).toBe(true);
  });

  test("a drag with no scope marker is rejected by a scoped target", () => {
    // Legacy/foreign drag that never tagged a scope: a scoped bar ignores it.
    expect(dragMatchesScope([DND_TYPES.PANE_TAB], "main")).toBe(false);
  });
});
