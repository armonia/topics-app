/**
 * The Claude Code commands that cannot run where Topics runs the CLI, and what
 * to use in Topics instead.
 *
 * Topics drives the CLI with `--print`. In that mode Claude Code 2.1.288
 * refuses a whole family of its own commands — the TUI screens and the account
 * flows — with «/X isn't available in this environment.» (measured one by one,
 * each at $0). They are still in the server's `CLI_BUILTINS`, so typing one
 * delivered it naked to a process that could only refuse, and the refusal
 * arrived in English as if it were the agent's answer. `/resume` was even
 * offered in the menu as resuming an agent by «@name», a concept that exists
 * nowhere.
 *
 * CMD-06 asks for these to be answered HERE, saying so and naming what to use
 * instead. `status`, `help` and `rewind` are refused by the CLI too, but
 * `handleSlashCommand` already does each of them for real, so they are not in
 * this table: a branch that does the thing beats a sentence about it.
 *
 * The names stay in `CLI_BUILTINS` on the server on purpose: whatever reaches
 * the CLI by another road (a board card, an API caller) is refused there at $0
 * instead of becoming a paid prose turn behind a context preamble.
 *
 * `slashCommandRouting.test.ts` reads the measured list of refused names and
 * fails if one is neither in this table nor handled in `ChatPane`.
 */

/** What the composer does with a refused name: a sentence, or an action of Topics that does the same job. */
export interface CliRefusedAnswer {
  /** i18n key of the sentence; `{name}` is the command as typed, without the slash. */
  readonly key: string;
  /** A Topics action that does what the command would have done in the terminal. */
  readonly action?: 'export';
}

const TERMINAL_ONLY: CliRefusedAnswer = { key: 'chat.cliRefused.terminalOnly' };

export const CLI_REFUSED: Readonly<Record<string, CliRefusedAnswer>> = {
  resume: { key: 'chat.cliRefused.resume' },
  export: { key: 'chat.cliRefused.export', action: 'export' },
  permissions: { key: 'chat.cliRefused.permissions' },
  exit: { key: 'chat.cliRefused.exit' },
  quit: { key: 'chat.cliRefused.exit' },
  memory: { key: 'chat.cliRefused.memory' },
  login: TERMINAL_ONLY,
  logout: TERMINAL_ONLY,
  vim: TERMINAL_ONLY,
  'release-notes': TERMINAL_ONLY,
  bug: TERMINAL_ONLY,
  'privacy-settings': TERMINAL_ONLY,
  'terminal-setup': TERMINAL_ONLY,
  upgrade: TERMINAL_ONLY,
  hooks: TERMINAL_ONLY,
  sandbox: TERMINAL_ONLY,
  statusline: TERMINAL_ONLY,
  'add-dir': TERMINAL_ONLY,
  ide: TERMINAL_ONLY,
};

/**
 * Does the topic DECLARE Claude Code (CMD-08)? Every fact in this file was
 * measured on Claude Code's CLI, and other providers run some of these names
 * themselves: gemini answers `/memory list` locally (measured, gemini-cli
 * 0.55.1 over ACP, 0 tokens), openclaw has its own `/login`, `/export`, `/new`
 * and `/reset`. `claude-code-team` is the legacy name of the same provider
 * (`server/routes/commandRouting.ts` `declaredProviderName`). An undeclared
 * provider is not assumed: the provider then answers for itself, as before.
 */
export function declaresClaudeCode(declaredProvider: string | null | undefined): boolean {
  const p = declaredProvider?.trim();
  return p === 'claude-code' || p === 'claude-code-team';
}

/**
 * The refused command a message invokes, if any, on a topic whose declared
 * provider is `declaredProvider`. Same first-token rule as the server's
 * `isCliBuiltin`: the name is what follows the slash up to the first space,
 * lower-cased, and a first token containing a slash is a path.
 */
export function cliRefusedCommand(
  text: string,
  declaredProvider: string | null | undefined,
): { name: string; answer: CliRefusedAnswer } | null {
  if (!declaresClaudeCode(declaredProvider)) return null;
  const t = text.trimStart();
  if (!t.startsWith('/')) return null;
  const name = (t.slice(1).split(/\s/, 1)[0] ?? '').toLowerCase();
  if (!name || name.includes('/')) return null;
  const answer = Object.prototype.hasOwnProperty.call(CLI_REFUSED, name) ? CLI_REFUSED[name] : undefined;
  return answer ? { name, answer } : null;
}

/**
 * Is `cmd` (lower-cased, trimmed) Topics' `/clear`? `/new` and `/reset` are
 * Claude Code's aliases of it: forwarded there, the live process forgot while
 * the screen kept the history and Topics kept the old session id. On openclaw
 * the same two words are the gateway's own reset gestures, and openclaw has no
 * `/clear`, so elsewhere they travel as typed.
 */
export function isClearCommand(cmd: string, declaredProvider: string | null | undefined): boolean {
  if (cmd === '/clear') return true;
  return (cmd === '/new' || cmd === '/reset') && declaresClaudeCode(declaredProvider);
}

/**
 * Where Topics keeps what a typed `/mcp` or `/config` (alias `/settings`) asks
 * for, on a topic whose declared provider is `declaredProvider` (SETHOME-01):
 * the MCP tools are the «Strumenti» panel of the composer's «+», the rest of
 * the configuration is the user menu. `cmd` is lower-cased and trimmed.
 *
 * `/usage` (aliases `/cost` and `/stats`, `claudeCliCommands.fixture.json`)
 * opens the providers panel of the model chip: the Claude plan and its 5-hour
 * window are read there. Forwarded, the CLI answered in English with its own
 * table, as if it were the agent's reply.
 *
 * Only BARE and only on Claude Code. With arguments (`/mcp enable github`) the
 * command travels to the CLI, which runs both names in `--print`: opening a
 * panel instead dropped the arguments without a word. Other providers have
 * their own commands under these names (openclaw `/mcp show|set|unset` and
 * `/config show|set|unset`, gemini and codex `/mcp`), so there they travel as
 * typed (CMD-08).
 */
export function topicsHomeCommand(
  cmd: string,
  declaredProvider: string | null | undefined,
): 'tools' | 'userMenu' | 'providers' | null {
  if (!declaresClaudeCode(declaredProvider)) return null;
  if (cmd === '/mcp') return 'tools';
  if (cmd === '/config' || cmd === '/settings') return 'userMenu';
  if (cmd === '/usage' || cmd === '/cost' || cmd === '/stats') return 'providers';
  return null;
}
