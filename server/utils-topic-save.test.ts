/**
 * saveSingleTopic — cascade-safety regression tests.
 *
 * `insertTopic` MUST be a true UPSERT (ON CONFLICT DO UPDATE), never
 * `INSERT OR REPLACE`: SQLite resolves REPLACE by DELETE+INSERT, and with
 * PRAGMA foreign_keys=ON that hidden DELETE fires every ON DELETE action
 * pointing at topics. The observable damage of the REPLACE era, guarded here:
 *   - claude_code_sessions (the CLI `--resume` mapping) CASCADE-wiped on every
 *     topic update → chat respawned fresh and lost the model's session memory;
 *   - unread CASCADE-wiped;
 *   - children's parent_id SET NULL → topic hierarchy silently flattened.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase } from "./db";
import { createAppContext } from "./utils";
import type { AppContext, Topic } from "./types";

let tmpRoot: string;
let ctx: AppContext;

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
  // Replicate the real layout in a tmpdir so migrations run as-is (same
  // pattern as db/activity-log.test.ts).
  tmpRoot = mkdtempSync(join(tmpdir(), "topic-save-test-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(import.meta.dir, "db", "migrations");
  for (const f of readdirSync(realMigDir)) {
    if (!f.endsWith(".sql")) continue;
    writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
  mkdirSync(join(tmpRoot, "public"), { recursive: true });
  process.env.DATA_DIR = join(tmpRoot, "data");
  process.env.OPENCLAW_DIR = join(tmpRoot, "openclaw");
  ctx = createAppContext(tmpRoot);
});

afterAll(() => {
  try { closeDatabase(); } catch {}
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("saveSingleTopic upsert (no REPLACE cascade)", () => {
  test("re-saving a topic preserves its claude_code_sessions resume mapping", () => {
    const parent = makeTopic("11111111-aaaa-bbbb-cccc-000000000001");
    ctx.saveSingleTopic(parent);

    const now = new Date().toISOString();
    ctx.db
      .prepare(
        `INSERT INTO claude_code_sessions (session_key, claude_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(parent.sessionKey, "cli-session-uuid", now, now);

    // Simulate a PATCH: rename + bump updated_at, save again.
    ctx.saveSingleTopic({ ...parent, name: "Renamed", updatedAt: new Date().toISOString() });

    const row = ctx.db
      .prepare(`SELECT claude_session_id FROM claude_code_sessions WHERE session_key = ?`)
      .get(parent.sessionKey) as { claude_session_id: string } | undefined;
    expect(row?.claude_session_id).toBe("cli-session-uuid");

    const saved = ctx.getTopicById(parent.id);
    expect(saved?.name).toBe("Renamed");
  });

  test("re-saving a topic preserves unread state", () => {
    const topic = makeTopic("22222222-aaaa-bbbb-cccc-000000000002");
    ctx.saveSingleTopic(topic);
    ctx.db
      .prepare(`INSERT INTO unread (topic_id, last_read_at, unread_count) VALUES (?, ?, ?)`)
      .run(topic.id, new Date().toISOString(), 7);

    ctx.saveSingleTopic({ ...topic, archived: true });

    const row = ctx.db
      .prepare(`SELECT unread_count FROM unread WHERE topic_id = ?`)
      .get(topic.id) as { unread_count: number } | undefined;
    expect(row?.unread_count).toBe(7);
  });

  test("re-saving a parent topic does not null out children's parent_id", () => {
    const parent = makeTopic("33333333-aaaa-bbbb-cccc-000000000003");
    ctx.saveSingleTopic(parent);
    const child = makeTopic("44444444-aaaa-bbbb-cccc-000000000004", { parentId: parent.id });
    ctx.saveSingleTopic(child);

    ctx.saveSingleTopic({ ...parent, name: "Parent v2" });

    const row = ctx.db
      .prepare(`SELECT parent_id FROM topics WHERE id = ?`)
      .get(child.id) as { parent_id: string | null } | undefined;
    expect(row?.parent_id).toBe(parent.id);
  });

  test("brand-new topic still inserts", () => {
    const topic = makeTopic("55555555-aaaa-bbbb-cccc-000000000005");
    ctx.saveSingleTopic(topic);
    expect(ctx.getTopicById(topic.id)?.name).toBe(topic.name);
  });

  test("standalone survives the save/load round-trip (migration 044)", () => {
    // Regression: `standalone` was on the Topic type but had no DB column, so
    // it was silently dropped on save — the task-workspace / catch-all-session
    // presentation never actually took effect at runtime.
    const t = makeTopic("66666666-aaaa-bbbb-cccc-000000000006", {
      projectPath: "/tmp/.openclaw/workspace/tasks/66666666",
      standalone: true,
    });
    ctx.saveSingleTopic(t);
    expect(ctx.getTopicById(t.id)?.standalone).toBe(true);

    // Flipping it off round-trips too (undefined, not a stuck `true`).
    ctx.saveSingleTopic({ ...t, standalone: false });
    expect(ctx.getTopicById(t.id)?.standalone).toBeUndefined();

    // A normal topic never gains the flag.
    const plain = makeTopic("77777777-aaaa-bbbb-cccc-000000000007");
    ctx.saveSingleTopic(plain);
    expect(ctx.getTopicById(plain.id)?.standalone).toBeUndefined();
  });

  test("mcpPolicy survives the save/load round-trip (migration 049)", () => {
    // Same invariant as `standalone`: a Topic field without its column +
    // insertTopic binding + rowToTopic read silently drops on save.
    const t = makeTopic("88888888-aaaa-bbbb-cccc-000000000008", {
      mcpPolicy: "bridge-only",
    });
    ctx.saveSingleTopic(t);
    expect(ctx.getTopicById(t.id)?.mcpPolicy).toBe("bridge-only");

    // Clearing it round-trips too (absent, not a stuck value).
    ctx.saveSingleTopic({ ...t, mcpPolicy: null });
    expect(ctx.getTopicById(t.id)?.mcpPolicy).toBeUndefined();

    // A normal topic never gains the field.
    const plain = makeTopic("99999999-aaaa-bbbb-cccc-000000000009");
    ctx.saveSingleTopic(plain);
    expect(ctx.getTopicById(plain.id)?.mcpPolicy).toBeUndefined();
  });
});
