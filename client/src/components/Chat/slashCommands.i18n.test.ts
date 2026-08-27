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
const DESCRIZIONI: string[] = [
  'chat.slash.status.description',
  'chat.slash.context.description',
  'chat.slash.compact.description',
  'chat.slash.clear.description',
  'chat.slash.model.description',
  'chat.slash.effort.description',
  'chat.slash.reasoning.description',
  'chat.slash.agents.description',
  'chat.slash.resume.description',
  'chat.slash.project.description',
  'chat.slash.browser.description',
  'chat.slash.goal.description',
  'chat.slash.help.description',
];

describe('le descrizioni dei comandi slash', () => {
  it('esistono tutte in inglese: nessuna cade sul ripiego italiano', async () => {
    const mancanti = await missingKeys('en');
    expect(mancanti.filter((k) => k.startsWith('chat.slash.'))).toEqual([]);
  });

  it('nessuna esce come CHIAVE GREZZA, in nessuna delle due lingue', () => {
    for (const chiave of DESCRIZIONI) {
      for (const lingua of ['it', 'en'] as const) {
        const reso = t(chiave, lingua);
        // `t()` returns the key when it cannot find it, which is exactly what
        // one would read on screen.
        expect(reso, `${chiave} (${lingua})`).not.toBe(chiave);
        expect(reso.length).toBeGreaterThan(0);
      }
    }
  });

  it("l'elenco copre ogni comando offerto dal composer", async () => {
    // The hand-written list above is the point of this file, so it is compared
    // with the array rather than generated from it: a command added without its
    // translations lands here.
    const { SLASH_COMMANDS } = await import('./slashCommands');
    expect(SLASH_COMMANDS.map((c) => c.descriptionKey).sort()).toEqual([...DESCRIZIONI].sort());
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
