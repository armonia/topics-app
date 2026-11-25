/**
 * @covers SYSTEM-DISK-01
 */
import { describe, expect, test } from "bun:test";
import { expiredMediaFiles, mediaRetentionDays, type MediaFileStat } from "./media-retention";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("mediaRetentionDays", () => {
  test("defaults to 0 (disabled) when unset", () => {
    expect(mediaRetentionDays({})).toBe(0);
  });

  test("reads TOPICS_MEDIA_RETENTION_DAYS", () => {
    expect(mediaRetentionDays({ TOPICS_MEDIA_RETENTION_DAYS: "30" })).toBe(30);
  });

  test("a non-numeric or non-positive value stays disabled, never 'keep forever' turning into 'delete now'", () => {
    expect(mediaRetentionDays({ TOPICS_MEDIA_RETENTION_DAYS: "nope" })).toBe(0);
    expect(mediaRetentionDays({ TOPICS_MEDIA_RETENTION_DAYS: "0" })).toBe(0);
    expect(mediaRetentionDays({ TOPICS_MEDIA_RETENTION_DAYS: "-5" })).toBe(0);
  });
});

describe("expiredMediaFiles", () => {
  const now = Date.now();
  const files: MediaFileStat[] = [
    { id: "old.png", mtimeMs: now - 100 * DAY_MS },
    { id: "fresh.png", mtimeMs: now - 1 * DAY_MS },
  ];

  test("disabled (0) never expires anything, regardless of age", () => {
    expect(expiredMediaFiles(files, now, 0)).toEqual([]);
  });

  test("once opted in, only the files older than the cutoff expire", () => {
    expect(expiredMediaFiles(files, now, 30)).toEqual(["old.png"]);
  });
});
