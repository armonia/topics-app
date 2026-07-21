import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";
import {
  insertCompactionMarker,
  getCompactionMarkersBySession,
  backfillPostTokens,
} from "./compaction-markers";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.run(readFileSync(join(import.meta.dir, "migrations", "056-compaction-markers.sql"), "utf-8"));
});

describe("compaction-markers persistence", () => {
  test("insert + read back by session", () => {
    const stored = insertCompactionMarker(db, {
      sessionKey: "sk1",
      topicId: "t1",
      afterMessageId: "m1",
      marker: { trigger: "auto", preTokens: 152000 },
    });
    expect(stored.id).toBeTruthy();
    expect(stored.trigger).toBe("auto");
    expect(stored.preTokens).toBe(152000);

    const rows = getCompactionMarkersBySession(db, "sk1");
    expect(rows.length).toBe(1);
    expect(rows[0].afterMessageId).toBe("m1");
    expect(rows[0].topicId).toBe("t1");
    expect(rows[0].preTokens).toBe(152000);
    expect(rows[0].postTokens).toBeUndefined();
  });

  test("unknown trigger + null anchor are stored faithfully", () => {
    insertCompactionMarker(db, { sessionKey: "sk2", marker: { trigger: "unknown" } });
    const rows = getCompactionMarkersBySession(db, "sk2");
    expect(rows[0].trigger).toBe("unknown");
    expect(rows[0].afterMessageId).toBeNull();
    expect(rows[0].topicId).toBeNull();
  });

  test("markers are session-scoped and creation-ordered", () => {
    insertCompactionMarker(db, { sessionKey: "sk3", marker: { trigger: "auto" } });
    insertCompactionMarker(db, { sessionKey: "sk3", marker: { trigger: "manual" } });
    insertCompactionMarker(db, { sessionKey: "other", marker: { trigger: "auto" } });
    const rows = getCompactionMarkersBySession(db, "sk3");
    expect(rows.length).toBe(2);
    expect(rows.map(r => r.trigger)).toEqual(["auto", "manual"]);
    expect(getCompactionMarkersBySession(db, "other").length).toBe(1);
  });

  test("backfillPostTokens fills the most recent marker missing a post count", () => {
    insertCompactionMarker(db, { sessionKey: "sk4", marker: { trigger: "auto", preTokens: 100 } });
    backfillPostTokens(db, "sk4", 42);
    const rows = getCompactionMarkersBySession(db, "sk4");
    expect(rows[0].postTokens).toBe(42);
    // A second backfill with no new pending marker is a no-op (doesn't overwrite).
    backfillPostTokens(db, "sk4", 999);
    expect(getCompactionMarkersBySession(db, "sk4")[0].postTokens).toBe(42);
  });
});
