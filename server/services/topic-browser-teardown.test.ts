/**
 * The browser window of an archived topic goes away, row and contexts.
 *
 * Minimal `:memory:` schema (same pattern as `task-tab-teardown.test.ts`): the
 * columns that appear here ARE this service's contract.
 * @covers TOPIC-BROWSER-01
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  purgeTopicBrowserState,
  topicBrowserKeyFor,
  TOPIC_BROWSER_PREFIX,
  type TopicBrowserTeardownDeps,
} from "./topic-browser-teardown";
import { purgeTopicFromUiState } from "../routes/topics";

let db: Database;
let broadcasts: any[];
let destroyed: string[];

function deps(): TopicBrowserTeardownDeps {
  return {
    db,
    broadcastToAll: (msg) => { broadcasts.push(msg); },
    destroyContext: (contextId) => { destroyed.push(contextId); },
  };
}

function putWindow(topicId: string, contextIds: string[]): void {
  db.run("INSERT OR REPLACE INTO ui_state (key, value, payload_version, server_seq) VALUES (?, ?, 2, 1)", [
    topicBrowserKeyFor(topicId),
    JSON.stringify({
      mode: "min",
      tabs: contextIds.map((contextId) => ({ contextId, url: `https://${contextId}.test`, title: contextId })),
      activeContextId: contextIds[0] ?? null,
      promoted: [],
    }),
  ]);
}

const keys = (): string[] =>
  (db.query("SELECT key FROM ui_state ORDER BY key").all() as { key: string }[]).map((r) => r.key);

beforeEach(() => {
  db = new Database(":memory:");
  db.run(`CREATE TABLE ui_state (
    key TEXT PRIMARY KEY, value TEXT NOT NULL,
    payload_version INTEGER NOT NULL DEFAULT 2, server_seq INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT
  )`);
  broadcasts = [];
  destroyed = [];
});

describe("purgeTopicBrowserState", () => {
  test("drops the topic's row and nothing else", () => {
    putWindow("tp-1", ["c-1"]);
    putWindow("tp-2", ["c-2"]);
    db.run("INSERT INTO ui_state (key, value) VALUES ('pane-store-v2', '{}')");

    const report = purgeTopicBrowserState(deps(), ["tp-1"]);

    expect(report.keysDeleted).toEqual([topicBrowserKeyFor("tp-1")]);
    expect(report.bytesFreed).toBeGreaterThan(0);
    expect(keys()).toEqual(["pane-store-v2", topicBrowserKeyFor("tp-2")]);
  });

  test("the sheets are closed on the devices and their contexts destroyed", () => {
    putWindow("tp-1", ["c-1", "c-2"]);

    const report = purgeTopicBrowserState(deps(), ["tp-1"]);

    expect(report.contextsReleased).toEqual(["c-1", "c-2"]);
    expect(destroyed).toEqual(["c-1", "c-2"]);
    expect(broadcasts).toEqual([
      { type: "browser:close-pane", contextId: "c-1" },
      { type: "browser:close-pane", contextId: "c-2" },
    ]);
  });

  test("a topic without a window is a no-op, and so is a second pass", () => {
    putWindow("tp-1", ["c-1"]);
    expect(purgeTopicBrowserState(deps(), ["nobody"]).keysDeleted).toEqual([]);
    expect(broadcasts).toEqual([]);

    purgeTopicBrowserState(deps(), ["tp-1"]);
    broadcasts = [];
    destroyed = [];
    const again = purgeTopicBrowserState(deps(), ["tp-1"]);
    expect(again.keysDeleted).toEqual([]);
    expect(destroyed).toEqual([]);
  });

  test("a corrupt row is still deleted, it just releases no context", () => {
    db.run("INSERT INTO ui_state (key, value) VALUES (?, 'not json')", [topicBrowserKeyFor("tp-1")]);
    const report = purgeTopicBrowserState(deps(), ["tp-1"]);
    expect(report.keysDeleted).toHaveLength(1);
    expect(report.contextsReleased).toEqual([]);
    expect(keys()).toEqual([]);
  });

  test("several topics in one call, deduplicated", () => {
    putWindow("tp-1", ["c-1"]);
    putWindow("tp-2", ["c-2"]);
    const report = purgeTopicBrowserState(deps(), ["tp-1", "tp-2", "tp-1", ""]);
    expect(report.keysDeleted.sort()).toEqual([topicBrowserKeyFor("tp-1"), topicBrowserKeyFor("tp-2")]);
    expect(keys()).toEqual([]);
  });

  test("the key is the one the client writes", () => {
    expect(topicBrowserKeyFor("tp-1")).toBe(`${TOPIC_BROWSER_PREFIX}tp-1`);
    expect(TOPIC_BROWSER_PREFIX).toBe("topic-browser:");
  });
});

/** The hook, not the service: archiving reaches this purge through
 *  `archiveTopicFully`, and it is the only door all three archive paths share.
 *  A green service wired nowhere is the state this card started from. */
describe("purgeTopicFromUiState (the door the archive goes through)", () => {
  test("deletes the topic's browser window and rewrites the shared records", () => {
    putWindow("tp-1", ["c-1"]);
    putWindow("tp-2", ["c-2"]);
    db.run("INSERT INTO ui_state (key, value) VALUES ('pane-store-v2', ?)", [
      JSON.stringify({ panes: { "chat:tp-1": { topicId: "tp-1" } } }),
    ]);

    const res = purgeTopicFromUiState(db, (msg) => { broadcasts.push(msg); }, "tp-1");

    expect(res.ok).toBe(true);
    expect(keys()).toEqual(["pane-store-v2", topicBrowserKeyFor("tp-2")]);
    expect(broadcasts.some((m) => m.type === "browser:close-pane" && m.contextId === "c-1")).toBe(true);
  });
});
