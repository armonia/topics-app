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

/** The environment as it is NOW: under Bun a child launched without `env` sees the one the server was born with. */
const LIVE_ENV = (): Record<string, string> => process.env as Record<string, string>;

/** True when the hook refuses: any non-zero exit, or a hook that failed to run. */
async function prePushRefuses(cwd: string, base: string, sha: string): Promise<boolean> {
  return (await prePushVerdict(cwd, base, sha)).refused;
}

/** Runs the repo's pre-push hook over `base..sha`; `detail` says what happened, for a test that expected a refusal. */
export async function prePushVerdict(cwd: string, base: string, sha: string): Promise<{ refused: boolean; detail: string }> {
  const no = (detail: string) => ({ refused: false, detail });
  // `--git-path hooks/...` ignores `core.hooksPath` on older git, so the setting is read first.
  const configured = await runGit(cwd, ["config", "--path", "--get", "core.hooksPath"], { timeoutMs: 10_000, env: LIVE_ENV() });
  let dir = configured.code === 0 ? configured.stdout.trim() : "";
  if (dir !== "" && !isAbsolute(dir)) dir = join(cwd, dir);
  if (dir === "") {
    const where = await runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"], { timeoutMs: 10_000, env: LIVE_ENV() });
    if (where.code !== 0) return no(`git-path ${where.code} ${where.stderr}`);
    dir = where.stdout.trim();
  }
  if (dir === "") return no("no hooks dir");
  const hook = join(dir, "pre-push");
  if (!existsSync(hook)) return no(`no hook at ${hook}`);
  // Windows cannot exec an extensionless script; git itself runs hooks through sh there.
  const argv = process.platform === "win32" ? ["sh", hook, "origin", "origin"] : [hook, "origin", "origin"];
  const r = await runBounded(argv, {
    cwd,
    stderr: "pipe",
    timeoutMs: HOOK_DEADLINE_MS,
    env: LIVE_ENV(),
    stdinData: `refs/heads/main ${sha} refs/heads/main ${base}\n`,
  });
  // Any non-zero exit or a hook that could not run is a refusal: unknown is not accepted.
  return { refused: r.spawnFailed || r.exitCode !== 0, detail: `${hook} exit=${r.exitCode} spawnFailed=${r.spawnFailed} ${r.spawnError ?? ""} ${r.stderr}` };
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

/**
 * Asks the hook about `message` BEFORE a merge commit exists anywhere: a land
 * through the pull request makes GitHub write the merge commit, which never
 * crosses this hook. A throwaway commit carrying `message` on top of `parent`
 * (same tree) is what the hook scans; it stays dangling and git collects it.
 */
export async function mergeMessageRefused(cwd: string, parent: string, message: string): Promise<boolean> {
  const probe = await runGit(cwd, ["commit-tree", `${parent}^{tree}`, "-p", parent, "-m", message], { timeoutMs: 10_000, identity: true });
  if (probe.code !== 0) return true; // no probe commit to judge: unknown is a refusal
  return prePushRefuses(cwd, parent, probe.stdout.trim());
}
