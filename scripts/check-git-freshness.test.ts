/** @covers D3H-01 */
import { describe, expect, test } from "bun:test";
import { freshnessExitCode, isMatchingGitStatus, median, percentile95 } from "./git-freshness-metrics";

describe("git freshness measurement helpers", () => {
  test("uses nearest-rank p95 and an interpolated median", () => {
    expect(percentile95([10, 1, 9, 3, 7, 5, 2, 8, 4, 6])).toBe(10);
    expect(median([1, 4, 2, 3])).toBe(2.5);
  });

  test("accepts only the matching project status that contains the saved file", () => {
    const event = { type: "git:status", projectPath: "/repo", status: { files: [{ path: "src/a.ts" }] } };
    expect(isMatchingGitStatus(event, "/repo", "src/a.ts")).toBe(true);
    expect(isMatchingGitStatus({ ...event, projectPath: "/other" }, "/repo", "src/a.ts")).toBe(false);
    expect(isMatchingGitStatus({ ...event, status: { files: [{ path: "src/old.ts" }] } }, "/repo", "src/a.ts")).toBe(false);
    expect(isMatchingGitStatus({ type: "files:changed", projectPath: "/repo", status: { files: [{ path: "src/a.ts" }] } }, "/repo", "src/a.ts")).toBe(false);
  });

  test("turns a p95 over budget red and accepts the exact budget", () => {
    expect(freshnessExitCode(150, 150)).toBe(0);
    expect(freshnessExitCode(150.01, 150)).toBe(1);
  });
});
