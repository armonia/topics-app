/**
 * The hook token lives under Topics' OWN home, never under `~/.claude`.
 *
 * Until 2026-09-07 every server boot wrote `~/.claude/topics-app/hook-token`
 * and `~/.claude/topics-hook-token`: Topics leaving files in another tool's
 * directory. The legacy paths are still READ so wrappers installed by an
 * older version keep authenticating, but nothing is written there any more.
 *
 * @covers CCS-02
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookTokenPath, legacyHookTokenPaths, resolveHookToken } from "./claude-hooks";

let root: string;
let fakeTopicsHome: string;
let fakeClaudeDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hook-token-"));
  fakeTopicsHome = join(root, "topics-home");
  fakeClaudeDir = join(root, "claude");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the hook token and where it is written", () => {
  test("a fresh token lands under TOPICS_HOME, mode 0600, and NOTHING is created under ~/.claude", () => {
    const own = hookTokenPath(fakeTopicsHome);
    const token = resolveHookToken(own, legacyHookTokenPaths(fakeClaudeDir));

    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(own).toBe(join(fakeTopicsHome, "claude-hooks", "hook-token"));
    expect(readFileSync(own, "utf-8")).toBe(token);
    expect(statSync(own).mode & 0o777).toBe(0o600);
    expect(existsSync(fakeClaudeDir)).toBe(false);
  });

  test("a second resolve reads the same token back instead of generating another", () => {
    const own = hookTokenPath(fakeTopicsHome);
    const legacy = legacyHookTokenPaths(fakeClaudeDir);
    expect(resolveHookToken(own, legacy)).toBe(resolveHookToken(own, legacy));
  });

  test("a legacy token is ADOPTED so already-installed wrappers keep authenticating, and the legacy dir is left as it was", () => {
    mkdirSync(fakeClaudeDir, { recursive: true });
    const legacyPath = join(fakeClaudeDir, "topics-hook-token");
    const legacyToken = "ab".repeat(32);
    writeFileSync(legacyPath, legacyToken + "\n");
    const before = readdirSync(fakeClaudeDir);

    const own = hookTokenPath(fakeTopicsHome);
    expect(resolveHookToken(own, legacyHookTokenPaths(fakeClaudeDir))).toBe(legacyToken);
    expect(readFileSync(own, "utf-8")).toBe(legacyToken);
    expect(readdirSync(fakeClaudeDir)).toEqual(before);
    expect(readFileSync(legacyPath, "utf-8")).toBe(legacyToken + "\n");
  });

  test("our own file wins over a legacy one", () => {
    const own = hookTokenPath(fakeTopicsHome);
    mkdirSync(join(fakeTopicsHome, "claude-hooks"), { recursive: true });
    writeFileSync(own, "cd".repeat(32));
    mkdirSync(join(fakeClaudeDir, "topics-app"), { recursive: true });
    writeFileSync(join(fakeClaudeDir, "topics-app", "hook-token"), "ef".repeat(32));
    expect(resolveHookToken(own, legacyHookTokenPaths(fakeClaudeDir))).toBe("cd".repeat(32));
  });

  test("the wrapper script reads the new path first and the legacy one as fallback", () => {
    const sh = readFileSync(join(import.meta.dir, "../../scripts/claude-hooks/post-hook.sh"), "utf-8");
    expect(sh).toContain('TOKEN_FILE="${TOPICS_HOME:-$HOME/.topics}/claude-hooks/hook-token"');
    expect(sh).toContain('[ -r "$TOKEN_FILE" ] || TOKEN_FILE="${HOME}/.claude/topics-hook-token"');
    expect(sh.trim().endsWith("exit 0")).toBe(true);
  });
});

