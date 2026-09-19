/**
 * @covers EXTDISC-01
 * @covers BROWSER-SIDECAR-EXT-01
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { listUnpackedExtensions, discoverInstalledExtensions, chromiumExtensionDirs, pickSidecarExtensions, MAX_SIDECAR_EXTENSIONS, type InstalledExtension } from './browser-chromium-extensions';

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

describe('pickSidecarExtensions: the sidecar has to be able to START', () => {
  const fake = (n: number): InstalledExtension[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `id${i}`, name: `Ext ${i}`, path: `/ext/${i}`, version: '1',
    } as InstalledExtension));

  it('drops a measured-slow extension by ID, wherever it sits in the list', () => {
    // THE DEFECT A COUNT CANNOT CATCH. The third extension on this machine (a
    // password manager) costs 51.2 s on its own, against 2.9 s for the first
    // two together: a ceiling would keep it or drop it depending on discovery
    // order, which is arbitrary.
    const slowOne = { id: 'slow1', name: 'Pricey', path: '/ext/cara', version: '1' } as InstalledExtension;
    const { load, skipped } = pickSidecarExtensions(
      [...fake(1), slowOne],
      [{ id: 'slow1', what: 'password manager', measuredS: 51.2 }],
      10,
    );
    expect(load.map((e) => e.id)).not.toContain('slow1');
    expect(skipped[0]?.why).toContain('51.2');
  });

  it('and ALSO keeps a ceiling, because dropping the slow ones is not enough', () => {
    // Measured: with the slow one already out, 41 extensions still time out,
    // and so do 10 and 6. The two defences answer different questions.
    const { load, skipped } = pickSidecarExtensions(fake(41), []);
    expect(load).toHaveLength(MAX_SIDECAR_EXTENSIONS);
    expect(skipped).toHaveLength(41 - MAX_SIDECAR_EXTENSIONS);
  });

  it('the ceiling sits at the figure that REPEATED, not the best single run', () => {
    // Five worked once in 7.5 s and then timed out with the very same set:
    // the box moves under the bench. Two held for three runs in a row
    // (4.2 / 3.8 / 2.8 s at loadavg 15).
    expect(MAX_SIDECAR_EXTENSIONS).toBeLessThanOrEqual(2);
    expect(MAX_SIDECAR_EXTENSIONS).toBeGreaterThan(0);
  });

  it('every skipped one carries its WHY, it never vanishes silently', () => {
    // A silent truncation leaves the user wondering where their extensions
    // went: the same fault as the nightly that said "open the run".
    const { skipped } = pickSidecarExtensions(fake(6), []);
    expect(skipped.length).toBeGreaterThan(0);
    for (const s of skipped) expect(s.why.length).toBeGreaterThan(10);
  });

  it('under the ceiling and nothing slow: loads everything', () => {
    const { load, skipped } = pickSidecarExtensions(fake(2), []);
    expect(load).toHaveLength(2);
    expect(skipped).toHaveLength(0);
  });

  it('ceiling of zero: no extensions, and the sidecar still starts', () => {
    const { load, skipped } = pickSidecarExtensions(fake(5), [], 0);
    expect(load).toHaveLength(0);
    expect(skipped).toHaveLength(5);
  });

  it('the slow list matches by ID, never by name', () => {
    // Names here are localization keys: four extensions on this machine all
    // report `__MSG_extName__`. An id is stable.
    const a = { id: 'x1', name: '__MSG_extName__', path: '/a', version: '1' } as InstalledExtension;
    const b = { id: 'x2', name: '__MSG_extName__', path: '/b', version: '1' } as InstalledExtension;
    const { load } = pickSidecarExtensions([a, b], [{ id: 'x1', what: 'pricey', measuredS: 51 }], 10);
    expect(load.map((e) => e.id)).toEqual(['x2']);
  });
});
