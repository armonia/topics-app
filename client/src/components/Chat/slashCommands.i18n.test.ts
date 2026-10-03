/**
 * THE COMMAND DESCRIPTIONS EXIST IN BOTH LANGUAGES.
 *
 * WHY THIS FILE EXISTS. The descriptions used to be English literals inside
 * `SLASH_COMMANDS`, in an app whose default language is Italian, and they are
 * read on two surfaces at once: the `/` completion menu in the composer and the
 * text `/help` prints. Now they are keys. A key nobody wrote does not fail
 * anything: `t()` returns the key itself, so `chat.slash.status.description`
 * appears where a sentence should be, with every test green.
 *
 * THE LIST IS HAND-WRITTEN, on purpose. Deriving it from `slashCommands.ts`
 * would only prove the code agrees with itself; what has to be true is that
 * each line says something to a person, in their language. A command added
 * without its two translations must make this file red.
 *
 * `missingKeys('en')` is used instead of reading the dictionaries, because the
 * English catalogue is a lazy chunk: read right after start-up it answers "they
 * are all missing", which is true and useless.
 *
 * @covers I18N-02
 */
import { describe, it, expect } from 'bun:test';
import { t, missingKeys } from '../../lib/i18n';

/** One key per command the composer offers. Kept in the menu's own order. */
const DESCRIPTIONS: string[] = [
  'chat.slash.status.description',
  'chat.slash.context.description',
  'chat.slash.compact.description',
  'chat.slash.clear.description',
  'chat.slash.model.description',
  'chat.slash.effort.description',
  'chat.slash.reasoning.description',
  'chat.slash.project.description',
  'chat.slash.browser.description',
  'chat.slash.goal.description',
  'chat.slash.fork.description',
  'chat.slash.help.description',
  'chat.slash.resume.description',
  'chat.slash.permissions.description',
  'chat.slash.fast.description',
  'chat.slash.usage.description',
  'chat.slash.mcp.description',
  'chat.slash.config.description',
  'chat.slash.rewind.description',
  'chat.slash.rename.description',
  'chat.slash.export.description',
];

describe('le descrizioni dei comandi slash', () => {
  it('esistono tutte in inglese: nessuna cade sul ripiego italiano', async () => {
    const missing = await missingKeys('en');
    expect(missing.filter((k) => k.startsWith('chat.slash.'))).toEqual([]);
  });

  it('nessuna esce come CHIAVE GREZZA, in nessuna delle due lingue', () => {
    for (const key of DESCRIPTIONS) {
      for (const lingua of ['it', 'en'] as const) {
        const rendered = t(key, lingua);
        // `t()` returns the key when it cannot find it, which is exactly what
        // one would read on screen.
        expect(rendered, `${key} (${lingua})`).not.toBe(key);
        expect(rendered.length).toBeGreaterThan(0);
      }
    }
  });

  it("l'elenco copre ogni comando offerto dal composer", async () => {
    // The hand-written list above is the point of this file, so it is compared
    // with the array rather than generated from it: a command added without its
    // translations lands here.
    const { SLASH_COMMANDS } = await import('./slashCommands');
    expect(SLASH_COMMANDS.map((c) => c.descriptionKey).sort()).toEqual([...DESCRIPTIONS].sort());
  });

  it('il comando NON si traduce: è quello che si digita', async () => {
    // `/status` is a token the CLI parses, not a word one reads. The two
    // languages must offer the same commands, or a menu entry in one language
    // would be a message to the model in the other.
    const { SLASH_COMMANDS } = await import('./slashCommands');
    for (const c of SLASH_COMMANDS) {
      expect(c.cmd).toMatch(/^\/[a-z-]+$/);
    }
  });
});

describe('the answers to commands the CLI refuses in Topics', () => {
  // `cliRefused.ts` carries keys too. A missing one would print
  // `chat.cliRefused.x` where the person was told what to use instead.
  it('exist in both languages, and name the command they answer when it varies', async () => {
    const { CLI_REFUSED } = await import('./cliRefused');
    const keys = new Set(Object.values(CLI_REFUSED).map((a) => a.key));
    // Three since `/resume`, `/export` and `/permissions` are Topics' own
    // (CMDUI-02, CMDUI-03): the terminal's commands, `/exit`, `/memory`.
    expect(keys.size).toBeGreaterThanOrEqual(3);
    for (const key of keys) {
      for (const lingua of ['it', 'en'] as const) {
        const rendered = t(key, lingua, { name: 'vim' });
        expect(rendered, `${key} (${lingua})`).not.toBe(key);
        if (key === 'chat.cliRefused.terminalOnly') expect(rendered).toContain('/vim');
      }
    }
    const missing = await missingKeys('en');
    expect(missing.filter((k) => k.startsWith('chat.cliRefused.') || k.startsWith('chat.project.') || k.startsWith('chat.compact.'))).toEqual([]);
  });
});
