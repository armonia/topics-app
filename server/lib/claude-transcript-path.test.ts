import { describe, it, expect } from "bun:test";
import { claudeProjectDirName, claudeTranscriptPath } from "./claude-transcript-path";
import { homedir } from "os";

describe("claudeProjectDirName", () => {
  it("encodes / and . as - (matches Claude Code's projects dir naming)", () => {
    expect(claudeProjectDirName("/Users/user/.claude/jarvis")).toBe("-Users-zorahrel--claude-jarvis");
    expect(claudeProjectDirName("/Users/user/Projects/Quadra")).toBe("-Users-zorahrel-Projects-Quadra");
    expect(claudeProjectDirName("/Users/user/Sites/Armonia/armonia-site")).toBe("-Users-zorahrel-Sites-Armonia-armonia-site");
    expect(claudeProjectDirName("/Users/user/Projects/[cliente]")).toBe("-Users-zorahrel-Projects-[cliente]");
  });
});

describe("claudeTranscriptPath", () => {
  it("builds ~/.claude/projects/<encoded>/<id>.jsonl", () => {
    const p = claudeTranscriptPath("/Users/x/Projects/foo", "abc-123");
    expect(p).toBe(`${homedir()}/.claude/projects/-Users-x-Projects-foo/abc-123.jsonl`);
  });
});
