/**
 * @covers SYSTEM-DISK-01
 */
import { describe, expect, test } from "bun:test";
import { expiredLogFiles, logRetentionDays } from "./log-retention";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("logRetentionDays", () => {
  test("defaults to 14 days with no configuration", () => {
    expect(logRetentionDays({})).toBe(14);
  });

  test("reads TOPICS_LOG_RETENTION_DAYS", () => {
    expect(logRetentionDays({ TOPICS_LOG_RETENTION_DAYS: "30" })).toBe(30);
  });

  test("a non-numeric or non-positive value falls back to the default, never to unlimited", () => {
    expect(logRetentionDays({ TOPICS_LOG_RETENTION_DAYS: "nope" })).toBe(14);
    expect(logRetentionDays({ TOPICS_LOG_RETENTION_DAYS: "0" })).toBe(14);
    expect(logRetentionDays({ TOPICS_LOG_RETENTION_DAYS: "-5" })).toBe(14);
  });
});

describe("expiredLogFiles", () => {
  const now = Date.parse("2026-11-21T00:00:00Z");

  test("keeps a file written within the retention window", () => {
    const files = [{ id: "fresh.log", mtimeMs: now - 1 * DAY_MS }];
    expect(expiredLogFiles(files, now, 14)).toEqual([]);
  });

  test("expires a file older than the retention window", () => {
    const files = [{ id: "old.log", mtimeMs: now - 15 * DAY_MS }];
    expect(expiredLogFiles(files, now, 14)).toEqual(["old.log"]);
  });

  test("a file exactly at the cutoff is not yet expired", () => {
    const files = [{ id: "edge.log", mtimeMs: now - 14 * DAY_MS }];
    expect(expiredLogFiles(files, now, 14)).toEqual([]);
  });

  test("sorts fresh and expired files apart", () => {
    const files = [
      { id: "fresh.log", mtimeMs: now - 1 * DAY_MS },
      { id: "old.log", mtimeMs: now - 20 * DAY_MS },
      { id: "ancient.log", mtimeMs: now - 365 * DAY_MS },
    ];
    expect(expiredLogFiles(files, now, 14)).toEqual(["old.log", "ancient.log"]);
  });
});
