/**
 * @covers CHAT-01
 *
 * searchTranscripts — legacy JSONL scan robustness.
 *
 * Regression coverage for a catch-swallows-everything bug: a bare `null` JSONL
 * row used to throw while reading `.type`/`.message` OUTSIDE the inner
 * try/catch (which only guarded `JSON.parse`), aborting the whole session's
 * scan silently. And the try wrapping `sessions.json` itself logged nothing on
 * failure, so an unreadable/malformed store looked identical to "no legacy
 * transcripts" from the outside.
 */

import { describe, expect, test, beforeAll, afterAll, spyOn } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase } from "./db";
import { createAppContext } from "./utils";
import type { AppContext, Topic } from "./types";

const DATA_DIR_PRIMA = process.env.DATA_DIR;
const APP_DATA_DIR_PRIMA = process.env.APP_DATA_DIR;
const SESSIONS_DIR_PRIMA = process.env.SESSIONS_DIR;

let tmpRoot: string;
let ctx: AppContext;
let sessionsDir: string;

function makeTopic(id: string, over: Partial<Topic> = {}): Topic {
  const now = new Date().toISOString();
  return {
    id,
    name: `Topic ${id}`,
    slug: `topic-${id}`,
    parentId: null,
    links: [],
    sessionKey: `topic:${id.slice(0, 8)}`,
    color: "#aabbcc",
    icon: "chat",
    createdAt: now,
    updatedAt: now,
    archived: false,
    ...over,
  };
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "search-transcripts-test-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(import.meta.dir, "db", "migrations");
  for (const f of readdirSync(realMigDir)) {
    if (!f.endsWith(".sql")) continue;
    writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
  mkdirSync(join(tmpRoot, "public"), { recursive: true });
  process.env.DATA_DIR = join(tmpRoot, "data");
  process.env.APP_DATA_DIR = join(tmpRoot, "app-data");
  sessionsDir = join(tmpRoot, "sessions");
  process.env.SESSIONS_DIR = sessionsDir;
  mkdirSync(sessionsDir, { recursive: true });
  ctx = createAppContext(tmpRoot);
});

afterAll(() => {
  try { closeDatabase(); } catch { /* test teardown: the db may already be closed */ }
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* test teardown: temp dir may already be gone */ }
  if (DATA_DIR_PRIMA === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = DATA_DIR_PRIMA;
  if (APP_DATA_DIR_PRIMA === undefined) delete process.env.APP_DATA_DIR; else process.env.APP_DATA_DIR = APP_DATA_DIR_PRIMA;
  if (SESSIONS_DIR_PRIMA === undefined) delete process.env.SESSIONS_DIR; else process.env.SESSIONS_DIR = SESSIONS_DIR_PRIMA;
});

describe("searchTranscripts — legacy JSONL scan", () => {
  test("a bare `null` JSONL row is skipped, not fatal to the rest of the session's scan", () => {
    const topic = makeTopic("11111111-aaaa-bbbb-cccc-000000000001");
    ctx.saveSingleTopic(topic);
    writeFileSync(
      join(sessionsDir, "sessions.json"),
      JSON.stringify({ [topic.sessionKey]: { sessionId: "sess-null-row" } }),
    );
    writeFileSync(
      join(sessionsDir, "sess-null-row.jsonl"),
      [
        "null",
        JSON.stringify({ type: "message", message: { role: "user", content: "findable-after-null-row" }, timestamp: "2024-01-01T00:00:00Z" }),
      ].join("\n"),
    );

    const hits = ctx.searchTranscripts("findable-after-null-row");
    expect(hits.some((h) => h.content === "findable-after-null-row")).toBe(true);
  });

  test("a null element inside message content is skipped, the rest of the session is still searched", () => {
    const topic = makeTopic("22222222-aaaa-bbbb-cccc-000000000002");
    ctx.saveSingleTopic(topic);
    writeFileSync(
      join(sessionsDir, "sessions.json"),
      JSON.stringify({ [topic.sessionKey]: { sessionId: "sess-null-content" } }),
    );
    writeFileSync(
      join(sessionsDir, "sess-null-content.jsonl"),
      [
        JSON.stringify({ type: "message", message: { role: "user", content: [null] } }),
        JSON.stringify({ type: "message", message: { role: "user", content: "findable-after-null-element" }, timestamp: "2024-01-01T00:00:00Z" }),
      ].join("\n"),
    );

    const hits = ctx.searchTranscripts("findable-after-null-element");
    expect(hits.some((h) => h.content === "findable-after-null-element")).toBe(true);
  });

  test("malformed sessions.json logs a warning naming the real cause, and SQLite hits still come back", () => {
    const topic = makeTopic("22222222-aaaa-bbbb-cccc-000000000002");
    ctx.saveSingleTopic(topic);
    ctx.db
      .prepare(
        `INSERT INTO messages (id, session_key, role, content, timestamp, sort_order) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("msg-sqlite-1", topic.sessionKey, "user", "sqlite-hit-despite-broken-store", new Date().toISOString(), 0);
    // Malformed on purpose: the outer try wraps JSON.parse(sessions.json) itself.
    writeFileSync(join(sessionsDir, "sessions.json"), "{not json");

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const hits = ctx.searchTranscripts("sqlite-hit-despite-broken-store");
      expect(hits.some((h) => h.content === "sqlite-hit-despite-broken-store")).toBe(true);
      const lines = warn.mock.calls.map((args) => args.map(String).join(" "));
      expect(lines.some((l) => l.includes("[Search] legacy sessions.json scan failed:"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
