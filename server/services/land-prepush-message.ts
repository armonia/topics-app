/**
 * A land copies the card title into the merge message. A repo can refuse that
 * text at push time (a pre-push hook scanning outgoing commits), and then every
 * later land piles up unpublished behind it. The hook is the repo's own
 * configuration, so nothing about WHAT it refuses lives here: we only ask it,
 * with the same stdin a real push gives, and fall back to the bare id prefix.
 */
import { existsSync } from "fs";
import { isAbsolute, join } from "path";
import { runBounded } from "../lib/bounded-spawn";
import { runGit } from "../lib/run-git";

const HOOK_DEADLINE_MS = 60_000;

/** Runs the repo's pre-push hook over `base..sha`. True only when the hook answers with a refusal. */
export async function prePushRefuses(cwd: string, base: string, sha: string): Promise<boolean> {
  // `--git-path hooks/...` ignores `core.hooksPath` on older git, so the setting is read first.
  const configured = await runGit(cwd, ["config", "--path", "--get", "core.hooksPath"], { timeoutMs: 10_000 });
  let dir = configured.code === 0 ? configured.stdout.trim() : "";
  if (dir !== "" && !isAbsolute(dir)) dir = join(cwd, dir);
  if (dir === "") {
    const where = await runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"], { timeoutMs: 10_000 });
    if (where.code !== 0) return false;
    dir = where.stdout.trim();
  }
  if (dir === "") return false;
  const hook = join(dir, "pre-push");
  if (!existsSync(hook)) return false;
  const r = await runBounded([hook, "origin", "origin"], {
    cwd,
    stderr: "pipe",
    timeoutMs: HOOK_DEADLINE_MS,
    stdinData: `refs/heads/main ${sha} refs/heads/main ${base}\n`,
  });
  return !r.spawnFailed && r.exitCode === 1;
}

/**
 * After a merge commit exists at HEAD of `cwd`: when the hook refuses it, the
 * message is rewritten to `neutralMsg` (same tree). Returns true if rewritten.
 */
export async function neutralizeRefusedMergeMessage(cwd: string, neutralMsg: string): Promise<boolean> {
  const head = await runGit(cwd, ["rev-parse", "HEAD"], { timeoutMs: 10_000 });
  const first = await runGit(cwd, ["rev-parse", "HEAD^1"], { timeoutMs: 10_000 });
  if (head.code !== 0 || first.code !== 0) return false;
  if (!(await prePushRefuses(cwd, first.stdout.trim(), head.stdout.trim()))) return false;
  const amend = await runGit(cwd, ["commit", "--amend", "--no-verify", "-m", neutralMsg], { timeoutMs: 30_000, identity: true });
  return amend.code === 0;
}
