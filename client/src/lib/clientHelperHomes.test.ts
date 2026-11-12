/**
 * Small client helpers that live in ONE place, and what the single copy says
 * where the old copies disagreed.
 *
 * - `errMessage`: two of the four local copies were the short form
 *   (`instanceof Error ? message : String(err)`), which turned a thrown
 *   `{ message }` object into «[object Object]» in the file-explorer and git
 *   toasts.
 * - `readJson`: «apiFetch, json on 2xx, null otherwise» was copied into five
 *   files; one passed `{ cache: 'no-store' }`, which must still arrive.
 * - `shortTokens`: three functions with the same name printed the same count as
 *   `1,2 M`, `1200 k`, `1,2M` and `786K`.
 * - the editor toolbar buttons and the Files header of the project sidebar,
 *   each written twice.
 *
 * The last block reads the sources: a copy that comes back is a red here, not a
 * drift discovered months later.
 *
 * @covers FILE-01 FILE-02 HUBBR-13 HUBBR-16 HUBBR-17 NETSHIM-01
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { errMessage } from './errMessage';
import { shortTokens } from './formatTokens';
import { readJson } from './readJson';

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

describe('readJson', () => {
  let originalFetch: typeof globalThis.fetch;
  let seen: { url: string; init?: RequestInit }[];
  let answer: () => Promise<Response>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    seen = [];
    answer = () => Promise.resolve(new Response('{"ok":1}', { status: 200 }));
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return answer();
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('the body on a 2xx, and the init reaches the request', async () => {
    expect(await readJson('/api/hub/queue', { cache: 'no-store' })).toEqual({ ok: 1 });
    expect(seen[0]!.url).toBe('/api/hub/queue');
    expect(seen[0]!.init?.cache).toBe('no-store');
  });

  test('null on a non-2xx, on a network error and on a body that is not JSON', async () => {
    answer = () => Promise.resolve(new Response('{"error":"x"}', { status: 503 }));
    expect(await readJson('/api/hub/live')).toBeNull();
    answer = () => Promise.reject(new TypeError('Failed to fetch'));
    expect(await readJson('/api/hub/live')).toBeNull();
    answer = () => Promise.resolve(new Response('<html>', { status: 200 }));
    expect(await readJson('/api/hub/live')).toBeNull();
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
  const texts = files.map((f) => ({ rel: relative(SRC, f), src: readFileSync(f, 'utf8') }));

  /**
   * Files filesDeclaring `name` at top level in any form: `function`, `async function`,
   * `const x = …`, with or without `export`. Matching one spelling only let the
   * other spellings of a copy through.
   */
  const filesDeclaring = (...names: string[]) => {
    const re = new RegExp(`^(?:export\\s+)?(?:(?:async\\s+)?function\\s+|(?:const|let|var)\\s+)(?:${names.join('|')})\\b`, 'm');
    return texts.filter((t) => re.test(t.src)).map((t) => t.rel).sort();
  };
  /** Files holding a body that reads «json on 2xx, else null», whatever they call it. */
  const jsonOrNullBodies = () => texts.filter((t) => /\.ok\s*\?\s*await\s+\w+\.json\(\)\s*:\s*null/.test(t.src)).map((t) => t.rel).sort();

  test('errMessage is declared only in lib/errMessage.ts', () => {
    expect(filesDeclaring('errMessage')).toEqual(['lib/errMessage.ts']);
  });

  test('readJson is declared only in lib/readJson.ts, plus the proxyActivity one that reads through an injectable fetch', () => {
    expect(filesDeclaring('readJson', 'readJsonOrNull')).toEqual(['lib/readJson.ts', 'state/proxyActivity.ts']);
  });

  test('the «json on 2xx, else null» body lives only in those two files, under any name', () => {
    expect(jsonOrNullBodies()).toEqual(['lib/readJson.ts', 'state/proxyActivity.ts']);
  });

  test('shortTokens is declared only in lib/formatTokens.ts', () => {
    expect(filesDeclaring('shortTokens')).toEqual(['lib/formatTokens.ts']);
  });

  test('the editor toolbar buttons live in one module', () => {
    expect(filesDeclaring('CopyPathBtn')).toEqual(['components/Editor/ToolbarButtons.tsx']);
    expect(filesDeclaring('WrapBtn')).toEqual(['components/Editor/ToolbarButtons.tsx']);
    expect(filesDeclaring('PreviewBtn')).toEqual(['components/Editor/ToolbarButtons.tsx']);
  });

  test('the Files header of the project sidebar is one component, drawn from both columns', () => {
    const src = readFileSync(join(SRC, 'components/Project/ProjectSidebar.tsx'), 'utf8');
    expect(src.match(/data-testid="project-sidebar-files"/g)?.length).toBe(1);
    expect(src.match(/explorerRef\.current\?\.newFile\(\)/g)?.length).toBe(1);
    expect(src.match(/<FilesSectionHeader\b/g)?.length).toBe(2);
  });
});
