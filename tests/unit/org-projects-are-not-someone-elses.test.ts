/**
 * @covers ORG-PROJECTS-NO-HARDCODE-01
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE ORGANISATION PANEL SHIPPED ONE INSTALLATION'S PROJECTS TO EVERYBODY.
 *
 * «Recommended workspaces for Armonia» listed six hardcoded names, two badged
 * «suggested», on every install: a company name that is not the reader's, and
 * somebody's personal repositories presented as advice. This gate keeps the
 * strings and the component free of names that can only come from one machine.
 */
const ROOT = join(import.meta.dir, '../..');
const FILES = [
  'client/src/lib/i18n-it.ts',
  'client/src/lib/i18n-en.ts',
  'client/src/components/Settings/OrgProjectsSection.tsx',
];
// Names that exist only on the machine this panel was written on.
const LEAKED = ['Armonia', 'armonia', 'danceroom', 'topics-app'];

describe('the organisation projects panel', () => {
  test('no dictionary string under settings.org.projects. names one installation', () => {
    for (const file of FILES.slice(0, 2)) {
      const lines = readFileSync(join(ROOT, file), 'utf8').split('\n')
        .filter((l) => l.includes("'settings.org.projects."));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        for (const name of LEAKED) expect(line).not.toContain(name);
      }
    }
  });

  test('the component proposes no workspace the installation does not have', () => {
    const src = readFileSync(join(ROOT, FILES[2]!), 'utf8');
    const code = src.split('\n')
      .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//') && !l.includes('/*'))
      .join('\n');
    for (const name of LEAKED) expect(code).not.toContain(name);
    // The inert `FolderPlus` looked like «add this space» and had no handler.
    expect(code).not.toContain('FolderPlus');
  });
});
