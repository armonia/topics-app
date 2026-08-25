/**
 * Activity log helper — unit tests.
 *
 * Exercises the central writer for the `activity_log` table introduced in the
 * stream-timeout-resilience change. The DB is in-memory (a fresh tmpdir per
 * test run) so we can verify retention semantics and the typed wrappers
 * without polluting the real topics.db.
  * @covers SYSTEM-LOG-01
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDatabase, closeDatabase, getDatabase } from "../db";
import {
  logActivity,
  logStreamSoftTimeout,
  logStreamHardTimeout,
  logStreamComplete,
  logStreamAborted,
  logStreamError,
  logStreamRecovered,
  listActivity,
} from "./activity-log";

let tmpRoot: string;

beforeAll(() => {
  // initDatabase reads migrations from baseDir/server/db/migrations and writes
  // the DB into baseDir/data — replicate that layout in a tmpdir so the
  // existing migration files run as-is.
  tmpRoot = mkdtempSync(join(tmpdir(), "activity-log-test-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  // Copy real migrations so the activity_log schema (migration 001) exists.
  const realMigDir = join(import.meta.dir, "migrations");
  const { readdirSync } = require("fs");
  for (const f of readdirSync(realMigDir)) {
    if (!f.endsWith(".sql")) continue;
    writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
    initDatabase(tmpRoot);
});

afterAll(() => {
  try { closeDatabase(); } catch {}
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("logActivity", () => {
  test("inserts a row with all fields populated", () => {
    logActivity({
      category: "test",
      level: "warn",
      title: "hello",
      detail: "world",
      sessionKey: "topic:abc",
      entityType: "topic",
      entityId: "topic-abc",
      actor: "user",
      metadata: { foo: 42 },
    });
    const rows = listActivity({ category: "test", limit: 10 });
    const row = rows.find(r => r.title === "hello");
    expect(row).toBeDefined();
    expect(row?.level).toBe("warn");
    expect(row?.detail).toBe("world");
    expect(row?.session_key).toBe("topic:abc");
    expect(row?.entity_id).toBe("topic-abc");
    expect(JSON.parse(row?.metadata ?? "{}").foo).toBe(42);
  });

  test("missing optional fields default cleanly", () => {
    logActivity({ category: "minimal", title: "bare" });
    const rows = listActivity({ category: "minimal" });
    const row = rows.find(r => r.title === "bare");
    expect(row?.level).toBe("info"); // default
    expect(row?.detail).toBeNull();
    expect(row?.metadata).toBeNull();
  });
});

describe("typed stream wrappers", () => {
  test("logStreamSoftTimeout writes warn", () => {
    logStreamSoftTimeout({ sessionKey: "topic:soft", durationMs: 120_000, toolCallCount: 0 });
    const rows = listActivity({ sessionKey: "topic:soft" });
    expect(rows[0]?.level).toBe("warn");
    expect(rows[0]?.title).toContain("soft timeout");
  });

  test("logStreamHardTimeout writes error", () => {
    logStreamHardTimeout({ sessionKey: "topic:hard", durationMs: 30 * 60_000 });
    const rows = listActivity({ sessionKey: "topic:hard" });
    expect(rows[0]?.level).toBe("error");
    expect(rows[0]?.title).toContain("hard timeout");
  });

  test("logStreamComplete writes info with usage", () => {
    logStreamComplete({
      sessionKey: "topic:done",
      durationMs: 3000,
      promptTokens: 100,
      completionTokens: 200,
      costCents: 5,
    });
    const rows = listActivity({ sessionKey: "topic:done" });
    const meta = JSON.parse(rows[0]?.metadata ?? "{}");
    expect(rows[0]?.level).toBe("info");
    expect(meta.promptTokens).toBe(100);
    expect(meta.completionTokens).toBe(200);
    expect(meta.costCents).toBe(5);
  });

  test("logStreamAborted writes info", () => {
    logStreamAborted({ sessionKey: "topic:abort", durationMs: 500 });
    const rows = listActivity({ sessionKey: "topic:abort" });
    expect(rows[0]?.level).toBe("info");
    expect(rows[0]?.title).toContain("aborted");
  });

  test("logStreamError writes error with detail", () => {
    logStreamError({ sessionKey: "topic:err", errorMessage: "boom" });
    const rows = listActivity({ sessionKey: "topic:err" });
    expect(rows[0]?.level).toBe("error");
    expect(rows[0]?.detail).toBe("boom");
  });

  test("logStreamRecovered writes info", () => {
    logStreamRecovered({ sessionKey: "topic:rec", durationMs: 15_000 });
    const rows = listActivity({ sessionKey: "topic:rec" });
    expect(rows[0]?.level).toBe("info");
    expect(rows[0]?.title).toContain("recovered");
  });
});

describe("retention", () => {
  test("table is capped at 10000 rows", () => {
    // Insert past the cap. Use a unique session_key so listActivity can
    // distinguish from the rows the other tests wrote.
    const session = "topic:cap-test";
    // To keep this fast, we manipulate the DB directly — the public helper
    // would be too slow at 10001 calls, but the retention path is what we're
    // testing, so a hand-rolled bulk insert is fine.
    const db = getDatabase();
    db.transaction(() => {
      const stmt = db.prepare(
        "INSERT INTO activity_log (id, timestamp, category, level, title, detail, entity_type, entity_id, actor, session_key, metadata) VALUES (?, ?, 'cap', 'info', 'bulk', NULL, NULL, NULL, NULL, ?, NULL)",
      );
      // Wipe existing
      db.run("DELETE FROM activity_log");
      const baseTime = Date.now();
      for (let i = 0; i < 10_000; i++) {
        const ts = new Date(baseTime - (10_001 - i) * 1000).toISOString();
        stmt.run(crypto.randomUUID(), ts, session);
      }
    })();

    const before = (db.query("SELECT COUNT(*) AS c FROM activity_log").get() as any).c;
    expect(before).toBe(10_000);

    // One more insert through the public helper — should trigger retention.
    logActivity({ category: "cap", title: "trigger", sessionKey: session });

    const after = (db.query("SELECT COUNT(*) AS c FROM activity_log").get() as any).c;
    expect(after).toBe(10_000); // not 10_001 — retention kicked in
  });
});
