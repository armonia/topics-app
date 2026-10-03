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
 * instead. `status`, `help`, `rewind`, `resume`, `export` and `permissions` are
 * refused by the CLI too, but `handleSlashCommand` does each of them for real
 * (CMDUI-02, CMDUI-03), so they are not in this table: a branch that does the
 * thing beats a sentence about it.
 *
 * The names stay in `CLI_BUILTINS` on the server on purpose: whatever reaches
 * the CLI by another road (a board card, an API caller) is refused there at $0
 * instead of becoming a paid prose turn behind a context preamble.
 *
 * `slashCommandRouting.test.ts` reads the measured list of refused names and
 * fails if one is neither in this table nor handled in `ChatPane`.
 */

/** What the composer does with a refused name: a sentence, and «Open a terminal» where that is the answer. */
export interface CliRefusedAnswer {
  /** i18n key of the sentence; `{name}` is the command as typed, without the slash. */
  readonly key: string;
  /** The command is the terminal's: the card offers a terminal in the project. */
  readonly terminal?: boolean;
}

const TERMINAL_ONLY: CliRefusedAnswer = { key: 'chat.cliRefused.terminalOnly', terminal: true };

export const CLI_REFUSED: Readonly<Record<string, CliRefusedAnswer>> = {
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
 * Do `/new` and `/reset` mean Topics' `/clear` on `declaredProvider`
 * (CMDUI-06)? On Claude Code they are the CLI's own aliases of it: forwarded,
 * the live process forgot while the screen kept the history and Topics kept
 * the old session id. On the ACP agents, Codex and Topics' engine nobody
 * answers to them, and sent they were prose to the model, while each of those
 * forgets its session on `/clear`. On openclaw the same two words are the
 * gateway's own reset gestures, so there they travel as typed. An undeclared
 * provider is not assumed.
 */
export function clearAliasesApply(declaredProvider: string | null | undefined): boolean {
  const p = declaredProvider?.trim();
  return !!p && p !== 'openclaw';
}

/** Is `cmd` (lower-cased, trimmed) Topics' `/clear`, or one of its aliases where they apply? */
export function isClearCommand(cmd: string, declaredProvider: string | null | undefined): boolean {
  if (cmd === '/clear') return true;
  return (cmd === '/new' || cmd === '/reset') && clearAliasesApply(declaredProvider);
}

/**
 * Where Topics keeps what a typed `/mcp` or `/config` (alias `/settings`) asks
 * for, on a topic whose declared provider is `declaredProvider` (SETHOME-01):
 * the MCP tools are the «Strumenti» panel of the composer's «+», the rest of
 * the configuration is the user menu. `cmd` is lower-cased and trimmed.
 *
 * `/usage` (aliases `/cost` and `/stats`, `shared/claude-cli-commands.json`)
 * opens the providers panel of the model chip: the Claude plan and its 5-hour
 * window are read there. Forwarded, the CLI answered in English with its own
 * table, as if it were the agent's reply.
 *
 * Only BARE. With arguments (`/mcp enable github`) the command travels to the
 * engine: Claude Code runs both names in `--print`, and opening a panel
 * instead dropped the arguments without a word.
 *
 * On every declared engine but OpenClaw (CMDUI-02): OpenClaw's gateway has its
 * own `/mcp show|set|unset` and `/config show|set|unset`, so there they travel
 * as typed (CMD-08). Codex (`codex exec` parses no command), the native engine
 * and the ACP agents (they announce neither name) would receive them as
 * prose: the panel is the only answer that does something. An undeclared
 * provider is not assumed.
 */
export function topicsHomeCommand(
  cmd: string,
  declaredProvider: string | null | undefined,
): 'tools' | 'userMenu' | 'providers' | null {
  const p = declaredProvider?.trim();
  if (!p || p === 'openclaw') return null;
  if (cmd === '/mcp') return 'tools';
  if (cmd === '/config' || cmd === '/settings') return 'userMenu';
  if (cmd === '/usage' || cmd === '/cost' || cmd === '/stats') return 'providers';
  return null;
}
