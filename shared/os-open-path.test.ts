import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEV_FILE_EXTENSIONS,
  normalizeOsOpenPath,
  parentDir,
  ancestorDirs,
  pathContains,
  projectRootForFile,
  osOpenTarget,
} from './os-open-path';

const ROOT = join(import.meta.dir, '..');

describe('normalizeOsOpenPath', () => {
  it('accetta un path assoluto e toglie la barra finale', () => {
    expect(normalizeOsOpenPath('/Users/x/progetto/')).toBe('/Users/x/progetto');
    expect(normalizeOsOpenPath('  /Users/x/a.md  ')).toBe('/Users/x/a.md');
  });

  it('scioglie il file:// percent-encoded del Finder', () => {
    expect(normalizeOsOpenPath('file:///Users/x/il%20mio%20progetto/a.md'))
      .toBe('/Users/x/il mio progetto/a.md');
  });

  it('tiene i path di Windows, radice compresa', () => {
    expect(normalizeOsOpenPath('C:\\Users\\x\\a.md')).toBe('C:\\Users\\x\\a.md');
    expect(normalizeOsOpenPath('C:/')).toBe('C:/');
    expect(normalizeOsOpenPath('file:///C:/Users/x/a.md')).toBe('C:/Users/x/a.md');
  });

  it('rifiuta relativo, vuoto e authority remota', () => {
    expect(normalizeOsOpenPath('src/a.md')).toBeNull();
    expect(normalizeOsOpenPath('')).toBeNull();
    expect(normalizeOsOpenPath('file://server/share/a.md')).toBeNull();
  });

  it('toglie le virgolette di chi lancia da una shell', () => {
    expect(normalizeOsOpenPath('"/Users/x/con spazio"')).toBe('/Users/x/con spazio');
  });
});

describe('antenati e contenimento', () => {
  it('risale fino alla radice, dal più vicino al più lontano', () => {
    expect(parentDir('/a/b/c.md')).toBe('/a/b');
    expect(parentDir('/a')).toBe('/');
    expect(parentDir('/')).toBeNull();
    expect(ancestorDirs('/a/b/c.md')).toEqual(['/a/b', '/a', '/']);
  });

  it('contiene solo a confine di segmento', () => {
    expect(pathContains('/a/b', '/a/b/c.md')).toBe(true);
    expect(pathContains('/a/b', '/a/b')).toBe(true);
    // `/a/bis` NON sta dentro `/a/b`: il prefisso di stringa mentirebbe.
    expect(pathContains('/a/b', '/a/bis/c.md')).toBe(false);
  });
});

describe('projectRootForFile', () => {
  const file = '/w/mono/packages/ui/src/a.ts';

  it('un progetto già aperto vince su tutto: niente doppioni in sidebar', () => {
    expect(projectRootForFile(file, {
      isDirectory: false,
      knownProjects: ['/w/mono'],
      vcsRoots: ['/w/mono'],
      manifestRoots: ['/w/mono/packages/ui', '/w/mono'],
    })).toBe('/w/mono');
  });

  it('senza progetti noti vince il repository, non il pacchetto', () => {
    expect(projectRootForFile(file, {
      isDirectory: false,
      vcsRoots: ['/w/mono'],
      manifestRoots: ['/w/mono/packages/ui', '/w/mono'],
    })).toBe('/w/mono');
  });

  it('senza repository vince il manifesto più vicino', () => {
    expect(projectRootForFile(file, {
      isDirectory: false,
      manifestRoots: ['/w/mono/packages/ui', '/w/mono'],
    })).toBe('/w/mono/packages/ui');
  });

  it('un file sciolto è un progetto di una cartella', () => {
    expect(projectRootForFile('/tmp/note.md', { isDirectory: false })).toBe('/tmp');
  });

  it('ignora i candidati che non contengono il file', () => {
    expect(projectRootForFile(file, { isDirectory: false, knownProjects: ['/w/altro'] }))
      .toBe('/w/mono/packages/ui/src');
  });
});

describe('osOpenTarget', () => {
  it('una cartella si apre come progetto', () => {
    expect(osOpenTarget('/w/mono/', { isDirectory: true }))
      .toEqual({ kind: 'project', key: '/w/mono' });
  });

  it('un file apre il progetto che lo contiene e mette a fuoco il file', () => {
    expect(osOpenTarget('file:///w/mono/src/a.ts', {
      isDirectory: false,
      vcsRoots: ['/w/mono'],
    })).toEqual({ kind: 'file', key: '/w/mono/src/a.ts', projectPath: '/w/mono' });
  });

  it('un path che non è un path non apre niente', () => {
    expect(osOpenTarget('src/a.ts', { isDirectory: false })).toBeNull();
    expect(osOpenTarget('', { isDirectory: true })).toBeNull();
  });
});

/**
 * Le tre copie della lista di estensioni. Il bundle le dichiara all'OS in due
 * posti diversi (tauri.conf.json per Windows e Linux, Info.plist per macOS,
 * che sovrascrive il generato) e la lista vive in TypeScript. Tre copie che
 * divergono in silenzio sono il modo in cui un'associazione sparisce da una
 * piattaforma sola e nessuno se ne accorge fino alla release.
 */
describe('le associazioni dichiarate al sistema operativo', () => {
  const confExts = (): string[] => {
    const conf = JSON.parse(readFileSync(join(ROOT, 'desktop-tauri/src-tauri/tauri.conf.json'), 'utf8'));
    const assoc = conf.bundle?.fileAssociations as Array<{ ext: string[] }> | undefined;
    expect(assoc).toBeTruthy();
    return (assoc ?? []).flatMap(a => a.ext);
  };

  const plist = (): string => readFileSync(join(ROOT, 'desktop-tauri/src-tauri/Info.plist'), 'utf8');

  const plistExts = (): string[] => {
    const out: string[] = [];
    const blocks = plist().matchAll(/<key>CFBundleTypeExtensions<\/key>\s*<array>([\s\S]*?)<\/array>/g);
    for (const b of blocks) {
      for (const m of (b[1] ?? '').matchAll(/<string>([^<]+)<\/string>/g)) out.push(m[1]!);
    }
    return out;
  };

  it('tauri.conf.json dichiara esattamente le estensioni della lista', () => {
    expect([...confExts()].sort()).toEqual([...DEV_FILE_EXTENSIONS].sort());
  });

  it('Info.plist dichiara esattamente le stesse estensioni', () => {
    expect([...plistExts()].sort()).toEqual([...DEV_FILE_EXTENSIONS].sort());
  });

  it('nessuna estensione dichiarata due volte', () => {
    expect(new Set(confExts()).size).toBe(confExts().length);
    expect(new Set(plistExts()).size).toBe(plistExts().length);
  });

  it('la cartella è dichiarata su macOS, e il ruolo del guscio è non rubare il default', () => {
    expect(plist()).toContain('public.folder');
    expect(plist()).not.toContain('<string>Owner</string>');
  });
});
