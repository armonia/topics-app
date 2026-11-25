/**
 * @covers REVIEWPR-01
 */
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildReviewPrompt,
  parseArgs,
  parseOpenPullRequests,
  repoFromRemote,
  truncateDiff,
  type OpenPr,
} from "./review-open-prs";

const pr: OpenPr = {
  number: 42,
  title: "Add retry to the sync loop",
  url: "https://github.com/example/app/pull/42",
  headRefName: "feature/retry",
  baseRefName: "main",
  isDraft: false,
  updatedAt: "2026-11-15T10:00:00Z",
};

describe("repoFromRemote", () => {
  test("reads SSH and HTTPS GitHub remotes", () => {
    expect(repoFromRemote("git@github.com:example/app.git")).toBe("example/app");
    expect(repoFromRemote("https://github.com/example/app")).toBe("example/app");
    expect(repoFromRemote("https://github.com/example/app.git/\n")).toBe("example/app");
  });

  test("returns null for a non-GitHub remote", () => {
    expect(repoFromRemote("/srv/git/app.git")).toBeNull();
    expect(repoFromRemote("git@gitlab.com:example/app.git")).toBeNull();
  });
});

describe("parseOpenPullRequests", () => {
  test("accepts the shape gh pr list prints", () => {
    expect(parseOpenPullRequests(JSON.stringify([pr]))).toEqual([pr]);
    expect(parseOpenPullRequests("[]")).toEqual([]);
  });

  test("throws on a non-array or a row with a missing field", () => {
    expect(() => parseOpenPullRequests('{"number":1}')).toThrow("did not return an array");
    const { title: _title, ...noTitle } = pr;
    expect(() => parseOpenPullRequests(JSON.stringify([noTitle]))).toThrow("entry 0");
  });

  test("throws on invalid JSON", () => {
    expect(() => parseOpenPullRequests("not json")).toThrow();
  });
});

describe("truncateDiff", () => {
  test("keeps a short diff whole and cuts a long one with a marker", () => {
    expect(truncateDiff("abc", 10)).toBe("abc");
    const cut = truncateDiff("abcdefghij", 4);
    expect(cut.startsWith("abcd\n")).toBe(true);
    expect(cut).toContain("6 characters left out");
  });
});

describe("buildReviewPrompt", () => {
  test("names the PR, the branches and includes the diffstat and diff", () => {
    const prompt = buildReviewPrompt(pr, " 1 file changed\n", "+added line\n", 1000);
    expect(prompt).toContain("pull request #42");
    expect(prompt).toContain("Base main <- head feature/retry.");
    expect(prompt).toContain("1 file changed");
    expect(prompt).toContain("+added line");
    expect(prompt).not.toContain("(draft)");
  });

  test("marks drafts and states the read-only rule", () => {
    const prompt = buildReviewPrompt({ ...pr, isDraft: true }, "", "", 1000);
    expect(prompt).toContain("(draft)");
    expect(prompt).toContain("Do not edit files");
    expect(prompt).toContain("(empty)");
  });
});

describe("parseArgs", () => {
  test("defaults to a dry run", () => {
    const options = parseArgs([], "/tmp/out");
    expect(options).toEqual({ limit: 50, out: "/tmp/out", runHaiku: false });
  });

  test("reads --run-haiku, --limit and --out", () => {
    const options = parseArgs(["--run-haiku", "--limit", "5", "--out", "/tmp/x"], "/tmp/out");
    expect(options.runHaiku).toBe(true);
    expect(options.limit).toBe(5);
    expect(options.out).toBe(resolve("/tmp/x"));
  });

  test("rejects unknown flags, missing values and a bad limit", () => {
    expect(() => parseArgs(["--nope"], "/tmp/out")).toThrow("unknown argument");
    expect(() => parseArgs(["--limit"], "/tmp/out")).toThrow("needs a value");
    expect(() => parseArgs(["--limit", "0"], "/tmp/out")).toThrow("positive integer");
  });
});
