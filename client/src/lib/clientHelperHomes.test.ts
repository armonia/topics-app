/**
 * Small client helpers that live in ONE place, and what the single copy says
 * where the old copies disagreed.
 *
 * - `errMessage`: two of the four local copies were the short form
 *   (`instanceof Error ? message : String(err)`), which turned a thrown
 *   `{ message }` object into «[object Object]» in the file-explorer and git
 *   toasts.
 * - `shortTokens`: three functions with the same name printed the same count as
 *   `1,2 M`, `1200 k`, `1,2M` and `786K`.
 * - the editor toolbar buttons and the Files header of the project sidebar,
 *   each written twice.
 *
 * The last block reads the sources: a copy that comes back is a red here, not a
 * drift discovered months later.
 *
 * @covers FILE-01 FILE-02 HUBBR-13 HUBBR-16 HUBBR-17
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { errMessage } from './errMessage';
import { shortTokens } from './formatTokens';

describe('errMessage', () => {
  test('an Error, a string and a plain { message } object all give their words', () => {
    expect(errMessage(new Error('disk full'))).toBe('disk full');
    expect(errMessage('no such branch')).toBe('no such branch');
    // The case where the short copies said «[object Object]».
    expect(errMessage({ message: 'permission denied' })).toBe('permission denied');
  });

  test('anything else falls back to String()', () => {
    expect(errMessage(42)).toBe('42');
    expect(errMessage({ message: 7 })).toBe('[object Object]');
  });
});

describe('shortTokens', () => {
  test('one shape: a space before the unit, lowercase k, a decimal under ten', () => {
    expect(shortTokens(950, 'it')).toBe('950');
    expect(shortTokens(4907, 'it')).toBe('4,9 k');
    expect(shortTokens(14_888, 'it')).toBe('15 k');
    expect(shortTokens(785_799, 'it-IT')).toBe('786 k');
    expect(shortTokens(1_250_000, 'it')).toBe('1,3 M');
    expect(shortTokens(2_300_000, 'it')).toBe('2,3 M');
    expect(shortTokens(12_400_000, 'it')).toBe('12,4 M');
    expect(shortTokens(1_250_000, 'en')).toBe('1.3 M');
  });

  test('millions start where thousands would round to 1000 k', () => {
    // The integer copies printed «1000 k» here.
    expect(shortTokens(999_600, 'it')).toBe('1 M');
    expect(shortTokens(999_400, 'it')).toBe('999 k');
    expect(shortTokens(9_960, 'it')).toBe('10 k');
  });

  test('fractions under a thousand are rounded', () => {
    expect(shortTokens(12.6, 'it')).toBe('13');
  });
});

describe('one copy of each helper in the client', () => {
  const SRC = join(import.meta.dir, '..');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(full);
    }
  };
  walk(SRC);
  const definers = (re: RegExp) => files.filter((f) => re.test(readFileSync(f, 'utf8'))).map((f) => relative(SRC, f)).sort();

  test('errMessage is defined only in lib/errMessage.ts', () => {
    expect(definers(/^(export )?function errMessage\(/m)).toEqual(['lib/errMessage.ts']);
  });

  test('readJson copies are gone; proxyActivity and LoadScreen keep theirs', () => {
    expect(definers(/^async function readJson\(/m)).toEqual(['components/LoadScreen/LoadScreen.tsx', 'state/proxyActivity.ts']);
  });

  test('shortTokens is defined only in lib/formatTokens.ts', () => {
    expect(definers(/^(export )?function shortTokens\(/m)).toEqual(['lib/formatTokens.ts']);
  });

  test('the editor toolbar buttons live in one module', () => {
    expect(definers(/^(export )?function (CopyPathBtn|WrapBtn|PreviewBtn)\(/m)).toEqual(['components/Editor/ToolbarButtons.tsx']);
  });

  test('the Files header of the project sidebar is written once', () => {
    const src = readFileSync(join(SRC, 'components/Project/ProjectSidebar.tsx'), 'utf8');
    expect(src.match(/fileExplorerRef\.current\?\.newFile\(\)|explorerRef\.current\?\.newFile\(\)/g)?.length).toBe(1);
  });
});
