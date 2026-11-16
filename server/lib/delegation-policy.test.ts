/**
 * @covers SUBAGENT-24
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  createDelegationTracker, delegationHookScript, delegationPolicy, DELEGATION_NUDGE, DELEGATION_TOOL, INLINE_WORK_TOOL,
} from "./delegation-policy";
import { topicsAgentSystemPrompt } from "./topics-agent-prompt";
import { nativeSystemPrompt } from "../providers/native/provider";
import { buildClaudeArgs, DELEGATION_HOOK_MATCHER } from "../providers/claude/args";

const BIG = 200_000;

describe("delegation tracker", () => {
  test("nudges after a run of inline calls on a big context, then waits a full run again", () => {
    const t = createDelegationTracker();
    const seen: (string | null)[] = [];
    for (let i = 0; i < DELEGATION_NUDGE.everyInlineCalls * 2; i++) seen.push(t.observe(["Bash"], BIG));
    const at = seen.flatMap((s, i) => (s ? [i + 1] : []));
    expect(at).toEqual([DELEGATION_NUDGE.everyInlineCalls, DELEGATION_NUDGE.everyInlineCalls * 2]);
    expect(seen[DELEGATION_NUDGE.everyInlineCalls - 1]).toContain("~200k tokens");
  });

  test("a delegation resets the run", () => {
    const t = createDelegationTracker();
    for (let i = 0; i < DELEGATION_NUDGE.everyInlineCalls - 1; i++) expect(t.observe(["Read"], BIG)).toBeNull();
    expect(t.observe(["mcp__topics__spawn_agent"], BIG)).toBeNull();
    for (let i = 0; i < DELEGATION_NUDGE.everyInlineCalls - 1; i++) expect(t.observe(["bash"], BIG)).toBeNull();
  });

  test("a small context does not nudge; the check comes back five calls later", () => {
    const t = createDelegationTracker();
    for (let i = 0; i < DELEGATION_NUDGE.everyInlineCalls; i++) expect(t.observe(["Grep"], 50_000)).toBeNull();
    for (let i = 0; i < 4; i++) expect(t.observe(["Grep"], BIG)).toBeNull();
    expect(t.observe(["Grep"], BIG)).toContain("spawn_agent");
  });

  test("edits and bookkeeping are not inline work", () => {
    const t = createDelegationTracker();
    for (let i = 0; i < 100; i++) expect(t.observe(["Edit", "mcp__topics__update_goal_steps", "write_file"], BIG)).toBeNull();
  });

  test("the count survives a detached turn: state out, tracker back in", () => {
    const a = createDelegationTracker();
    for (let i = 0; i < DELEGATION_NUDGE.everyInlineCalls - 1; i++) a.observe(["Bash"], BIG);
    const b = createDelegationTracker(undefined, JSON.parse(JSON.stringify(a.state())));
    expect(b.observe(["Bash"], BIG)).toContain("spawn_agent");
  });
});

describe("delegation in the prompts", () => {
  test("headless sessions get the policy, the interactive pane does not", () => {
    expect(topicsAgentSystemPrompt("auto", "darwin", false, true)).toContain(delegationPolicy());
    expect(topicsAgentSystemPrompt("auto", "darwin", true, true)).toContain(delegationPolicy());
    expect(topicsAgentSystemPrompt()).not.toContain("DELEGATE THE WORK");
    // A child at the depth cap: spawn_agent would refuse it.
    expect(topicsAgentSystemPrompt("auto", "darwin", false, true, false)).not.toContain("DELEGATE THE WORK");
    expect(topicsAgentSystemPrompt("auto", "darwin", false, true, false)).not.toContain("spawn_agent");
  });

  test("the native engine adds it only where spawn_agent exists", () => {
    const language = "L";
    expect(nativeSystemPrompt({ workspace: true, globalOrchestrator: false, language, delegate: true })).toContain("DELEGATE THE WORK");
    expect(nativeSystemPrompt({ workspace: true, globalOrchestrator: false, language })).not.toContain("DELEGATE THE WORK");
    expect(nativeSystemPrompt({ workspace: false, globalOrchestrator: false, language, delegate: true })).not.toContain("DELEGATE THE WORK");
    expect(nativeSystemPrompt({ workspace: true, globalOrchestrator: true, language, delegate: true })).not.toContain("DELEGATE THE WORK");
  });

  test("the mandate asks for evidence, parallel pieces and a cheaper profile for mechanical work", () => {
    const p = delegationPolicy();
    for (const part of ["line ranges", "exit code", "2-4 at once", "isolation:\"worktree\"", "scout", "reopen the span"]) expect(p).toContain(part);
  });
});

describe("CLI hook", () => {
  test("rides --settings as a synchronous PostToolUse next to Topics' own hooks", () => {
    const args = buildClaudeArgs({
      permissionMode: "default", model: "m", mcpConfigPath: "/x.json",
      hooksScriptPath: "/h/post-hook.sh", delegationHookPath: "/h/delegation-nudge.sh",
    } as Parameters<typeof buildClaudeArgs>[0]);
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]!);
    const post = settings.hooks.PostToolUse.flatMap((m: { hooks: { command: string; async?: boolean }[] }) => m.hooks);
    const nudge = post.find((h: { command: string }) => h.command.includes("delegation-nudge.sh"));
    expect(nudge).toBeDefined();
    expect(nudge.async).toBeUndefined();
    expect(post.some((h: { command: string }) => h.command.includes("post-hook.sh"))).toBe(true);
  });

  test("the CLI matcher lets through exactly the tools the counter reads", () => {
    const matcher = new RegExp(`^(${DELEGATION_HOOK_MATCHER})$`);
    const cliNames = ["Bash", "Read", "Grep", "Glob", "Agent", "Task", "Edit", "Write", "TodoWrite", "WebFetch",
      "mcp__topics__run_command", "mcp__topics__read_process_output", "mcp__topics__wait_for_process", "mcp__topics__browser_eval", "mcp__topics__spawn_agent", "mcp__topics__update_goal_steps"];
    for (const name of cliNames) {
      const counted = INLINE_WORK_TOOL.test(name) || DELEGATION_TOOL.test(name);
      expect([name, matcher.test(name)]).toEqual([name, counted]);
    }
  });

  test("the generated script counts per session and answers with additionalContext", () => {
    const dir = mkdtempSync(join(tmpdir(), "deleg-"));
    try {
      const script = join(dir, "nudge.sh");
      writeFileSync(script, delegationHookScript());
      chmodSync(script, 0o755);
      const transcript = join(dir, "t.jsonl");
      writeFileSync(transcript, JSON.stringify({ message: { usage: { input_tokens: 3, cache_read_input_tokens: 180000, cache_creation_input_tokens: 2000 } } }) + "\n");
      const run = (tool: string, sid = "s1") => spawnSync("sh", [script], {
        input: JSON.stringify({ session_id: sid, tool_name: tool, transcript_path: transcript, tool_input: { command: "ls \"a\"" } }),
        env: { ...process.env, TMPDIR: dir }, encoding: "utf8",
      });
      const outs: string[] = [];
      for (let i = 0; i < DELEGATION_NUDGE.everyInlineCalls; i++) {
        const r = run("Bash");
        expect(r.status).toBe(0);
        outs.push(r.stdout.trim());
      }
      expect(outs.slice(0, -1).every((o) => o === "")).toBe(true);
      const last = JSON.parse(outs.at(-1)!);
      expect(last.hookSpecificOutput.hookEventName).toBe("PostToolUse");
      expect(last.hookSpecificOutput.additionalContext).toContain(`${DELEGATION_NUDGE.everyInlineCalls} tool calls`);
      expect(last.hookSpecificOutput.additionalContext).toContain("~182k tokens");
      // Another session has its own count; a delegation resets this one.
      expect(run("Bash", "s2").stdout).toBe("");
      expect(run("mcp__topics__spawn_agent").stdout).toBe("");
      for (let i = 0; i < DELEGATION_NUDGE.everyInlineCalls - 1; i++) expect(run("Read").stdout).toBe("");
      // Garbage in, nothing out, exit 0.
      const bad = spawnSync("sh", [script], { input: "not json", env: { ...process.env, TMPDIR: dir }, encoding: "utf8" });
      expect(bad.status).toBe(0);
      expect(bad.stdout).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
