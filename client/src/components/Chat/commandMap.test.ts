/**
 * THE MAP OF COMMANDS HOLDS AGAINST THE CLI'S OWN LIST (CMDUI-01, CMDUI-02, CMD-06).
 *
 * The fixture is the list Claude Code 2.1.288 gives in `--print`
 * (`shared/claude-cli-commands.json`: `init.slash_commands`, the aliases read
 * from its bundle, the names it refuses headless). The map must agree with it:
 * a name the map sends to the engine must be one the engine has, a name it
 * answers as refused must be one the engine refuses, and an alias must count
 * as its command. Without the aliases this would be red on `/cost` and
 * `/review`, which work (measured: `/cost` answers at $0, `/review` starts the
 * code-review): whoever made it green by deleting them would break both.
 *
 * @covers CMDUI-01, CMDUI-02, CMD-06
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_ALIASES, ENGINE_LOCAL, ENGINE_PROMPTS, HIDDEN, canonicalCommand, commandKind, engineRow, startsWithMapCommand } from './commandMap';
import { CLI_REFUSED, topicsHomeCommand } from './cliRefused';
import { SLASH_COMMANDS, offeredSlashCommands } from './slashCommands';
import { t } from '../../lib/i18n';

const ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI: { headless: string[]; aliases: Record<string, string>; refused: string[] } = JSON.parse(
  readFileSync(join(ROOT, 'shared/claude-cli-commands.json'), 'utf8'),
);
const CHAT_PANE = readFileSync(join(ROOT, 'client/src/components/Chat/ChatPane.tsx'), 'utf8');
const listed = new Set(CLI.headless);
const isCliName = (n: string) => listed.has(n) || (n in CLI.aliases && listed.has(CLI.aliases[n]!));

describe('the fixture carries the aliases next to the names', () => {
  test('cost and stats are usage, review is code-review, new and reset are clear', () => {
    expect(CLI.aliases).toMatchObject({ cost: 'usage', stats: 'usage', review: 'code-review', new: 'clear', reset: 'clear', settings: 'config', checkup: 'doctor' });
    // The aliases are NOT in the CLI's list: that is why they must be here.
    for (const a of ['cost', 'review', 'new', 'reset']) expect(listed.has(a), a).toBe(false);
  });

  test("the map's aliases are the fixture's", () => {
    for (const [alias, name] of Object.entries(CLAUDE_ALIASES)) {
      if (alias === 'quit') continue; // refused headless, read from the bundle: not in init
      expect(CLI.aliases[alias], alias).toBe(name);
    }
  });
});

describe('every engine name of the map is a command of the CLI', () => {
  test('the local commands and the prompts the map names are in the list, or aliases of one', () => {
    const unknown = [...ENGINE_LOCAL, ...ENGINE_PROMPTS].filter((n) => !isCliName(n));
    expect(unknown, 'the map sends these to the engine, and the CLI does not have them').toEqual([]);
  });

  test('`/cost` and `/review` resolve to names the CLI lists, on Claude Code only', () => {
    expect(canonicalCommand('cost', 'claude-code')).toBe('usage');
    expect(canonicalCommand('/review', 'claude-code')).toBe('code-review');
    expect(listed.has(canonicalCommand('cost', 'claude-code'))).toBe(true);
    expect(listed.has(canonicalCommand('review', 'claude-code'))).toBe(true);
    // OpenClaw's `/new` and `/reset` are its own.
    expect(canonicalCommand('new', 'openclaw')).toBe('new');
  });

  test('no refused name is one the CLI runs, and every refused name is one it refuses', () => {
    for (const n of Object.keys(CLI_REFUSED)) {
      expect(listed.has(n), `${n} is refused here and run by the CLI`).toBe(false);
      expect(CLI.refused, n).toContain(n);
    }
  });

  test('a hidden name is one the CLI has: hiding a name that does not exist hides nothing', () => {
    const unknown = [...HIDDEN].filter((n) => !isCliName(n));
    expect(unknown).toEqual([]);
  });
});

describe('every control names a control that exists, in both languages', () => {
  const controls = SLASH_COMMANDS.filter((c) => c.kind === 'control');

  test('each one says what it opens', () => {
    expect(controls.length).toBeGreaterThanOrEqual(8);
    for (const c of controls) {
      expect(c.opensKey, c.cmd).toBeTruthy();
      for (const lang of ['it', 'en'] as const) expect(t(c.opensKey!, lang), `${c.cmd} ${lang}`).not.toBe(c.opensKey);
    }
  });

  test('and ChatPane opens it, by its own branch or by the home it lives in', () => {
    for (const c of controls) {
      const name = c.cmd.slice(1);
      const branch = new RegExp(`cmd === '/${name}'`).test(CHAT_PANE);
      const home = topicsHomeCommand(c.cmd, 'claude-code') !== null;
      expect(branch || home, `${c.cmd} opens nothing`).toBe(true);
    }
  });

  test('every description exists in Italian and in English', () => {
    for (const c of SLASH_COMMANDS) {
      for (const lang of ['it', 'en'] as const) expect(t(c.descriptionKey, lang), `${c.cmd} ${lang}`).not.toBe(c.descriptionKey);
    }
  });
});

describe('the rows of the engine group (CMDUI-01)', () => {
  test('a name the Topics group shows, a refused or a hidden one has no row; a prompt says «turno»', () => {
    expect(engineRow('compact', 'claude-code')).toBeNull(); // Topics group
    expect(engineRow('model', 'claude-code')).toBeNull(); // a control
    expect(engineRow('vim', 'claude-code')).toBeNull(); // refused
    expect(engineRow('agents', 'claude-code')).toBeNull(); // hidden
    expect(engineRow('review', 'claude-code')).toEqual({ turn: true }); // alias of code-review
    expect(engineRow('init', 'claude-code')).toEqual({ turn: true });
    expect(engineRow('output-style', 'claude-code')).toEqual({ turn: false });
    expect(engineRow('something-new', 'claude-code')).toEqual({ turn: true });
  });

  test('the Topics group follows the declared engine', () => {
    const names = (p: string) => offeredSlashCommands(p).map((c) => c.cmd);
    expect(names('codex')).not.toContain('/compact');
    expect(names('topics')).toContain('/compact');
    expect(names('openclaw')).toContain('/reasoning');
    expect(names('claude-code')).not.toContain('/reasoning');
    expect(names('openclaw')).not.toContain('/mcp');
    expect(names('claude-code')).toContain('/resume');
    expect(commandKind('cost', 'claude-code')).toBe('control');
  });
});

describe('a board composer recognises a command, not a skill (CMDUI-08)', () => {
  test('commands of Topics and of the CLI, aliases included; not a skill, not a path', () => {
    for (const t of ['/compact', '/model opus', '/review', '/init', '/vim']) expect(startsWithMapCommand(t), t).toBe(true);
    for (const t of ['/vai fai il bug', '/tmp/x', 'ciao /compact', '']) expect(startsWithMapCommand(t), t).toBe(false);
  });
});
