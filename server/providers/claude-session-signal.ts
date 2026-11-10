import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * Whether this machine can plausibly run Claude Code: a best-effort signal for
 * the provider diagnosis, not a login check.
 *
 * A fresh headless node (a systemd unit with no `User=`) has no `HOME` in its
 * environment and authenticates through `CLAUDE_CODE_OAUTH_TOKEN`: reading only
 * `$HOME/.claude` resolved to a relative path, reported the provider as
 * unavailable and left the task catalog empty, so no card could start.
 */
export function hasClaudeSessionSignal(
  env: NodeJS.ProcessEnv = process.env,
  deps: { exists?: (path: string) => boolean; home?: () => string } = {},
): boolean {
  if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN) return true;
  const exists = deps.exists ?? existsSync;
  const home = env.HOME || (deps.home ?? homedir)();
  return Boolean(home) && exists(join(home, ".claude"));
}
