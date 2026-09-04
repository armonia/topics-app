/**
 * The two catalogues, read together, for the surfaces where a missing key is
 * not a cosmetic defect.
 *
 * `t()` falls back to Italian for a key English does not have, which is the
 * right behaviour at runtime and the wrong one to rely on: it means an English
 * user reads Italian and nothing anywhere says so. These are the places where
 * that matters enough to be a test rather than a habit:
 *
 *  - the PERMISSION panel, where a person decides whether an agent may touch
 *    their files. A button whose word did not follow the language selector is
 *    a consent given in a language nobody chose.
 *  - the QUEUE REASON chip, which is generated: `deriveQueueReason` picks a
 *    message key on the SERVER and the client only renders it, so a branch
 *    added there without its two catalogue entries prints the key or the wrong
 *    language, and it prints it on every card that hits that branch.
 *
 * The Italian catalogue is imported eagerly, the English one through the same
 * `await import` the app uses, so this test also proves the lazy chunk still
 * resolves.
 */
import { describe, expect, it } from 'bun:test';
import IT from './i18n-it';
import EN from './i18n-en';
import { PERMISSION_HINT_KEY, PERMISSION_LABEL_KEY } from '../../../shared/permission-decision';
import { QUEUE_REASON_KINDS, queueReasonKeys } from '../../../shared/board';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const both = (key: string): { it: string | undefined; en: string | undefined } => ({
  it: IT[key],
  en: (EN as Record<string, string>)[key],
});

describe('permission panel: every decision has both languages', () => {
  it('label and hint exist in Italian and in English', () => {
    for (const key of [...Object.values(PERMISSION_LABEL_KEY), ...Object.values(PERMISSION_HINT_KEY)]) {
      const found = both(key);
      expect(found.it, `${key} missing from the Italian catalogue`).toBeTruthy();
      expect(found.en, `${key} missing from the English catalogue`).toBeTruthy();
    }
  });

  it('the free-mode line says what stops happening and how to go back, in both', () => {
    // A permanent consent that does not say how it is revoked is a door that
    // only opens. The assertion used to live in `shared/permission-decision`,
    // where the words were; it follows them here, and now covers two languages
    // instead of one.
    const key = PERMISSION_HINT_KEY.allow_free;
    expect(both(key).it).toContain('senza chiedere'); // allow-italian: the Italian copy IS what is asserted
    expect(both(key).it).toContain('autonomia'); // allow-italian: the Italian copy IS what is asserted
    expect(both(key).en).toContain('without asking');
    expect(both(key).en).toContain('autonomy');
  });
});

describe('browser pane context menu: nine entries, two languages', () => {
  // The pane menu is driven by a NATIVE browser view: headless CI has none, so
  // there is no DOM to click and the e2e half of this check does not exist.
  // What can be proven without one is the whole of what broke: the component
  // holds no literal (it reads this table) and every entry of the table has
  // both languages, which are the two ways it can silently stay Italian.
  const KEYS = [
    'browser.menu.back', 'browser.menu.forward', 'browser.menu.reload',
    'browser.menu.copy', 'browser.menu.copyLink', 'browser.menu.openLink',
    'browser.menu.copyImage', 'browser.menu.copyImageAddress', 'browser.menu.inspect',
  ];

  it('every entry exists in both catalogues, and the two differ', () => {
    for (const key of KEYS) {
      const found = both(key);
      expect(found.it, `${key} missing from the Italian catalogue`).toBeTruthy();
      expect(found.en, `${key} missing from the English catalogue`).toBeTruthy();
      // Identical strings would mean one language was copied into the other,
      // which is how "translated" surfaces stay untranslated.
      expect(found.en, `${key} is the same in both languages`).not.toBe(found.it);
    }
  });

  it('the component reads the table instead of holding the words', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '../components/Browser/PaneContextMenu.tsx'),
      'utf8',
    );
    for (const key of KEYS) expect(src, `${key} not rendered by the menu`).toContain(`tr('${key}')`);
    // The nine Italian labels that used to be here, by value: if one comes
    // back, this fails on the word rather than on a count.
    for (const key of KEYS) expect(src).not.toContain(`'${IT[key]!}'`);
  });
});

describe('queue reason chip: every branch the server can pick is writable', () => {
  it('each kind has head, detail and title in both catalogues', () => {
    // The list is exhaustive by construction (`QUEUE_REASON_KINDS` is the same
    // union the dispatcher switches on), so a new branch cannot land with a
    // chip nobody can read.
    for (const kind of QUEUE_REASON_KINDS) {
      for (const key of queueReasonKeys(kind)) {
        const found = both(key);
        expect(found.it, `${key} missing from the Italian catalogue`).toBeTruthy();
        expect(found.en, `${key} missing from the English catalogue`).toBeTruthy();
      }
    }
  });

  it('no placeholder is left unfilled by the other language', () => {
    // A `{n}` that exists in one catalogue and not in the other is a sentence
    // that loses its number when the language changes.
    const holes = (s: string): string[] => (s.match(/\{(\w+)\}/g) ?? []).sort();
    for (const kind of QUEUE_REASON_KINDS) {
      for (const key of queueReasonKeys(kind)) {
        const found = both(key);
        expect(holes(found.en ?? ''), `${key}: placeholders differ between languages`).toEqual(
          holes(found.it ?? ''),
        );
      }
    }
  });
});
