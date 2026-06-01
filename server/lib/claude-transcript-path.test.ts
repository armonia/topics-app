import { describe, it, expect } from "bun:test";
import { claudeProjectDirName, claudeTranscriptPath } from "./claude-transcript-path";
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
