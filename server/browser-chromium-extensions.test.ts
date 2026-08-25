/**
 * @covers EXTDISC-01
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { listUnpackedExtensions, discoverInstalledExtensions, chromiumExtensionDirs } from './browser-chromium-extensions';

let root: string;
let extDir: string;

const VALID = 'abcdefghijklmnopabcdefghijklmnop'; // 32 chars a–p
const VALID2 = 'ponmlkjihgfedcbaponmlkjihgfedcba';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ext-test-'));
  extDir = join(root, 'Extensions');
  // Valid ext with two versions; only the higher has a usable manifest picked.
  mkdirSync(join(extDir, VALID, '1.2.0'), { recursive: true });
  writeFileSync(join(extDir, VALID, '1.2.0', 'manifest.json'), JSON.stringify({ name: 'Old', version: '1.2.0' }));
  mkdirSync(join(extDir, VALID, '1.10.0'), { recursive: true });
  writeFileSync(join(extDir, VALID, '1.10.0', 'manifest.json'), JSON.stringify({ name: 'My Extension', version: '1.10.0' }));
  // Second valid ext, single version.
  mkdirSync(join(extDir, VALID2, '3.0.0'), { recursive: true });
  writeFileSync(join(extDir, VALID2, '3.0.0', 'manifest.json'), JSON.stringify({ name: 'Second' }));
  // Non-id dir (ignored).
  mkdirSync(join(extDir, 'not-an-id', '1.0.0'), { recursive: true });
  writeFileSync(join(extDir, 'not-an-id', '1.0.0', 'manifest.json'), '{}');
  // Valid id but a version dir WITHOUT a manifest (skipped).
  const NOMAN = 'aaaabbbbccccddddaaaabbbbccccdddd';
  mkdirSync(join(extDir, NOMAN, '1.0.0'), { recursive: true });
});

afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('listUnpackedExtensions', () => {
  it('picks the highest version dir with a manifest, per id', () => {
    const list = listUnpackedExtensions(extDir);
    const byId = Object.fromEntries(list.map((e) => [e.id, e]));
    expect(byId[VALID].version).toBe('1.10.0'); // numeric compare, not lexicographic (1.10 > 1.2)
    expect(byId[VALID].name).toBe('My Extension');
    expect(byId[VALID].path).toBe(join(extDir, VALID, '1.10.0'));
    expect(byId[VALID2].name).toBe('Second');
  });

  it('ignores non-id dirs and ids with no manifest-bearing version', () => {
    const ids = listUnpackedExtensions(extDir).map((e) => e.id);
    expect(ids).toContain(VALID);
    expect(ids).toContain(VALID2);
    expect(ids).not.toContain('not-an-id');
    expect(ids).not.toContain('aaaabbbbccccddddaaaabbbbccccdddd'); // no manifest
    expect(ids).toHaveLength(2);
  });

  it('missing / unreadable dir → [] (never throws)', () => {
    expect(listUnpackedExtensions(join(root, 'does-not-exist'))).toEqual([]);
  });
});

describe('discoverInstalledExtensions + platform dirs', () => {
  it('dedupes by id across profiles (first wins)', () => {
    const list = discoverInstalledExtensions([extDir, extDir]);
    expect(list.filter((e) => e.id === VALID)).toHaveLength(1);
  });

  it('macOS candidate dirs include Chrome + Dia', () => {
    const dirs = chromiumExtensionDirs('darwin', '/Users/x');
    expect(dirs.some((d) => d.includes('Google/Chrome'))).toBe(true);
    expect(dirs.some((d) => d.includes('/Dia/'))).toBe(true);
  });
});
