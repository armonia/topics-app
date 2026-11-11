/** @covers SUBAGENT-08, SUBAGENT-09, SUBAGENT-11, SUBAGENT-17, SUBAGENT-18 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnv } from "../../tests/setup/bun-test-preload";
import { engineModelOf, nativeChildPlace, nativeTurnOutcome, placeableUnderKnownProject } from "./native-subagents";
import { engineToolsOfProfile, toolAllowedByPolicy } from "./subagent-tool-policy";
import { LEGACY_DATA_DIR_NAME } from "../../shared/legacy-data-dir";
const OLD_HOME = LEGACY_DATA_DIR_NAME;

describe("how a child chat's turn ended, as a result (SUBAGENT-11)", () => {
  test("an end_turn with words is completed", () => {
    expect(nativeTurnOutcome({ end: { end: "end_turn" }, text: " found 3 ", stopped: false }))
      .toEqual({ status: "completed", partial: false, text: "found 3" });
  });

  test("the parent's stop is stopped-by-parent, a person's Stop on the child is a plain stop", () => {
    expect(nativeTurnOutcome({ end: { end: "cancelled" }, text: "half", stopped: true }).reason).toEqual({ code: "stopped-by-parent" });
    expect(nativeTurnOutcome({ end: { end: "cancelled" }, text: "half", stopped: false })).toEqual({ status: "stopped", partial: true, text: "half" });
  });

  test("an error end is failed, with the end and its detail", () => {
    expect(nativeTurnOutcome({ end: { end: "error", detail: "overloaded" }, text: "", stopped: false }))
      .toEqual({ status: "failed", partial: true, text: "", reason: { code: "api-error", detail: "error: overloaded" } });
  });

  test("a route that refused the turn is failed, whatever else is known", () => {
    expect(nativeTurnOutcome({ end: { end: "end_turn" }, text: "old", routeError: "the chat route answered 503", stopped: false }).status).toBe("failed");
  });

  // Review 5 of PR 238: the outcome is the end's cause, never «words left = done».
  // A swept turn's last row is a notice, and it was reported `completed`.
  test("no end on record is a cut turn, words left or not", () => {
    expect(nativeTurnOutcome({ end: null, text: "ok", stopped: false })).toMatchObject({ status: "failed", reason: { code: "exited-mid-turn" } });
    expect(nativeTurnOutcome({ end: null, text: "", stopped: false })).toMatchObject({ status: "failed", reason: { code: "exited-mid-turn" } });
  });

  test("a machine's cut is `stopped` with its reason; a person's Stop has none", () => {
    expect(nativeTurnOutcome({ end: { end: "cancelled", cause: "watchdog" }, text: "⚠️ notice", stopped: false })).toMatchObject({ status: "stopped", reason: { code: "swept" } });
    expect(nativeTurnOutcome({ end: { end: "cancelled", cause: "user" }, text: "half", stopped: false }).reason).toBeUndefined();
  });
});

describe("where a native child stands (SUBAGENT-17)", () => {
  const known = (p: string) => p === "/p/known";
  test("a chat parent hands down its project and worktree, or no project at all", () => {
    expect(nativeChildPlace({ explicitCwd: null, parentTopic: { projectPath: "/p/a", worktreeId: "wt1" }, parentCwd: null, knownProject: known }))
      .toEqual({ ok: true, projectPath: "/p/a", worktreeId: "wt1" });
    expect(nativeChildPlace({ explicitCwd: null, parentTopic: {}, parentCwd: null, knownProject: known }))
      .toEqual({ ok: true, projectPath: null, worktreeId: null });
  });

  test("a cwd Topics does not know as a project is not a native child's home", () => {
    expect(nativeChildPlace({ explicitCwd: "/Users/x/.ssh", parentTopic: { projectPath: "/p/a" }, parentCwd: null, knownProject: known }).ok).toBe(false);
    expect(nativeChildPlace({ explicitCwd: "/p/known", parentTopic: null, parentCwd: null, knownProject: known })).toMatchObject({ ok: true, projectPath: "/p/known" });
  });

  test("a terminal parent's directory counts only when it is a known project", () => {
    expect(nativeChildPlace({ explicitCwd: null, parentTopic: null, parentCwd: "/p/known", knownProject: known })).toMatchObject({ ok: true, projectPath: "/p/known" });
    expect(nativeChildPlace({ explicitCwd: null, parentTopic: null, parentCwd: "/tmp", knownProject: known }).ok).toBe(false);
  });
});

describe("a folder a native child may call home (SUBAGENT-17)", () => {
  const projects = new Set(["/Users/x/Projects/acme", "/Users/x/.claude/jarvis"]);
  const isProject = (p: string) => projects.has(p);
  const commonDirs: Record<string, string> = {
    "/Users/x/Projects/acme-night/feature-2": "/Users/x/Projects/acme/.git",
    "/Users/x/Projects/uvenude": "/Users/x/Projects/uvenude/.git",
  };
  const git = (d: string) => commonDirs[d] ?? null;

  test("a known project, and a folder inside one", () => {
    expect(placeableUnderKnownProject("/Users/x/Projects/acme", isProject, git)).toBe(true);
    expect(placeableUnderKnownProject("/Users/x/.claude/jarvis/tools/jarvis-channels", isProject, git)).toBe(true);
  });

  test("a git worktree checked out from a known project", () => {
    expect(placeableUnderKnownProject("/Users/x/Projects/acme-night/feature-2", isProject, git)).toBe(true);
  });

  test("the fence stays: an unknown repository, a parent folder, home, a relative path", () => {
    expect(placeableUnderKnownProject("/Users/x/Projects/uvenude", isProject, git)).toBe(false);
    expect(placeableUnderKnownProject("/Users/x/Projects", isProject, git)).toBe(false);
    expect(placeableUnderKnownProject("/Users/x", isProject, git)).toBe(false);
    expect(placeableUnderKnownProject("/tmp/wt-ds", isProject, git)).toBe(false);
    expect(placeableUnderKnownProject("Projects/acme", isProject, git)).toBe(false);
  });

  test("a `.git` that is not a repository's shared dir does not open the fence", () => {
    expect(placeableUnderKnownProject("/Users/x/odd", isProject, () => "/Users/x/Projects/acme/.git/worktrees/odd")).toBe(false);
  });

  test("through nativeChildPlace: the worktree becomes the child's home", () => {
    const knownProject = (p: string) => placeableUnderKnownProject(p, isProject, git);
    expect(nativeChildPlace({ explicitCwd: "/Users/x/Projects/acme-night/feature-2", parentTopic: { projectPath: `/Users/x/${OLD_HOME}` }, parentCwd: null, knownProject }))
      .toEqual({ ok: true, projectPath: "/Users/x/Projects/acme-night/feature-2", worktreeId: null });
    expect(nativeChildPlace({ explicitCwd: "/Users/x/Projects", parentTopic: { projectPath: `/Users/x/${OLD_HOME}` }, parentCwd: null, knownProject }).ok).toBe(false);
  });

  test("with the real git: a worktree of a known repository passes, a missing folder does not", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "placeable-")));
    try {
      const repo = join(root, "repo");
      const wt = join(root, "repo-wt");
      const run = (args: string[], cwd: string) => {
        const r = spawnSync("git", args, { cwd, encoding: "utf-8", env: gitEnv() });
        if (r.status !== 0) throw new Error(r.stderr);
      };
      mkdirSync(repo);
      run(["init", "-q"], repo);
      run(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"], repo);
      run(["worktree", "add", "-q", "--detach", wt], repo);
      expect(placeableUnderKnownProject(wt, (p) => p === repo)).toBe(true);
      expect(placeableUnderKnownProject(wt, () => false)).toBe(false);
      expect(placeableUnderKnownProject(join(root, "missing"), (p) => p === repo)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the model and the tools, in the engine's names (SUBAGENT-08, 09)", () => {
  test("the aliases the tool accepts become ids the engine serves", () => {
    expect(engineModelOf("sonnet")).toBe("claude-sonnet-5-5");
    expect(engineModelOf("opus[1m]")).toBe("claude-opus-5-5[1m]");
    expect(engineModelOf("fable")).toBe("claude-fable-5-2");
    expect(engineModelOf("haiku")).toBe("claude-haiku-4-5-20251001");
    expect(engineModelOf("claude-sonnet-5-5[1m]")).toBe("claude-sonnet-5-5[1m]");
    expect(engineModelOf(null)).toBeNull();
  });

  test("a profile's tools line, translated; nothing listed is no restriction", () => {
    expect(engineToolsOfProfile(["Read", "Bash", "WebSearch", "mcp__topics__move_task", "mcp__exa__search"]))
      .toEqual(["read_file", "bash", "move_task", "mcp__exa__search"]);
    expect(engineToolsOfProfile(["Task"])).toContain("spawn_agent");
    expect(engineToolsOfProfile(null)).toBeNull();
  });

  test("the policy: a profile list restricts, the depth cap removes delegation, no policy allows all", () => {
    expect(toolAllowedByPolicy(null, "spawn_agent")).toBe(true);
    expect(toolAllowedByPolicy({ allowed: null, noDelegation: true }, "spawn_agent")).toBe(false);
    expect(toolAllowedByPolicy({ allowed: null, noDelegation: true }, "bash")).toBe(true);
    expect(toolAllowedByPolicy({ allowed: new Set(["read_file"]), noDelegation: false }, "bash")).toBe(false);
  });
});
