import { describe, expect, test } from "bun:test";
import { filesToCompress, transcriptCompressDays, type TranscriptFileStat } from "./transcript-retention";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("transcriptCompressDays", () => {
  test("defaults to 7 when unset", () => {
    expect(transcriptCompressDays({})).toBe(7);
  });

  test("reads TOPICS_TRANSCRIPT_COMPRESS_DAYS", () => {
    expect(transcriptCompressDays({ TOPICS_TRANSCRIPT_COMPRESS_DAYS: "3" })).toBe(3);
  });

  test("falls back on a non-numeric or non-positive value", () => {
    expect(transcriptCompressDays({ TOPICS_TRANSCRIPT_COMPRESS_DAYS: "nope" })).toBe(7);
    expect(transcriptCompressDays({ TOPICS_TRANSCRIPT_COMPRESS_DAYS: "0" })).toBe(7);
    expect(transcriptCompressDays({ TOPICS_TRANSCRIPT_COMPRESS_DAYS: "-1" })).toBe(7);
  });
});

describe("filesToCompress", () => {
  const now = Date.now();

  test("picks only uncompressed files older than the cutoff", () => {
    const files: TranscriptFileStat[] = [
      { id: "old.jsonl", mtimeMs: now - 10 * DAY_MS, compressed: false },
      { id: "fresh.jsonl", mtimeMs: now - 1 * DAY_MS, compressed: false },
      { id: "old-already.jsonl.gz", mtimeMs: now - 10 * DAY_MS, compressed: true },
    ];
    expect(filesToCompress(files, now, 7)).toEqual(["old.jsonl"]);
  });

  test("an active session's transcript (fresh mtime) is never touched", () => {
    const files: TranscriptFileStat[] = [{ id: "live.jsonl", mtimeMs: now, compressed: false }];
    expect(filesToCompress(files, now, 7)).toEqual([]);
  });
});
