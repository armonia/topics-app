import { describe, test, expect } from "bun:test";
import type { Pane } from "../../../types";
import {
  createPaneId,
  createDraftPaneId,
  createGroupId,
  getAddableTypesForScope,
  getPaneConfig,
  isUUIDLike,
  isKnownPanePrefix,
  isDraftPaneId,
  isProjectPaneId,
  isTaskWorkspacePath,
  isBrowserPaneId,
  isTerminalPaneId,
  isSessionViewerPaneId,
  getProjectPathFromPaneId,
  getBrowserContextFromPaneId,
  getTerminalSessionFromPaneId,
  getSessionKeyFromViewerPaneId,
  pinKeyForPane,
} from "./paneConfig";

describe("createPaneId — per-type branching", () => {
  test("chat with a key builds a stable chat:<key> id (no random suffix)", () => {
    expect(createPaneId("chat", "topic-123")).toBe("chat:topic-123");
  });

  test("project with a key URL-encodes the key (path separators, spaces)", () => {
    expect(createPaneId("project", "/Users/a b/proj")).toBe(
      `project:${encodeURIComponent("/Users/a b/proj")}`,
    );
  });

  test("browser with a key builds browser:<key> verbatim (no encoding)", () => {
    expect(createPaneId("browser", "ctx-abc")).toBe("browser:ctx-abc");
  });

  test("terminal with a key builds terminal:<key> verbatim", () => {
    expect(createPaneId("terminal", "sess-xyz")).toBe("terminal:sess-xyz");
  });

  test("session-viewer with a key builds session-viewer:<key> verbatim", () => {
    expect(createPaneId("session-viewer", "sk-1")).toBe("session-viewer:sk-1");
  });

  test("chat WITHOUT a key falls through to the generic <type>:<uuid> branch", () => {
    const id = createPaneId("chat");
    expect(id.startsWith("chat:")).toBe(true);
    expect(isUUIDLike(id.slice("chat:".length))).toBe(true);
  });

  test("a type with no dedicated branch (e.g. 'file') always gets a fresh uuid", () => {
    const a = createPaneId("file");
    const b = createPaneId("file");
    expect(a.startsWith("file:")).toBe(true);
    expect(a).not.toBe(b); // two calls must not collide
  });
});

describe("createDraftPaneId / createGroupId", () => {
  test("draft ids are prefixed and recognised by isDraftPaneId", () => {
    const id = createDraftPaneId();
    expect(id.startsWith("draft:")).toBe(true);
    expect(isDraftPaneId(id)).toBe(true);
    expect(isDraftPaneId("chat:not-a-draft")).toBe(false);
  });

  test("group ids are monotonically distinct across calls", () => {
    const a = createGroupId();
    const b = createGroupId();
    expect(a).not.toBe(b);
    expect(a.startsWith("group:")).toBe(true);
  });
});

describe("pane-id prefix predicates + extractors round-trip", () => {
  test("project: is* predicate + path extractor decode round-trip", () => {
    const id = createPaneId("project", "/work/guidoai");
    expect(isProjectPaneId(id)).toBe(true);
    expect(isBrowserPaneId(id)).toBe(false);
    expect(getProjectPathFromPaneId(id)).toBe("/work/guidoai");
  });

  test("browser: is* predicate + context extractor round-trip", () => {
    const id = createPaneId("browser", "ctx-42");
    expect(isBrowserPaneId(id)).toBe(true);
    expect(getBrowserContextFromPaneId(id)).toBe("ctx-42");
    expect(getBrowserContextFromPaneId("terminal:foo")).toBeNull();
  });

  test("isTaskWorkspacePath: only …/workspace/tasks/<id> paths, not real projects", () => {
    expect(isTaskWorkspacePath("/Users/x/.openclaw/workspace/tasks/92a1091a")).toBe(true);
    expect(isTaskWorkspacePath("/Users/x/.openclaw/workspace/tasks/92a1091a/")).toBe(true);
    // Real projects and the shared catch-all dir are NOT task workspaces.
    expect(isTaskWorkspacePath("/Users/x/Projects/alpha")).toBe(false);
    expect(isTaskWorkspacePath("/Users/x/.openclaw/workspace/generale")).toBe(false);
    // A deeper path inside a task dir is not the workspace root itself.
    expect(isTaskWorkspacePath("/Users/x/.openclaw/workspace/tasks/92a1091a/src")).toBe(false);
    expect(isTaskWorkspacePath(null)).toBe(false);
    expect(isTaskWorkspacePath(undefined)).toBe(false);
  });

  test("terminal: is* predicate + session extractor round-trip", () => {
    const id = createPaneId("terminal", "sess-7");
    expect(isTerminalPaneId(id)).toBe(true);
    expect(getTerminalSessionFromPaneId(id)).toBe("sess-7");
    expect(getTerminalSessionFromPaneId("browser:foo")).toBeNull();
  });

  test("session-viewer: is* predicate + key extractor round-trip", () => {
    const id = createPaneId("session-viewer", "sk-99");
    expect(isSessionViewerPaneId(id)).toBe(true);
    expect(getSessionKeyFromViewerPaneId(id)).toBe("sk-99");
    expect(getSessionKeyFromViewerPaneId("chat:foo")).toBeNull();
  });

  test("isKnownPanePrefix recognises every documented prefix and rejects an unknown one", () => {
    for (const id of ["project:x", "browser:x", "terminal:x", "draft:x", "chat:x", "session-viewer:x", "process-log:x", "__internal"]) {
      expect(isKnownPanePrefix(id)).toBe(true);
    }
    expect(isKnownPanePrefix("bogus:x")).toBe(false);
  });
});

describe("isUUIDLike", () => {
  test("accepts a canonical v4-shaped uuid (case-insensitive)", () => {
    expect(isUUIDLike("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
    expect(isUUIDLike("123E4567-E89B-12D3-A456-426614174000")).toBe(true);
  });

  test("rejects non-uuid strings, including a plain session/topic id", () => {
    expect(isUUIDLike("topic-123")).toBe(false);
    expect(isUUIDLike("")).toBe(false);
    expect(isUUIDLike("123e4567-e89b-12d3-a456-42661417400")).toBe(false); // one digit short
  });
});

describe("getAddableTypesForScope — scope + singleton filtering", () => {
  test("'standalone' scope excludes project-only types (files, git)", () => {
    const types = getAddableTypesForScope("standalone");
    expect(types).toContain("browser");
    expect(types).toContain("terminal");
    expect(types).not.toContain("files");
    expect(types).not.toContain("git");
  });

  test("'project' scope includes the project-only singleton types", () => {
    const types = getAddableTypesForScope("project");
    expect(types).toContain("files");
    expect(types).toContain("git");
    expect(types).toContain("browser");
    expect(types).toContain("terminal");
  });

  test("'chat' is never surfaced in either scope (dedicated onNewChat affordance)", () => {
    expect(getAddableTypesForScope("standalone")).not.toContain("chat");
    expect(getAddableTypesForScope("project")).not.toContain("chat");
  });

  test("a singleton type already present is excluded via excludeSingletonsPresent", () => {
    const withoutFiles = getAddableTypesForScope("project", new Set(["files"]));
    expect(withoutFiles).not.toContain("files");
    // A non-singleton type in the exclusion set is unaffected (exclusion only
    // applies when config.singleton is true).
    const withBrowserExcluded = getAddableTypesForScope("project", new Set(["browser"]));
    expect(withBrowserExcluded).toContain("browser");
  });

  test("fixed panes never appear regardless of scope", () => {
    // No shipped config currently sets `fixed`, so this asserts the invariant
    // holds for the full addable set rather than any single named type.
    const types = [...getAddableTypesForScope("standalone"), ...getAddableTypesForScope("project")];
    for (const t of types) {
      expect(getPaneConfig(t).fixed).not.toBe(true);
    }
  });
});

describe("pinKeyForPane — one canonical pin key per tab type", () => {
  const pane = (p: Partial<Pane> & { id: string; type: Pane["type"] }): Pane => p as Pane;

  test("chat → the bare topicId (NOT the chat:<id> pane id)", () => {
    expect(pinKeyForPane(pane({ id: createPaneId("chat", "topic-9"), type: "chat", topicId: "topic-9" }))).toBe("topic-9");
  });

  test("terminal → the terminal:<sessionId> pane id verbatim", () => {
    const id = createPaneId("terminal", "sess-7");
    expect(pinKeyForPane(pane({ id, type: "terminal" }))).toBe(id);
  });

  test("browser → the browser:<contextId> pane id verbatim (the regression this fixes)", () => {
    const id = createPaneId("browser", "ctx-42");
    expect(pinKeyForPane(pane({ id, type: "browser" }))).toBe(id);
  });

  test("project → the project:<encodedPath> pane id verbatim", () => {
    const id = createPaneId("project", "/work/x");
    expect(pinKeyForPane(pane({ id, type: "project" }))).toBe(id);
  });

  test("chat with no topicId, and non-pinnable ephemeral types, return undefined", () => {
    expect(pinKeyForPane(pane({ id: "chat:x", type: "chat" }))).toBeUndefined();
    for (const type of ["file", "git", "activity", "journal", "agents", "dashboard"] as Pane["type"][]) {
      expect(pinKeyForPane(pane({ id: `${type}:x`, type }))).toBeUndefined();
    }
  });
});

describe("getPaneConfig — safe lookup with chat fallback", () => {
  test("a reserved type with no PANE_CONFIG entry falls back to the chat config", () => {
    // 'agent' (singular) is a reserved future PaneType with no PANE_CONFIG
    // entry — distinct from 'agents' (plural), which IS configured.
    expect(getPaneConfig("agent")).toBe(getPaneConfig("chat"));
  });

  test("a configured type returns its own entry, not the fallback", () => {
    expect(getPaneConfig("terminal").label).toBe("Terminal");
  });
});
