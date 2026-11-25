/**
 * Where the hook script lives on disk, and how it gets there.
 *
 * Next to the token, under Topics' OWN home: `${TOPICS_HOME}/claude-hooks/`.
 * It used to be a copy in `~/.claude/topics-hooks/`, made by the installer —
 * meaning the hooks only worked for whoever had installed them globally, and
 * then fired in every Claude session of the machine. Now the server writes it at
 * boot and hands it to its own spawns through `--settings` (`topics-hooks.ts`).
 *
 * The text is EMBEDDED (`with { type: "text" }`): the `bun build --compile`
 * sidecar has no `scripts/` dir to read it from. `scripts/claude-hooks/post-hook.sh`
 * stays the source.
 */
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { topicsHome } from "../services/daemon-state";
import { resolveClaudeWorktreeHooks } from "../services/app-settings";
import { writeFileAtomic } from "./atomic-write";
import { mergeHooks, topicsHooksSettings, topicsWorktreeHooksSettings, type HooksBlock } from "./topics-hooks";
import POST_HOOK_SCRIPT from "../../scripts/claude-hooks/post-hook.sh" with { type: "text" };
import WORKTREE_HOOK_TEXT from "../../scripts/claude-hooks/worktree-hook.sh" with { type: "text" };

/** The worktree hook's text (`scripts/claude-hooks/worktree-hook.sh`, the source), embedded like the post hook. */
export const WORKTREE_HOOK_SCRIPT: string = WORKTREE_HOOK_TEXT;

export function hookScriptPath(home: string = topicsHome()): string {
  return join(home, "claude-hooks", "post-hook.sh");
}

/**
 * The Claude Code worktree hook (WorktreeCreate / WorktreeRemove), next to the
 * post hook. It is also the library of `scripts/topics-worktree` and of the
 * optional `post-checkout` git hook, which look for it here.
 */
export function worktreeHookPath(home: string = topicsHome()): string {
  return join(home, "claude-hooks", "worktree-hook.sh");
}

/**
 * The worktree hook a Claude session Topics launches gets: the script, or null
 * when `claude_worktree_hooks` is off. Read at every spawn, one answer for the
 * chat engine and the terminal pane.
 */
export function sessionWorktreeHookPath(home: string = topicsHome()): string | null {
  return resolveClaudeWorktreeHooks() === "off" ? null : worktreeHookPath(home);
}

/**
 * The one `--settings` object of a Claude terminal pane: Topics' hooks, plus the
 * worktree pair unless `claude_worktree_hooks` is off. One object because the CLI
 * keeps only the last `--settings`.
 */
export function claudePaneSettings(home: string = topicsHome()): { hooks: HooksBlock } {
  const worktree = sessionWorktreeHookPath(home);
  return { hooks: mergeHooks(topicsHooksSettings(hookScriptPath(home)).hooks, worktree ? topicsWorktreeHooksSettings(worktree).hooks : undefined) };
}

/** The delegation nudge (`lib/delegation-policy.ts`), next to the hook script. */
export function delegationHookPath(home: string = topicsHome()): string {
  return join(home, "claude-hooks", "delegation-nudge.sh");
}

/**
 * Write `content` at `path`, mode 0755, only when what is there differs (text
 * or mode). Returns whether it wrote. Throws on a disk error: the caller decides
 * how loud to be.
 */
export function writeHookScript(path: string, content: string = POST_HOOK_SCRIPT): boolean {
  let same = false;
  try {
    same = readFileSync(path, "utf-8") === content && (statSync(path).mode & 0o777) === 0o755;
  } catch {
    // Missing or unreadable: write it.
  }
  if (same) return false;
  mkdirSync(dirname(path), { recursive: true });
  // Temp + rename, mode set on the temp: the live sessions run this file on
  // every hook, and a plain write truncates it first. A hook starting in that
  // window would run an empty or half-written script.
  writeFileAtomic(path, content, { mode: 0o755 });
  return true;
}
