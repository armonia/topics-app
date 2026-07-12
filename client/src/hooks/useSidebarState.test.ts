/**
 * sanitizeSidebarPayload — regression tests for the sidebar-state corruption.
 *
 * A pre-migration-012 client once PUT the whole GET envelope
 * ({ value, payload_version, server_seq }) back as the state, so the stored
 * value grew recursively-nested envelopes and every later client re-persisted
 * the junk verbatim (the spread over DEFAULT_STATE does NOT drop extra keys
 * at runtime). The web sidebar then read pinnedItems from the wrong nesting
 * level → "Fissati" empty on web while desktop showed its localStorage copy.
 */

import { describe, expect, test } from "bun:test";
import { sanitizeSidebarPayload } from "./useSidebarState";

const REAL_STATE = {
  expandedNodes: ["project:/x"],
  viewMode: "timeline" as const,
  showArchived: false,
  pinnedItems: ["topic-1", "project:/y"],
  showProjects: true,
  showChats: true,
  showTerminals: true,
  showProjectsArchived: false,
  showChatsArchived: true,
  browserExpanded: false,
};

describe("sanitizeSidebarPayload", () => {
  test("plain state passes through with only known keys", () => {
    const out = sanitizeSidebarPayload({ ...REAL_STATE, junk: 1, payload_version: 2 });
    expect(out).toEqual(REAL_STATE);
    expect(out && ("junk" in out)).toBe(false);
  });

  test("unwraps a single GET envelope", () => {
    const out = sanitizeSidebarPayload({ value: REAL_STATE, payload_version: 2, server_seq: 42 });
    expect(out?.pinnedItems).toEqual(["topic-1", "project:/y"]);
    expect(out && ("server_seq" in out)).toBe(false);
  });

  test("heals the historical recursively-nested corruption (envelope in envelope)", () => {
    // Shape observed in production 2026-07-12: v2 envelope wrapping a stored
    // value that is itself a v2 envelope wrapping a v1 envelope wrapping the
    // real state.
    const corrupted = {
      value: {
        expandedNodes: [],
        pinnedItems: [],
        payload_version: 2,
        server_seq: 993,
        value: {
          payload_version: 1,
          server_seq: 0,
          value: REAL_STATE,
        },
      },
      payload_version: 2,
      server_seq: 1357664,
    };
    const out = sanitizeSidebarPayload(corrupted);
    expect(out?.pinnedItems).toEqual(["topic-1", "project:/y"]);
    expect(out?.expandedNodes).toEqual(["project:/x"]);
    expect(out && ("value" in out)).toBe(false);
  });

  test("intermediate envelope levels do NOT shadow the innermost real state", () => {
    // The corrupted middle level carries stale pinnedItems: [] — the healer
    // must descend past it, not merge it.
    const corrupted = {
      value: { pinnedItems: [], payload_version: 2, server_seq: 1, value: { pinnedItems: ["a"] } },
      payload_version: 2,
      server_seq: 2,
    };
    expect(sanitizeSidebarPayload(corrupted)?.pinnedItems).toEqual(["a"]);
  });

  test("non-object cores return null", () => {
    expect(sanitizeSidebarPayload(null)).toBeNull();
    expect(sanitizeSidebarPayload("nope")).toBeNull();
    expect(sanitizeSidebarPayload({ value: null, server_seq: 3 })).toBeNull();
  });

  test("a state that legitimately lacks envelope keys is untouched", () => {
    const partial = { pinnedItems: ["only-pins"] };
    expect(sanitizeSidebarPayload(partial)).toEqual({ pinnedItems: ["only-pins"] });
  });
});
