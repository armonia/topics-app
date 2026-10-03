/**
 * THE MAP OF COMMANDS: for every name that can appear in the «/» menu or be
 * typed, what Topics makes of it (CMDUI-01, CMD-06).
 *
 *  - `topics`: Topics runs it (`handleSlashCommand`), on every engine that holds it;
 *  - `control`: it opens a control of Topics, or sets it with a valid argument;
 *  - `engine`: it travels bare to the engine, which runs it;
 *  - `refused`: the engine refuses it where Topics drives it; answered here;
 *  - `hidden`: not in the menu; typed by hand it travels as before.
 *
 * The Topics group is `slashCommands.ts`; the engine's group and the skills
 * come from the engine (`GET /api/slash-commands`). This file decides, for a
 * name the engine lists, whether its row is shown and whether it makes the
 * model work («turno»). A name of the engine the map does not know is an
 * `engine` command that makes the model work: the CLI's LOCAL commands are a
 * closed list (measured on 2.1.288), everything else is a prompt.
 *
 * ALIASES ARE THEIR COMMAND. The CLI's `init.slash_commands` lists names, not
 * aliases (measured: `review`, `cost`, `stats`, `new`, `reset`, `settings`,
 * `checkup` are not in it). The menu shows the canonical name only; typed, an
 * alias resolves to its name before any other rule.
 */
import { CLI_REFUSED, clearAliasesApply, declaresClaudeCode } from './cliRefused';
import { offeredSlashCommands, SLASH_COMMANDS, type SlashCommandEntry } from './slashCommands';

export type CommandKind = 'topics' | 'control' | 'engine' | 'refused' | 'hidden';

/** Claude Code's aliases, read from its bundle (2.1.288): alias → name. */
export const CLAUDE_ALIASES: Readonly<Record<string, string>> = {
  cost: 'usage',
  stats: 'usage',
  review: 'code-review',
  new: 'clear',
  reset: 'clear',
  settings: 'config',
  checkup: 'doctor',
  quit: 'exit',
};

/**
 * The CLI's commands that answer by themselves in `--print`, no model turn
 * (type `local` with `supportsNonInteractive`, measured each at $0). Their
 * answer goes to the chat's command card (CMDUI-04).
 */
export const ENGINE_LOCAL: ReadonlySet<string> = new Set([
  'output-style', 'skill-doctor', 'reload-skills', 'reload-plugins', 'autocompact',
  'usage-credits', 'list-agents', 'agents',
]);

/**
 * Not offered, typed they travel as before. Why each one:
 *  - `agents`: the CLI answers that its wizard is gone, and there is no roster;
 *  - `doctor`: a prompt that rewrites CLAUDE.md and the memory files: whoever
 *    types it wants it, the menu does not propose it;
 *  - `advisor`: changes the model the CLI consults inside the session, behind
 *    the back of Topics' model selector: two places deciding the model diverge;
 *  - `color`, `focus`, `heapdump`, `import`, the `design*` and internal
 *    workflow names, `auto-mode-setup`, `extra-usage` (renamed): TUI cosmetics,
 *    one-off setups, or names only the CLI's own server launches use.
 */
export const HIDDEN: ReadonlySet<string> = new Set([
  'agents', 'doctor', 'advisor', 'color', 'focus', 'heapdump', 'import',
  'design', 'design-consent', 'design-revoke', '__remote-workflow', 'workflow-launch-exec',
  'auto-mode-setup', 'extra-usage',
]);

/** The canonical name of `name` (no slash, lower-cased) on a topic that declares `provider`. */
export function canonicalCommand(name: string, provider: string | null | undefined): string {
  const n = name.replace(/^\//, '').toLowerCase();
  if (declaresClaudeCode(provider)) return CLAUDE_ALIASES[n] ?? n;
  // Elsewhere only `/new` and `/reset` are `/clear` (CMDUI-06), and not on
  // OpenClaw, where they are the gateway's own reset gestures.
  return (n === 'new' || n === 'reset') && clearAliasesApply(provider) ? 'clear' : n;
}

/** The Topics entry a name stands for on this provider, if it is offered there. */
export function topicsEntryFor(name: string, provider: string | null | undefined): SlashCommandEntry | null {
  const canonical = canonicalCommand(name, provider);
  return offeredSlashCommands(provider).find((c) => c.cmd === `/${canonical}`) ?? null;
}

/** What Topics makes of `name` on a topic that declares `provider`. */
export function commandKind(name: string, provider: string | null | undefined): CommandKind {
  const canonical = canonicalCommand(name, provider);
  const entry = topicsEntryFor(canonical, provider);
  if (entry) return entry.kind;
  if (declaresClaudeCode(provider) && Object.prototype.hasOwnProperty.call(CLI_REFUSED, canonical)) return 'refused';
  if (HIDDEN.has(canonical)) return 'hidden';
  return 'engine';
}

/**
 * The row of the engine's group for a name the engine listed, or null when the
 * name has no row there: it is in the Topics group (a control, a Topics
 * command), refused, or hidden.
 */
export function engineRow(name: string, provider: string | null | undefined): { turn: boolean } | null {
  if (commandKind(name, provider) !== 'engine') return null;
  return { turn: !ENGINE_LOCAL.has(canonicalCommand(name, provider)) };
}

/** The CLI's prompts the menu names (CMDUI-01): with the lists above, every name the map knows. */
export const ENGINE_PROMPTS: ReadonlySet<string> = new Set([
  'init', 'code-review', 'security-review', 'simplify', 'batch', 'debug', 'loop', 'schedule', 'verify', 'insights',
]);

/**
 * Does `text` start with a name of the map: a command of Topics or of an
 * engine, not a skill of the person's (CMDUI-08)? The board's composers ask
 * it: there a command is text, and the agent's chat is where it runs.
 */
export function startsWithMapCommand(text: string): boolean {
  const name = invokedName(text);
  if (!name) return false;
  const canonical = CLAUDE_ALIASES[name] ?? name;
  return SLASH_COMMANDS.some((c) => c.cmd === `/${canonical}`)
    || ENGINE_LOCAL.has(canonical) || ENGINE_PROMPTS.has(canonical) || HIDDEN.has(canonical)
    || Object.prototype.hasOwnProperty.call(CLI_REFUSED, canonical);
}

/** The shape of a command at the start of a message (Claude Code's own rule). */
const COMMAND_NAME = /^[a-zA-Z0-9_][a-zA-Z0-9:_-]*$/;

/**
 * The command a message INVOKES, by shape (SKILL-03): `/name` at the very
 * start. A pasted path (`/tmp/x`) is not one. Lower-cased, without the slash.
 */
export function invokedName(text: string): string | null {
  const t = text.trimStart();
  if (!t.startsWith('/')) return null;
  const first = t.slice(1).split(/\s/, 1)[0] ?? '';
  return COMMAND_NAME.test(first) ? first.toLowerCase() : null;
}
