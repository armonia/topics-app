/**
 * Unit: the pure tab-inventory logic (union/dedupe, label resolution, on-demand
 * metadata with timeout fallback, own-first sort) driven entirely through
 * injected deps — no server, DB, or live pane.
 * @covers BROWSER-CHAT-03
 */
import { test, expect } from "bun:test";
import {
  collectLiveContextIds,
  labelForContext,
  listBrowserTabs,
  type TabInventoryDeps,
} from "./browser-tab-inventory";
import type { Topic } from "./types";

function topic(id: string, name: string, contextId?: string): Topic {
  return {
    id,
    name,
    slug: name.toLowerCase(),
    parentId: null,
    links: [],
    sessionKey: `topic:${id}`,
    color: "",
    icon: "",
    createdAt: "",
    updatedAt: "",
    archived: false,
    ...(contextId
      ? { browserState: { url: "", contextId, lastActiveAt: 0 } }
      : {}),
  } as Topic;
}

function baseDeps(over: Partial<TabInventoryDeps> = {}): TabInventoryDeps {
  return {
    listDelegated: () => [],
    listContexts: () => [],
    getTopicById: () => null,
    findTopicByContextId: () => null,
    getTerminalSessionById: () => undefined,
    getTaskByContextId: () => null,
    fetchNativeStatus: async () => null,
    ...over,
  };
}

test("collectLiveContextIds unions and dedupes native + CDP ids", () => {
  const deps = baseDeps({
    listDelegated: () => ["a", "b"],
    listContexts: () => [
      { id: "b", url: "", title: "" },
      { id: "c", url: "", title: "" },
    ],
  });
  expect(collectLiveContextIds(deps)).toEqual(new Set(["a", "b", "c"]));
});

test("labelForContext resolves a topic by id", () => {
  const deps = baseDeps({ getTopicById: (id) => (id === "t1" ? topic("t1", "Roadmap") : null) });
  expect(labelForContext("t1", deps)).toEqual({ label: "Roadmap", kind: "topic" });
});

test("labelForContext resolves a topic by custom browserState.contextId", () => {
  const t = topic("t9", "Custom", "ctx-custom");
  const deps = baseDeps({
    findTopicByContextId: (c) => (c === "ctx-custom" ? t : null),
  });
  expect(labelForContext("ctx-custom", deps)).toEqual({ label: "Custom", kind: "topic" });
});

test("labelForContext resolves a terminal `term-<id>` with cwd basename", () => {
  const deps = baseDeps({
    getTerminalSessionById: (id) =>
      id === "42" ? { id: "42", name: "Claude", cwd: "/Users/me/Projects/topics-app" } : undefined,
  });
  expect(labelForContext("term-42", deps)).toEqual({
    label: "Claude · topics-app",
    kind: "terminal",
  });
});

test("labelForContext labels a task-owned `task-<id8>-…` ctx as 'Task: <text>'", () => {
  const deps = baseDeps({
    getTaskByContextId: (c) => (/^task-125aafd5-/.test(c) ? { text: "Refactor auth" } : null),
  });
  expect(labelForContext("task-125aafd5-a3f00abc", deps)).toEqual({ label: "Task: Refactor auth", kind: "other" });
  expect(labelForContext("task-125aafd5-0", deps)).toEqual({ label: "Task: Refactor auth", kind: "other" });
});

test("labelForContext: task branch ignores non-hex id8 and empty task text", () => {
  // 'nothex' isn't a hex id8 → the regex never fires, no lookup, plain fallback.
  const spy = { called: false };
  const deps = baseDeps({ getTaskByContextId: () => { spy.called = true; return null; } });
  expect(labelForContext("task-nothex-1", deps, { title: "Fallback" })).toEqual({ label: "Fallback", kind: "other" });
  expect(spy.called).toBe(false);
  // Valid shape but the task has no text → labelled "Task".
  const deps2 = baseDeps({ getTaskByContextId: () => ({ text: "" }) });
  expect(labelForContext("task-deadbeef-0", deps2)).toEqual({ label: "Task", kind: "other" });
});

test("labelForContext falls back to title → hostname → contextId for unknown ids", () => {
  const deps = baseDeps();
  expect(labelForContext("z", deps, { title: "GitHub" })).toEqual({ label: "GitHub", kind: "other" });
  expect(labelForContext("z", deps, { url: "https://example.com/path" })).toEqual({
    label: "example.com",
    kind: "other",
  });
  expect(labelForContext("z", deps, {})).toEqual({ label: "z", kind: "other" });
});

test("listBrowserTabs uses fresh native status and marks isOwn", async () => {
  const deps = baseDeps({
    listDelegated: () => ["t1"],
    getTopicById: (id) => (id === "t1" ? topic("t1", "Roadmap") : null),
    fetchNativeStatus: async (id) =>
      id === "t1" ? { url: "https://roadmap.test", title: "Roadmap page" } : null,
  });
  const tabs = await listBrowserTabs(deps, "t1");
  expect(tabs).toHaveLength(1);
  expect(tabs[0]).toEqual({
    contextId: "t1",
    url: "https://roadmap.test",
    title: "Roadmap page",
    label: "Roadmap",
    kind: "topic",
    isOwn: true,
  });
});

test("listBrowserTabs dedupes a dual-registered id (native status wins over CDP row)", async () => {
  const deps = baseDeps({
    listDelegated: () => ["dup"],
    listContexts: () => [{ id: "dup", url: "https://stale", title: "stale" }],
    fetchNativeStatus: async () => ({ url: "https://fresh", title: "fresh" }),
  });
  const tabs = await listBrowserTabs(deps, null);
  expect(tabs).toHaveLength(1);
  expect(tabs[0].url).toBe("https://fresh");
});

test("listBrowserTabs falls back to the CDP row when native status times out", async () => {
  const deps = baseDeps({
    statusTimeoutMs: 20,
    listDelegated: () => ["wedged"],
    listContexts: () => [{ id: "wedged", url: "https://last-known", title: "Last known" }],
    // Never resolves within the timeout → the entry must still list.
    fetchNativeStatus: () => new Promise(() => {}),
  });
  const tabs = await listBrowserTabs(deps, null);
  expect(tabs).toHaveLength(1);
  expect(tabs[0]).toMatchObject({ contextId: "wedged", url: "https://last-known", title: "Last known" });
});

test("listBrowserTabs sorts own-first, then topic → terminal → other", async () => {
  const deps = baseDeps({
    listContexts: () => [
      { id: "other-x", url: "https://x.com", title: "X" },
      { id: "t-topic", url: "", title: "" },
      { id: "term-7", url: "", title: "" },
      { id: "t-own", url: "", title: "" },
    ],
    getTopicById: (id) =>
      id === "t-topic" ? topic("t-topic", "Topic") : id === "t-own" ? topic("t-own", "Own") : null,
    getTerminalSessionById: (id) => (id === "7" ? { id: "7", name: "Term", cwd: "/tmp/proj" } : undefined),
  });
  const tabs = await listBrowserTabs(deps, "t-own");
  expect(tabs.map((t) => t.contextId)).toEqual(["t-own", "t-topic", "term-7", "other-x"]);
  expect(tabs[0].isOwn).toBe(true);
});
