/**
 * The `user-agent` the native provider presents to Anthropic.
 *
 * WHY IT IS NOT A CONSTANT. The native runtime talks to the API with a Claude
 * Code subscription token, and the API gates models on the CLI version the
 * user-agent declares. It was hard-coded to `claude-cli/2.1.0`, and on 23/09
 * `claude-opus-5-5` (the default) answered 400 "Claude Code 2.1.0 does not
 * support this model; version 2.1.280 or newer is required", while 2.1.280 got
 * a 200 on the same token and request. Every new model raises the floor again,
 * so a literal rots silently.
 *
 * THE SOURCE. The installed CLI is the truth: the native installer keeps each
 * release as `~/.local/share/claude/versions/<version>`, and the highest one is
 * what `claude` runs. Reading the directory costs a `readdir`, no spawn. When
 * nothing is installed (a machine running only the native provider), the
 * floor below is used, and it moves up by hand when a model demands it.
 */
import { readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

/** The minimum known to be accepted for every current default model. */
export const CLAUDE_CLI_VERSION_FLOOR = "2.1.280";

const VERSION = /^\d+\.\d+\.\d+$/;

function compare(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The highest of the candidates and the floor. Pure, for the tests. */
export function pickCliVersion(installed: readonly string[], floor = CLAUDE_CLI_VERSION_FLOOR): string {
  let best = floor;
  for (const v of installed) if (VERSION.test(v) && compare(v, best) > 0) best = v;
  return best;
}

let cached: string | null = null;

/** `claude-cli/<version> (external, cli)`, read once per process. */
export function claudeCliUserAgent(versionsDir = join(homedir(), ".local", "share", "claude", "versions")): string {
  if (cached === null) {
    let installed: string[] = [];
    try {
      installed = readdirSync(versionsDir);
    } catch {
      // No native install: the floor is the answer.
    }
    cached = pickCliVersion(installed);
  }
  return `claude-cli/${cached} (external, cli)`;
}

/** Forget the cached version, for tests. */
export function _resetClaudeCliUserAgent(): void {
  cached = null;
}
