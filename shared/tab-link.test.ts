/**
 * @covers TABREF-01
 */
import { describe, expect, test } from 'bun:test';
import {
  buildTabLink,
  buildTabPath,
  decodeTabSegment,
  describeTabTarget,
  encodeTabSegment,
  parseTabPath,
  parseTabRef,
  type TabTarget,
} from './tab-link';

const UUID = '3f2a1b4c-5d6e-4f80-9a1b-2c3d4e5f6071';

// L'invariante che tiene in piedi tutto il resto: qualunque chiave, per storta
// che sia, deve tornare identica dall'altra parte del giro.
function roundTrip(target: TabTarget): TabTarget | null {
  const path = buildTabPath(target);
  if (!path) return null;
  const [pathname, search] = path.split('?');
  return parseTabPath(pathname!, search ? `?${search}` : '');
}

describe('encoding dei segmenti', () => {
  test('un token sicuro resta in chiaro (il link è leggibile a occhio)', () => {
    expect(encodeTabSegment(UUID)).toBe(UUID);
    expect(encodeTabSegment('board')).toBe('board');
    expect(encodeTabSegment('ctx-42_a')).toBe('ctx-42_a');
  });

  test('qualsiasi altra cosa diventa ~base64url: mai un punto, mai uno slash', () => {
    const paths = [
      '/Users/utente/Projects/my.app',
      '/Users/utente/Progetti/città',
      '~/Projects/topics-app',
      'C:\\Users\\x\\repo',
      'src/components/Layout/PaneTabBar.tsx',
      '/tmp/spazio nel nome/file 1.txt',
      '/emoji/🚀/x.ts',
    ];
    for (const p of paths) {
      const enc = encodeTabSegment(p);
      expect(enc.startsWith('~')).toBe(true);
      expect(enc).not.toContain('.'); // spa-fallback 404a i segmenti col punto
      expect(enc).not.toContain('/');
      expect(enc).not.toContain('=');  // il padding finirebbe nel path
      expect(decodeTabSegment(enc)).toBe(p);
    }
  });

  test('base64 corrotto → null, mai un throw', () => {
    expect(decodeTabSegment('~!!!not-base64!!!')).toBeNull();
    expect(decodeTabSegment('')).toBeNull();
  });
});

describe('round-trip build → parse', () => {
  test('chat / terminal / project / task', () => {
    expect(roundTrip({ kind: 'chat', key: UUID })).toEqual({ kind: 'chat', key: UUID });
    expect(roundTrip({ kind: 'terminal', key: 'sess-77' })).toEqual({ kind: 'terminal', key: 'sess-77' });
    expect(roundTrip({ kind: 'task', key: UUID })).toEqual({ kind: 'task', key: UUID });
    const proj = '/Users/utente/Projects/my.app';
    expect(roundTrip({ kind: 'project', key: proj })).toEqual({ kind: 'project', key: proj });
  });

  test('panel: solo i tipi che handleOpenAsPage sa davvero aprire', () => {
    expect(roundTrip({ kind: 'panel', key: 'board' })).toEqual({ kind: 'panel', key: 'board' });
    expect(roundTrip({ kind: 'panel', key: 'dashboard' })).toEqual({ kind: 'panel', key: 'dashboard' });
    // `journal` non è emettibile: meglio nessun link che un link che non apre niente.
    expect(buildTabPath({ kind: 'panel', key: 'journal' })).toBeNull();
    expect(parseTabPath('/tab/panel/journal')).toBeNull();
  });

  test('browser: il contextId da solo, e con gli hint di proprietà', () => {
    expect(roundTrip({ kind: 'browser', key: 'ctx-9' })).toEqual({ kind: 'browser', key: 'ctx-9' });
    const withProject: TabTarget = { kind: 'browser', key: 'ctx-9', projectPath: '/Users/x/my.app' };
    expect(roundTrip(withProject)).toEqual(withProject);
    const withTask: TabTarget = { kind: 'browser', key: 'task-ab12-1', taskId: UUID };
    expect(roundTrip(withTask)).toEqual(withTask);
  });

  test('file / diff portano SEMPRE il progetto ospite', () => {
    const t: TabTarget = { kind: 'file', key: 'src/a.ts', projectPath: '/Users/x/my.app' };
    expect(roundTrip(t)).toEqual(t);
    const d: TabTarget = { kind: 'diff', key: 'src/a.ts', projectPath: '/Users/x/repo' };
    expect(roundTrip(d)).toEqual(d);
    // Senza progetto non sarebbe risolvibile: niente link, invece di uno rotto.
    expect(buildTabPath({ kind: 'file', key: 'src/a.ts' })).toBeNull();
  });

  test('una chiave vuota non produce link', () => {
    expect(buildTabPath({ kind: 'chat', key: '' })).toBeNull();
  });
});

describe('parse: alias storici e non-link', () => {
  test('/task/<id> e /topic/<id> restano leggibili', () => {
    expect(parseTabPath(`/task/${UUID}`)).toEqual({ kind: 'task', key: UUID });
    expect(parseTabPath(`/task/${UUID}/`)).toEqual({ kind: 'task', key: UUID });
    expect(parseTabPath(`/topic/${UUID}`)).toEqual({ kind: 'chat', key: UUID });
  });

  test('tutto ciò che non è un permalink → null', () => {
    for (const p of ['/', '/api/topics', '/assets/index.js', '/tab', '/tab/', '/tab/chat', '/tab/chat/a/b', '/tab/nope/x', '/task/a/b']) {
      expect(parseTabPath(p)).toBeNull();
    }
  });
});

describe('parseTabRef: URL assoluta o path nudo', () => {
  test('accetta entrambe le forme (l\'agente riceve l\'una o l\'altra)', () => {
    expect(parseTabRef(`http://127.0.0.1:13333/tab/chat/${UUID}`)).toEqual({ kind: 'chat', key: UUID });
    expect(parseTabRef(`https://topics.example/tab/terminal/sess-1`)).toEqual({ kind: 'terminal', key: 'sess-1' });
    expect(parseTabRef(`/tab/chat/${UUID}`)).toEqual({ kind: 'chat', key: UUID });
    expect(parseTabRef(`  /tab/chat/${UUID}  `)).toEqual({ kind: 'chat', key: UUID });
  });

  test('la query sopravvive al giro attraverso una URL intera', () => {
    const link = buildTabLink({ kind: 'browser', key: 'ctx-9', projectPath: '/Users/x/my.app' }, 'http://127.0.0.1:13333')!;
    expect(parseTabRef(link)).toEqual({ kind: 'browser', key: 'ctx-9', projectPath: '/Users/x/my.app' });
  });

  test('spazzatura → null', () => {
    expect(parseTabRef('')).toBeNull();
    expect(parseTabRef('non un link')).toBeNull();
    expect(parseTabRef('https://example.com/altro')).toBeNull();
  });
});

describe('buildTabLink', () => {
  test('costruisce sull\'origine passata, senza portarsi dietro query o hash della base', () => {
    const link = buildTabLink({ kind: 'chat', key: UUID }, 'http://127.0.0.1:13333/task/xyz?a=1#h');
    expect(link).toBe(`http://127.0.0.1:13333/tab/chat/${UUID}`);
  });

  test('nessun punto nel path anche per un progetto con estensione nel nome', () => {
    const link = buildTabLink({ kind: 'project', key: '/Users/x/my.app' }, 'http://127.0.0.1:13333')!;
    const lastSegment = new URL(link).pathname.split('/').pop()!;
    expect(lastSegment).not.toContain('.');
  });

  test('target non costruibile → null (non una URL a metà)', () => {
    expect(buildTabLink({ kind: 'file', key: 'a.ts' }, 'http://x')).toBeNull();
  });
});

describe('describeTabTarget', () => {
  test('dice il tipo e la chiave', () => {
    expect(describeTabTarget({ kind: 'chat', key: UUID })).toContain(UUID);
    expect(describeTabTarget({ kind: 'file', key: 'a.ts', projectPath: '/p' })).toContain('/p');
  });
});
