/**
 * A land copies the card title into the merge message. A repo can refuse that
 * text at push time (a pre-push hook scanning outgoing commits), and then every
 * later land piles up unpublished behind it. The hook is the repo's own
 * configuration, so nothing about WHAT it refuses lives here: we only ask it,
 * with the same stdin a real push gives, and fall back to the bare id prefix.
 */
import { spawn } from "child_process";
import { runGit } from "../lib/run-git";

const HOOK_DEADLINE_MS = 60_000;

/** Runs the repo's pre-push hook over `base..sha`. True only when the hook answers with a refusal. */
export async function prePushRefuses(cwd: string, base: string, sha: string): Promise<boolean> {
  const where = await runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-push"], { timeoutMs: 10_000 });
  const hook = where.stdout.trim();
  if (where.code !== 0 || hook === "") return false;
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (v: boolean) => { if (!done) { done = true; resolve(v); } };
    try {
      const child = spawn(hook, ["origin", "origin"], { cwd, stdio: ["pipe", "ignore", "ignore"], timeout: HOOK_DEADLINE_MS });
      const timer = setTimeout(() => { child.kill("SIGKILL"); finish(false); }, HOOK_DEADLINE_MS);
      child.on("error", () => { clearTimeout(timer); finish(false); });
      child.on("close", (code) => { clearTimeout(timer); finish(code === 1); });
      child.stdin.on("error", () => undefined);
      child.stdin.end(`refs/heads/main ${sha} refs/heads/main ${base}\n`);
    } catch {
      finish(false);
    }
  });
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
