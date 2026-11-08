/**
 * @covers SUBAGENT-05
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  discoverClaudeSubAgentSessionId,
  normalizePromptSnippet,
} from "./claude-subagent-transcript";
import { claudeProjectDirName } from "./claude-transcript-path";

// Fake ~/.claude/projects tree, driven via the `root` override.
let root: string;

/** Write a claude transcript (mode preamble + one user turn) for `cwd` under the
 *  encoded project dir, named `<id>.jsonl`, stamped with `mtimeMs`. */
function writeTranscript(cwd: string, id: string, userText: string, mtimeMs: number, recordCwd = cwd): string {
  const dir = join(root, claudeProjectDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  const lines = [
    JSON.stringify({ type: "mode", sessionId: id }),
    JSON.stringify({ type: "permission-mode", sessionId: id }),
    JSON.stringify({ type: "file-history-snapshot" }),
    JSON.stringify({ type: "user", cwd: recordCwd, sessionId: id, message: { role: "user", content: userText } }),
    JSON.stringify({ type: "assistant", sessionId: id, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
  ];
  writeFileSync(file, lines.join("\n") + "\n");
  const sec = mtimeMs / 1000;
  utimesSync(file, sec, sec);
  return file;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "claude-projects-"));
});
afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

describe("normalizePromptSnippet", () => {
  test("collapses whitespace, lowercases, and truncates", () => {
    expect(normalizePromptSnippet("  Ciao   MONDO\n\ttest  ", 8)).toBe("ciao mon");
  });
});

describe("discoverClaudeSubAgentSessionId", () => {
  test("returns null when the project dir does not exist", () => {
    expect(discoverClaudeSubAgentSessionId({
      cwd: "/proj/absent", promptSnippet: "x", sinceMs: 0, root,
    })).toBeNull();
  });

  test("matches the child transcript by prompt snippet even when a parent shares the cwd", () => {
    const spawn = 10_000_000;
    // Parent chat: OLDER birth but ACTIVELY appended → freshest mtime. A
    // recency-only heuristic would wrongly grab this.
    writeTranscript("/proj/shared", "parent-sess", "Assicuriamoci che sia tutto pronto", spawn + 5_000);
    // The sub-agent: unique spawn prompt.
    writeTranscript("/proj/shared", "child-sess", "Delega i test i18n e rispondi PONG-42", spawn + 500);
    const snippet = normalizePromptSnippet("Delega i test i18n e rispondi PONG-42");
    expect(discoverClaudeSubAgentSessionId({
      cwd: "/proj/shared", promptSnippet: snippet, sinceMs: spawn, root,
    })).toBe("child-sess");
  });

  test("single fresh transcript in an isolated cwd is returned even without a content match", () => {
    const spawn = 11_000_000;
    writeTranscript("/proj/isolated", "lone-sess", "totally different opening", spawn + 300);
    expect(discoverClaudeSubAgentSessionId({
      cwd: "/proj/isolated", promptSnippet: "prompt that will not match", sinceMs: spawn, root,
    })).toBe("lone-sess");
  });

  test("does NOT fall back to a single transcript when it belongs to the parent (2+ recent files)", () => {
    const spawn = 12_000_000;
    writeTranscript("/proj/ambig", "parentA", "parent one opening", spawn + 100);
    writeTranscript("/proj/ambig", "parentB", "parent two opening", spawn + 200);
    // No content match and 2 recent files → refuse to guess.
    expect(discoverClaudeSubAgentSessionId({
      cwd: "/proj/ambig", promptSnippet: "no match here", sinceMs: spawn, root,
    })).toBeNull();
  });

  test("ignores transcripts older than the spawn (beyond skew)", () => {
    const spawn = 13_000_000;
    writeTranscript("/proj/stale", "old-sess", "Delega i test i18n e rispondi PONG-42", spawn - 10_000);
    const snippet = normalizePromptSnippet("Delega i test i18n e rispondi PONG-42");
    expect(discoverClaudeSubAgentSessionId({
      cwd: "/proj/stale", promptSnippet: snippet, sinceMs: spawn, root,
    })).toBeNull();
  });

  test("tolerates small negative clock skew (file stamped just before spawn)", () => {
    const spawn = 13_500_000;
    writeTranscript("/proj/skew", "skew-sess", "Delega i test i18n e rispondi PONG-42", spawn - 2_000);
    const snippet = normalizePromptSnippet("Delega i test i18n e rispondi PONG-42");
    expect(discoverClaudeSubAgentSessionId({
      cwd: "/proj/skew", promptSnippet: snippet, sinceMs: spawn, root,
    })).toBe("skew-sess");
  });

  test("skips a content match another session already holds, so two siblings with the same opening never share one", () => {
    const spawn = 15_000_000;
    // The opening is longer than the fingerprint: both transcripts carry it,
    // so the content alone cannot tell the two siblings apart (08/11, four
    // pairs of sub-agents in the live database on one conversation).
    const opening = "Rispondi sempre in italiano. Repo ~/Projects/zenocms (GitHub armonia/zenocms). Compito: ";
    writeTranscript("/proj/siblings", "first-child", `${opening}le PR #183 e #166`, spawn + 900);
    writeTranscript("/proj/siblings", "second-child", `${opening}le PR #168 e #169`, spawn + 400);
    const snippet = normalizePromptSnippet(`${opening}le PR #168 e #169`);
    // The newer match is the first sibling's, and the first sibling holds it.
    expect(discoverClaudeSubAgentSessionId({
      cwd: "/proj/siblings", promptSnippet: snippet, sinceMs: spawn, root, excludeIds: new Set(["first-child"]),
    })).toBe("second-child");
  });

  test("the single-recent-file fallback skips a transcript another session already holds", () => {
    const spawn = 16_000_000;
    // The sibling's CLI wrote its transcript first and the sibling adopted it;
    // this child's own file is not there yet. Taking the only file around
    // would put both children on the sibling's conversation.
    writeTranscript("/proj/race", "sibling-sess", "a prompt this child does not match", spawn + 300);
    expect(discoverClaudeSubAgentSessionId({
      cwd: "/proj/race", promptSnippet: "prompt that will not match", sinceMs: spawn, root, excludeIds: new Set(["sibling-sess"]),
    })).toBeNull();
  });

  test("rejects a content match whose recorded cwd differs from the spawn cwd", () => {
    const spawn = 14_000_000;
    // Prompt matches, but the transcript's own cwd field says elsewhere.
    writeTranscript("/proj/wrongcwd", "mismatch-sess", "Delega i test i18n e rispondi PONG-42", spawn + 100, "/proj/elsewhere");
    const snippet = normalizePromptSnippet("Delega i test i18n e rispondi PONG-42");
    // Only one recent file, but the cwd guard rejects the content match AND the
    // single-file fallback still returns it (it's the sole fresh transcript here).
    // To assert the cwd guard in isolation, add a second recent file so the
    // fallback cannot fire.
    writeTranscript("/proj/wrongcwd", "decoy-sess", "unrelated", spawn + 150);
    expect(discoverClaudeSubAgentSessionId({
      cwd: "/proj/wrongcwd", promptSnippet: snippet, sinceMs: spawn, root,
    })).toBeNull();
  });
});
