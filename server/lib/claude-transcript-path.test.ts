/**
 * @covers EXTSESS-07
 */
import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { claudeProjectDirName, claudeTranscriptCandidates, claudeTranscriptPath, isTranscriptOrphaned } from "./claude-transcript-path";

describe("claudeProjectDirName", () => {
  it("encodes / and . as - (matches Claude Code's projects dir naming)", () => {
    expect(claudeProjectDirName("/Users/test/.claude/agent")).toBe("-Users-test--claude-agent");
    expect(claudeProjectDirName("/Users/test/Projects/Alpha")).toBe("-Users-test-Projects-Alpha");
    expect(claudeProjectDirName("/Users/test/Sites/Example/example-site")).toBe("-Users-test-Sites-Example-example-site");
    expect(claudeProjectDirName("/Users/test/Projects/sampleapp")).toBe("-Users-test-Projects-sampleapp");
  });

  /**
   * Il carattere che sfuggiva. `/` e `.` erano i due che si vedevano a occhio in
   * un percorso di casa; `_` sta dove nessuno guarda, cioe' dentro la temp dir di
   * macOS, e ci mandava a leggere una cartella che non esiste.
   */
  it("encodes _ as - too: the macOS temp dir carries one, and it read zero", () => {
    expect(claudeProjectDirName("/Users/test/Projects/my_project")).toBe("-Users-test-Projects-my-project");
    expect(
      claudeProjectDirName("/private/var/folders/d8/0rlg1q2x64gbx_cn5y2qjf8w0000gn/T/thread-vs-work-KN4yvY/worker"),
    ).toBe("-private-var-folders-d8-0rlg1q2x64gbx-cn5y2qjf8w0000gn-T-thread-vs-work-KN4yvY-worker");
  });

  /**
   * La regola vera, verificata con una sonda: si apre una sessione in una
   * cartella con dentro ogni carattere sospetto e si guarda come `claude` la
   * chiama. Ogni non-alfanumerico diventa `-`, uno per uno, senza collassare le
   * ripetizioni.
   */
  it("encodes EVERY non-alphanumeric as -, one dash per character", () => {
    expect(claudeProjectDirName("/tmp/a_b.c d+e@f~g")).toBe("-tmp-a-b-c-d-e-f-g");
    expect(claudeProjectDirName("/tmp/(x)[y]{z}")).toBe("-tmp--x--y--z-");
    expect(claudeProjectDirName("/tmp/a__b")).toBe("-tmp-a--b");
    expect(claudeProjectDirName("/tmp/ciao-mondo")).toBe("-tmp-ciao-mondo");
  });

  it("digits and case survive untouched", () => {
    expect(claudeProjectDirName("/Users/Test42/Projects/App2000")).toBe("-Users-Test42-Projects-App2000");
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

/**
 * A SYMLINKED CWD FILES THE TRANSCRIPT UNDER ANOTHER NAME.
 *
 * The CLI derives its folder from `process.cwd()`, which the OS reports
 * RESOLVED; Topics holds the path the session was started with, which can be
 * the link. Looking only under the unresolved name finds nothing, and "no
 * transcript" is what makes `decideOnRestart` return `drop` - the session is
 * thrown away instead of resumed. Measured on a live machine: a claude-code
 * session whose cwd was `~/.openclaw/workspace/<name>`, a symlink into
 * `~/Projects/<name>`.
 */
describe("claudeTranscriptCandidates", () => {
  const tmp = mkdtempSync(join(tmpdir(), "transcript-symlink-"));
  const real = join(tmp, "real-project");
  const link = join(tmp, "linked-project");
  mkdirSync(real, { recursive: true });
  symlinkSync(real, link);

  it("offers the RESOLVED name first when the cwd is a symlink", () => {
    const candidates = claudeTranscriptCandidates(link, "abc");
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toContain(claudeProjectDirName(realpathSync(link)));
    expect(candidates[1]).toContain(claudeProjectDirName(link));
    expect(candidates[0]).not.toBe(candidates[1]);
  });

  it("on an already-resolved cwd there is one name, as before", () => {
    // `realpathSync` and not `real`: on macOS even `/var` is a symlink into
    // `/private/var`, so a temp directory is NOT an already-resolved path - the
    // first run of this test found that out by failing.
    const resolved = realpathSync(real);
    expect(claudeTranscriptCandidates(resolved, "abc")).toEqual([
      claudeTranscriptPath(resolved, "abc"),
    ]);
  });

  it("a cwd that does not exist breaks nothing", () => {
    const gone = join(tmp, "mai-esistita");
    expect(claudeTranscriptCandidates(gone, "abc")).toHaveLength(1);
  });

  it("claudeTranscriptPath returns the candidate that EXISTS, not the first", () => {
    // The transcript is filed under the UNRESOLVED name: this is the case where
    // resolving and nothing else would have broken a session that used to work.
    const dir = join(homedir(), ".claude", "projects", claudeProjectDirName(link));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "solo-qui.jsonl");
    writeFileSync(file, "{}\n");
    try {
      expect(claudeTranscriptPath(link, "solo-qui")).toBe(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
