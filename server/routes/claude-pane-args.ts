/**
 * The argv of a Claude Code terminal pane after the binary, built here so the
 * one `--settings` of what `createSession` spawns can be read by a test. Pure
 * apart from the settings it reads: the transcript put back and the MCP config
 * file are written by the caller, which hands their outcome in.
 */
import { launchArgs } from "../lib/subagent-launch";
import { claudePaneSettings } from "../lib/topics-hook-script";
import { topicsAgentSystemPrompt } from "../lib/topics-agent-prompt";
import type { SubagentLaunchFlags } from "./terminal-state";

export interface ClaudePaneArgsInput {
  /** A session to resume; wins over `sessionId`. */
  resume?: string;
  /** The id of a new session. */
  sessionId?: string;
  skipPermissions: boolean;
  /** A sub-agent's model, profile and effort, resolved at spawn. */
  launch?: SubagentLaunchFlags | null;
  /** The effort of a pane that is not a sub-agent; null defers to the CLI. */
  effort?: string | null;
  /** The Topics MCP bridge config of this pane, when it could be written. */
  mcp?: { path: string; strict: boolean } | null;
}

export function claudePaneArgs(o: ClaudePaneArgsInput): string[] {
  const args: string[] = [];
  if (o.resume) args.push("--resume", o.resume);
  else if (o.sessionId) args.push("--session-id", o.sessionId);
  if (o.skipPermissions) args.push("--dangerously-skip-permissions");
  // Nudge the agent to launch servers via the Topics MCP (run_script) so they
  // show up in the Processes panel instead of leaking into the bare shell.
  // --append-system-prompt works in interactive mode and is additive to the
  // project's own CLAUDE.md.
  args.push("--append-system-prompt", topicsAgentSystemPrompt());
  // Topics' hooks (phase, current tool, end of turn) travel with the spawn,
  // not from the user's `~/.claude/settings.json`: they fire in this pane and
  // not in the Claude the user starts outside Topics. Same definition as the
  // chat engine (`lib/topics-hooks.ts`). The only `--settings` of this argv:
  // the CLI would keep just the last one.
  // The worktree pair rides the same object (`claude_worktree_hooks`, default on):
  // a `--worktree` or `EnterWorktree` of this pane lands under the worktree root.
  args.push("--settings", JSON.stringify(claudePaneSettings()));
  // Start the interactive session at the same effort tier a Warp shell would
  // ("ultracode" = xhigh): under launchd the server has no CLAUDE_EFFORT, and the
  // user's global effortLevel defaults to low. Tunable via TOPICS_CLAUDE_EFFORT.
  if (o.launch) args.push(...launchArgs(o.launch));
  else if (o.effort) args.push("--effort", o.effort);
  // When scoped, `--strict-mcp-config` makes the CLI use ONLY that set;
  // otherwise it stays additive and nothing the user had is lost.
  if (o.mcp) {
    args.push("--mcp-config", o.mcp.path);
    if (o.mcp.strict) args.push("--strict-mcp-config");
  }
  return args;
}
