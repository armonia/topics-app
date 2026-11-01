/**
 * @covers KANBAN-07
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildClaudeArgs } from "../providers/claude/args";
import { LIVE_CHECKOUT_GUARD_CMD } from "./live-checkout-branch-guard";

const sh = (cwd: string, cmd: string) => spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf-8" });
const git = (cwd: string, args: string) => sh(cwd, `git ${args}`);

let root: string;
let live: string;
let linked: string;

// Runs the real hook command exactly as Claude Code does: JSON on stdin.
function runHook(command: string, cwd: string, hook: string = LIVE_CHECKOUT_GUARD_CMD) {
  return spawnSync("sh", ["-c", hook], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd }),
    encoding: "utf-8",
  });
}

// What a dispatched session is launched with: the hook the argv carries.
function dispatchedHook(guardLiveCheckout: boolean): string | null {
  const args = buildClaudeArgs({
    permissionMode: "bypassPermissions", model: "m", mcpConfigPath: "/x", permissionPromptTool: "t",
    appendSystemPrompt: "", guardLiveCheckout,
  } as never);
  const i = args.indexOf("--settings");
  if (i < 0) return null;
  const hooks = JSON.parse(args[i + 1]).hooks?.PreToolUse ?? [];
  return hooks.find((h: { matcher: string }) => h.matcher === "Bash")?.hooks[0].command ?? null;
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "live-guard-")));
  live = join(root, "live");
  linked = join(root, "wt");
  sh(root, `git init -q -b main live && cd live && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m init`);
  git(live, `worktree add -q -b card ${JSON.stringify(linked)}`);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("live checkout branch guard", () => {
  it("lets a dispatched agent run git checkout -b in the live checkout only without the cure", () => {
    // Without the cure the command goes through and moves HEAD of the live repo.
    expect(dispatchedHook(false)).toBeNull();
    git(live, "checkout -q -b leaked");
    expect(git(live, "branch --show-current").stdout.trim()).toBe("leaked");
    git(live, "checkout -q main");
  });

  it("refuses git checkout -b in the live checkout when the session carries the cure", () => {
    const hook = dispatchedHook(true);
    expect(hook).not.toBeNull();
    const r = runHook("git checkout -b card-x", live, hook!);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("live checkout");
    expect(git(live, "branch --show-current").stdout.trim()).toBe("main");
  });

  it("refuses the other ways to move HEAD and the indirect forms", () => {
    for (const c of ["git switch -c x", "git checkout card", "git switch card", "git checkout --detach",
      `git -C ${live} checkout -b x`, `cd ${live} && git checkout -B x`, "echo hi; git checkout card"]) {
      expect(runHook(c, c.includes(live) ? root : live).status).toBe(2);
    }
  });

  it("leaves a linked worktree and file restores alone", () => {
    expect(runHook("git checkout -b card-y", linked).status).toBe(0);
    expect(runHook("git checkout -- file.txt", live).status).toBe(0);
    expect(runHook("git checkout .", live).status).toBe(0);
    expect(runHook("git status && git log", live).status).toBe(0);
  });
});
