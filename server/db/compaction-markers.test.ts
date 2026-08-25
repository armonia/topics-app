/**
 * @covers CHAT-COMPACT-01
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";
import {
  insertCompactionMarker,
  insertCompactionMarkerIfNew,
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

  test("backfillPostTokens rejects a post >= pre (a compaction never grows the context)", () => {
    // The old wiring fed this the TURN AGGREGATE from the final `result` usage,
    // so real markers ended up claiming "167k -> 11.2M token". A compaction
    // shrinks the context by definition: refuse the reading instead of
    // persisting a confidently-wrong delta.
    insertCompactionMarker(db, { sessionKey: "sk5", marker: { trigger: "auto", preTokens: 167_386 } });
    expect(backfillPostTokens(db, "sk5", 11_257_662)).toBeNull();
    expect(getCompactionMarkersBySession(db, "sk5")[0].postTokens).toBeUndefined();
    // The marker stays open, so an honest measurement can still land later.
    expect(backfillPostTokens(db, "sk5", 12_004)?.postTokens).toBe(12_004);
  });

  test("backfillPostTokens accepts a post < pre with no pre recorded at all", () => {
    insertCompactionMarker(db, { sessionKey: "sk6", marker: { trigger: "manual" } });
    expect(backfillPostTokens(db, "sk6", 9_000)?.postTokens).toBe(9_000);
  });

  test("insertCompactionMarkerIfNew collapses repeats at the same anchor", () => {
    const first = insertCompactionMarkerIfNew(db, {
      sessionKey: "sk7",
      afterMessageId: "m1",
      marker: { trigger: "auto", preTokens: 150_000 },
    });
    // Same anchor within the turn → no new row; the boundary is enriched, not duplicated.
    const again = insertCompactionMarkerIfNew(db, {
      sessionKey: "sk7",
      afterMessageId: "m1",
      marker: { trigger: "auto", postTokens: 40_000 },
    });
    expect(again.id).toBe(first.id);
    const rows = getCompactionMarkersBySession(db, "sk7");
    expect(rows.length).toBe(1);
    expect(rows[0].preTokens).toBe(150_000);
    expect(rows[0].postTokens).toBe(40_000); // enriched from the repeat
  });

  test("insertCompactionMarkerIfNew inserts when the anchor advances", () => {
    insertCompactionMarkerIfNew(db, { sessionKey: "sk8", afterMessageId: "m1", marker: { trigger: "auto" } });
    insertCompactionMarkerIfNew(db, { sessionKey: "sk8", afterMessageId: "m1", marker: { trigger: "auto" } });
    // New turn → new anchor → a genuinely distinct boundary is recorded.
    insertCompactionMarkerIfNew(db, { sessionKey: "sk8", afterMessageId: "m2", marker: { trigger: "auto" } });
    const rows = getCompactionMarkersBySession(db, "sk8");
    expect(rows.map(r => r.afterMessageId)).toEqual(["m1", "m2"]);
  });

  test("insertCompactionMarkerIfNew collapses consecutive null anchors too", () => {
    insertCompactionMarkerIfNew(db, { sessionKey: "sk9", marker: { trigger: "auto" } });
    insertCompactionMarkerIfNew(db, { sessionKey: "sk9", marker: { trigger: "auto" } });
    expect(getCompactionMarkersBySession(db, "sk9").length).toBe(1);
  });

  test("backfillPostTokens returns the updated marker (for re-broadcast), else null", () => {
    const m = insertCompactionMarker(db, { sessionKey: "sk5", marker: { trigger: "manual", preTokens: 200 } });
    const filled = backfillPostTokens(db, "sk5", 55);
    expect(filled).not.toBeNull();
    expect(filled!.id).toBe(m.id);
    expect(filled!.postTokens).toBe(55);
    expect(filled!.preTokens).toBe(200);
    // Nothing left to fill → null (so the caller skips the re-broadcast).
    expect(backfillPostTokens(db, "sk5", 999)).toBeNull();
    // Unknown session → null.
    expect(backfillPostTokens(db, "nope", 10)).toBeNull();
    // Invalid post count → null (guard).
    insertCompactionMarker(db, { sessionKey: "sk6", marker: { trigger: "auto" } });
    expect(backfillPostTokens(db, "sk6", -1)).toBeNull();
    expect(backfillPostTokens(db, "sk6", NaN)).toBeNull();
  });
});
