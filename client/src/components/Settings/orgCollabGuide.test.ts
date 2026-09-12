/**
 * The Organization page presents content access and Agent Start as two short,
 * ordered steps backed by live state.
 *
 * The execution step points to the collaborator's already connected computer;
 * it does not introduce another account flow or imply an ownership transfer.
 *
 * WHY ON THE SOURCE AND NOT ON A RENDER. What the requirement asks for is that the
 * page SAYS it — a block of copy next to the project list, in both languages. That
 * is checkable by reading the component and the dictionaryByLanguage, it costs nothing, and
 * it fails for the one reason worth failing for: the guide, or half of it, quietly
 * disappearing in a refactor. A render test would prove the same thing and need a
 * DOM to do it.
 *
 * @covers ORG-PROJECTS-02
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const here = import.meta.dir;
const component = readFileSync(join(here, 'OrgProjectsSection.tsx'), 'utf8');
const dictionaryByLanguage = {
  it: readFileSync(join(here, '..', '..', 'lib', 'i18n-it.ts'), 'utf8'),
  en: readFileSync(join(here, '..', '..', 'lib', 'i18n-en.ts'), 'utf8'),
};

const KEYS = [
  'settings.org.guide.title',
  'settings.org.guide.accessTitle',
  'settings.org.guide.authorizeTitle',
  'settings.org.guide.browser',
  'settings.org.guide.machine',
];

/** The value of one i18n key in one dictionary, or null when the key is absent. */
function phrase(dictionary: string, key: string): string | null {
  const m = dictionary.match(new RegExp(`'${key.replace(/\./g, '\\.')}':\\s*(['"\`])([\\s\\S]*?)\\1\\s*,`));
  return m ? m[2] : null;
}

describe('the guide that names the two kinds of access', () => {
  it('the page renders the guide, next to the project list', () => {
    expect(component).toContain('data-testid="org-collab-guide"');
    // Both halves, not just the title: a guide that lost one of the two
    // paragraphs stops distinguishing anything while still looking present.
    for (const key of KEYS) expect(component).toContain(key);
  });

  it('both halves exist in both languages, and neither is empty', () => {
    for (const [language, dictionary] of Object.entries(dictionaryByLanguage)) {
      for (const key of KEYS) {
        // The failure message carries the key, so a missing one names itself
        // instead of reading as `null is not a string`.
        expect(`${language} ${key}: ${phrase(dictionary, key) === null ? 'MANCANTE' : 'presente'}`)
          .toBe(`${language} ${key}: presente`);
      }
      // Only the two PARAGRAPHS carry the explanation; the title is a title, and
      // a length floor on it would be a number invented here rather than asked
      // for by the requirement.
      for (const key of ['settings.org.guide.browser', 'settings.org.guide.machine']) {
        expect((phrase(dictionary, key) ?? '').length).toBeGreaterThan(40);
      }
    }
  });

  it('the second step names the collaborator computer and fixed policy', () => {
    for (const dictionary of Object.values(dictionaryByLanguage)) {
      expect((phrase(dictionary, 'settings.org.guide.browser') ?? '').toLowerCase()).toContain('browser');
      const machineText = (phrase(dictionary, 'settings.org.guide.machine') ?? '').toLowerCase();
      expect(/collabor|collaborat/.test(machineText)).toBe(true);
      expect(/comput|machine/.test(machineText)).toBe(true);
      expect(/model|modello/.test(machineText)).toBe(true);
    }
  });
});
