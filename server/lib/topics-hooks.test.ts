/**
 * The one definition of Topics' Claude hooks, and the merge that lets them share
 * the single `--settings` with the image guard.
 *
 * And the worktree pair (WorktreeCreate / WorktreeRemove): synchronous, with
 * its own timeouts, embedded like the post hook, and carried by the sessions
 * Topics launches unless `claude_worktree_hooks` is `off`.
 *
 * @covers CCS-06, WORKTREE-STD-13
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  mergeHooks, topicsHookCommand, topicsHooksSettings, topicsWorktreeHooksSettings,
  TOPICS_HOOK_EVENTS, WORKTREE_HOOK_EVENTS, type HooksBlock,
} from "./topics-hooks";
import { WORKTREE_HOOK_SCRIPT, worktreeHookPath } from "./topics-hook-script";
import { buildClaudeArgs } from "../providers/claude/args";
import { resolveClaudeWorktreeHooks, type AppSettings } from "../services/app-settings";

const SCRIPT = "/Users/me/My Home/.topics/claude-hooks/post-hook.sh";

describe("topicsHooksSettings", () => {
  test("the seven events, each in ONE wildcard matcher with ONE entry", () => {
    const { hooks } = topicsHooksSettings(SCRIPT);
    expect(Object.keys(hooks).sort()).toEqual([...TOPICS_HOOK_EVENTS].sort());
    expect(Object.keys(hooks).length).toBe(7);
    for (const event of TOPICS_HOOK_EVENTS) {
      expect(hooks[event]!.length).toBe(1);
      // No `matcher`: a narrowed one would keep AskUserQuestion, ExitPlanMode
      // and Monitor away from the server.
      expect(hooks[event]![0]!.matcher).toBeUndefined();
      expect(hooks[event]![0]!.hooks).toEqual([
        expect.objectContaining({ type: "command", command: `"${SCRIPT}" ${event}`, timeout: 5, topics_app: true }),
      ]);
    }
  });

  test("async on every event but SessionEnd: no tool and no turn waits for the script", () => {
    // The script exits 0 and returns no decision; a sync hook made each tool
    // wait for it, up to 37.4 s on 04/10. SessionEnd fires as the CLI exits,
    // when an async hook is cut, and holds nothing up.
    const { hooks } = topicsHooksSettings(SCRIPT);
    const asyncOnes = TOPICS_HOOK_EVENTS.filter((e) => hooks[e]![0]!.hooks![0]!.async === true);
    expect(asyncOnes.sort()).toEqual(["Notification", "PostToolUse", "PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
    expect("async" in hooks.SessionEnd![0]!.hooks![0]!).toBe(false);
  });

  test("the quoted path survives a home with a space through /bin/sh -c", async () => {
    // Without the quotes the shell splits the path and the hook never starts.
    const cmd = topicsHookCommand("/tmp/a dir/echo-args.sh", "Stop");
    const p = Bun.spawn(["sh", "-c", `set -- ${cmd}; printf '%s|' "$@"`], { stdout: "pipe" });
    expect(await new Response(p.stdout).text()).toBe("/tmp/a dir/echo-args.sh|Stop|");
  });
});

describe("mergeHooks", () => {
  const guard: HooksBlock = { PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "guard" }] }] };

  test("concatenates the matchers of the same event, first block first", () => {
    const ours = topicsHooksSettings(SCRIPT).hooks;
    const merged = mergeHooks(ours, guard);
    expect(merged.PreToolUse).toEqual([...ours.PreToolUse!, ...guard.PreToolUse!]);
    // The other events pass through untouched.
    expect(merged.Stop).toEqual(ours.Stop);
    expect(Object.keys(merged).length).toBe(7);
  });

  test("an event of only one side is kept, and a missing side is no side", () => {
    expect(mergeHooks(undefined, guard)).toEqual(guard);
    expect(mergeHooks(guard, undefined)).toEqual(guard);
    expect(mergeHooks(undefined, undefined)).toEqual({});
  });

  test("does not modify its inputs", () => {
    const ours = topicsHooksSettings(SCRIPT).hooks;
    const snapshot = JSON.stringify([ours, guard]);
    mergeHooks(ours, guard);
    expect(JSON.stringify([ours, guard])).toBe(snapshot);
  });
});

describe("topicsWorktreeHooksSettings", () => {
  const WT = "/home/someone/My Home/.topics/claude-hooks/worktree-hook.sh";

  test("the two worktree events, synchronous, each with its verb and timeout", () => {
    const { hooks } = topicsWorktreeHooksSettings(WT);
    expect(Object.keys(hooks).sort()).toEqual([...WORKTREE_HOOK_EVENTS].sort());
    // Synchronous: the CLI reads the worktree path off the create hook's stdout.
    expect(hooks.WorktreeCreate).toEqual([{ hooks: [{ type: "command", command: `"${WT}" create`, timeout: 120, topics_app: true }] }]);
    expect(hooks.WorktreeRemove).toEqual([{ hooks: [{ type: "command", command: `"${WT}" remove`, timeout: 60, topics_app: true }] }]);
  });

  test("the script is embedded from its source and written next to the post hook", () => {
    const source = readFileSync(join(import.meta.dir, "../../scripts/claude-hooks/worktree-hook.sh"), "utf8");
    expect(WORKTREE_HOOK_SCRIPT).toBe(source);
    expect(worktreeHookPath("/h")).toBe(join("/h", "claude-hooks", "worktree-hook.sh"));
  });

  test("a spawn carries them in the ONE --settings, next to the other hooks", () => {
    const args = buildClaudeArgs({
      permissionMode: "acceptEdits", model: "m", mcpConfigPath: "/tmp/m.json", mcpStrict: true,
      permissionPromptTool: "p", appendSystemPrompt: "s",
      hooksScriptPath: "/x/post-hook.sh", worktreeHooksScriptPath: WT,
    } as Parameters<typeof buildClaudeArgs>[0]);
    expect(args.filter((a) => a === "--settings").length).toBe(1);
    const hooks = JSON.parse(args[args.indexOf("--settings") + 1]!).hooks as HooksBlock;
    expect(hooks.WorktreeCreate![0]!.hooks![0]!.command).toBe(`"${WT}" create`);
    expect(hooks.Stop![0]!.hooks![0]!.command).toBe(`"/x/post-hook.sh" Stop`);
    const off = buildClaudeArgs({
      permissionMode: "acceptEdits", model: "m", mcpConfigPath: "/tmp/m.json", mcpStrict: true,
      permissionPromptTool: "p", appendSystemPrompt: "s", hooksScriptPath: "/x/post-hook.sh", worktreeHooksScriptPath: null,
    } as Parameters<typeof buildClaudeArgs>[0]);
    expect(JSON.parse(off[off.indexOf("--settings") + 1]!).hooks.WorktreeCreate).toBeUndefined();
  });

  test("claude_worktree_hooks: on unless an explicit off", () => {
    const s = (v: string | null) => ({ claudeWorktreeHooks: v }) as AppSettings;
    expect(resolveClaudeWorktreeHooks(s(null))).toBe("topics");
    expect(resolveClaudeWorktreeHooks(s("junk"))).toBe("topics");
    expect(resolveClaudeWorktreeHooks(s(" OFF "))).toBe("off");
  });
});
