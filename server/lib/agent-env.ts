/**
 * THE ENVIRONMENT AN AGENT'S COMMANDS RUN IN: the server's own, cleaned.
 *
 * The server reads secrets from its environment (`TOPICS_LICENSE_TOKEN` in
 * `licenza.ts`, the providers' API keys). None of them belongs to the agent:
 * the Claude Code CLI is spawned with this environment
 * (`providers/claude-code.ts` `buildSafeEnv`), so its `Bash` tool never sees
 * them, and a `run_command` process (`routes/processes.ts`) is spawned with the
 * same one, so the command runs as it would in that `Bash`. Spawned with the
 * whole `process.env`, `run_command env` printed the server's secrets into the
 * log, the panel and the wake row saved in the chat.
 *
 * The allowlist is the rule, the blocklist the cross-check: a `*_TOKEN` added
 * to the list by mistake still stays out.
 */

const ENV_ALLOWLIST = [
  "PATH", "HOME", "TERM", "LANG", "LC_ALL", "LC_CTYPE",
  "NODE_ENV", "TZ", "USER", "SHELL", "TMPDIR",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  "ANTHROPIC_API_KEY",
];

const ENV_DENY_PATTERNS = [
  /API_KEY/i, /TOKEN/i, /SECRET/i, /PASSWORD/i,
  /PRIVATE_KEY/i, /CREDENTIAL/i, /AUTH/i,
];

/** The CLI authenticates with it: the one secret the agent's process carries. */
const ENV_DENY_EXCEPTIONS = new Set(["ANTHROPIC_API_KEY"]);

/** The allowlisted variables of `source` that pass the blocklist. */
export function agentBaseEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = source[key];
    if (!value) continue;
    if (!ENV_DENY_EXCEPTIONS.has(key) && ENV_DENY_PATTERNS.some((p) => p.test(key))) continue;
    env[key] = value;
  }
  return env;
}
