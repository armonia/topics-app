/**
 * The Organization page has to say that sharing a project and letting someone RUN
 * AGENTS on it are two different things, because they are, and because confusing
 * them costs a person a whole evening.
 *
 * The two are not substitutes: a grant (or a remote link) hands over reading,
 * commenting and editing a project's TASKS from a browser, on any machine, with
 * nothing installed. Running agents on that work needs Topics installed on the
 * other person's computer, paired as a device, with its own checkout. Someone who
 * shares a project expecting the second thing waits for something that is never
 * going to happen, and there is no error anywhere to tell them.
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

const KEYS = ['settings.org.guide.title', 'settings.org.guide.browser', 'settings.org.guide.machine'];

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

  it('one half names the browser, the other names a second machine', () => {
    // The distinction is the whole requirement: if both paragraphs described the
    // same access the page would be naming one thing twice.
    for (const dictionary of Object.values(dictionaryByLanguage)) {
      expect((phrase(dictionary, 'settings.org.guide.browser') ?? '').toLowerCase()).toContain('browser');
      const machineText = (phrase(dictionary, 'settings.org.guide.machine') ?? '').toLowerCase();
      expect(machineText.includes('topics')).toBe(true);
      expect(/comput|machineText|machine/.test(machineText)).toBe(true);
    }
  });
});
