/**
 * The one definition of Topics' Claude hooks, and the merge that lets them share
 * the single `--settings` with the image guard.
 *
 * @covers CCS-06
 */
import { describe, expect, test } from "bun:test";
import { mergeHooks, topicsHookCommand, topicsHooksSettings, TOPICS_HOOK_EVENTS, type HooksBlock } from "./topics-hooks";

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
