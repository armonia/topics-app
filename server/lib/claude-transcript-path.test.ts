import { describe, it, expect } from "bun:test";
import { claudeProjectDirName, claudeTranscriptPath, isTranscriptOrphaned } from "./claude-transcript-path";
import { homedir } from "os";

describe("claudeProjectDirName", () => {
  it("encodes / and . as - (matches Claude Code's projects dir naming)", () => {
    expect(claudeProjectDirName("/Users/test/.claude/agent")).toBe("-Users-test--claude-agent");
    expect(claudeProjectDirName("/Users/test/Projects/Alpha")).toBe("-Users-test-Projects-Alpha");
    expect(claudeProjectDirName("/Users/test/Sites/Example/example-site")).toBe("-Users-test-Sites-Example-example-site");
    expect(claudeProjectDirName("/Users/test/Projects/sampleapp")).toBe("-Users-test-Projects-sampleapp");
  });
});

describe("claudeTranscriptPath", () => {
  it("builds ~/.claude/projects/<encoded>/<id>.jsonl", () => {
    const p = claudeTranscriptPath("/Users/x/Projects/foo", "abc-123");
    expect(p).toBe(`${homedir()}/.claude/projects/-Users-x-Projects-foo/abc-123.jsonl`);
  });
});

describe("isTranscriptOrphaned", () => {
  const base = {
    cwd: "/Users/x/Projects/quadra",
    claudeSessionId: "c3069509",
    updatedAtMs: 1_000,
    nowMs: 1_000 + 10 * 60_000, // 10 min later → past any sane grace
    graceMs: 5 * 60_000,
  };

  it("orphaned: transcript missing at the resolved cwd (the quadra freeze)", () => {
    expect(isTranscriptOrphaned({ ...base, transcriptExists: () => false })).toBe(true);
  });

  it("keeps a resumable session (transcript present)", () => {
    expect(isTranscriptOrphaned({ ...base, transcriptExists: () => true })).toBe(false);
  });

  it("checks existence at the cwd-derived path, not some other dir", () => {
    const wtPath = claudeTranscriptPath(
      "/Users/x/Projects/quadra/.claude-worktrees/capitolato-fase1",
      "c3069509",
    );
    // The transcript still exists — but only under the reaped worktree's dir,
    // NOT under the base cwd the provider will resume from → still orphaned.
    const onlyUnderWorktree = (p: string) => p === wtPath;
    expect(isTranscriptOrphaned({ ...base, transcriptExists: onlyUnderWorktree })).toBe(true);
  });

  it("grace window: a just-spawned session whose jsonl hasn't flushed is kept", () => {
    expect(
      isTranscriptOrphaned({ ...base, nowMs: base.updatedAtMs + 30_000, transcriptExists: () => false }),
    ).toBe(false);
  });

  it("missing claude_session_id or cwd → undecidable, kept", () => {
    expect(isTranscriptOrphaned({ ...base, claudeSessionId: null, transcriptExists: () => false })).toBe(false);
    expect(isTranscriptOrphaned({ ...base, cwd: null, transcriptExists: () => false })).toBe(false);
  });

  it("no updated_at (0) skips the grace guard and still evaluates existence", () => {
    expect(isTranscriptOrphaned({ ...base, updatedAtMs: 0, transcriptExists: () => false })).toBe(true);
  });
});
