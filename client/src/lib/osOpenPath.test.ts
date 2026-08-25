/**
 * @covers OSOPEN-01
 */
import { describe, it, expect } from 'bun:test';
import type { TabTarget } from '../../../shared/tab-link';
import { drainOsOpenPaths, OS_OPEN_MISS_MESSAGE, type OsOpenDeps } from './osOpenPath';

function deps(over: Partial<OsOpenDeps> & { queue?: string[] } = {}) {
  const opened: TabTarget[] = [];
  const notified: string[] = [];
  const resolved: string[] = [];
  const base: OsOpenDeps = {
    take: async () => over.queue ?? [],
    resolve: async (path) => {
      resolved.push(path);
      return { kind: 'project', key: path };
    },
    open: (t) => { opened.push(t); },
    notify: (m) => { notified.push(m); },
    ...over,
  };
  return { deps: base, opened, notified, resolved };
}

describe('drainOsOpenPaths', () => {
  it('apre quello che il server ha risolto', async () => {
    const d = deps({ queue: ['/w/app'] });
    expect(await drainOsOpenPaths(d.deps)).toBe(1);
    expect(d.opened).toEqual([{ kind: 'project', key: '/w/app' }]);
  });

  it('coda vuota: nessuna apertura, nessun avviso', async () => {
    const d = deps({ queue: [] });
    expect(await drainOsOpenPaths(d.deps)).toBe(0);
    expect(d.notified).toEqual([]);
  });

  it('fuori dal guscio la coda non esiste, e non è un errore', async () => {
    const d = deps({ take: async () => { throw new Error('not running under Tauri'); } });
    expect(await drainOsOpenPaths(d.deps)).toBe(0);
    expect(d.opened).toEqual([]);
  });

  it('un path che non risolve avvisa invece di restare muto', async () => {
    const d = deps({ queue: ['/w/sparito'], resolve: async () => null });
    expect(await drainOsOpenPaths(d.deps)).toBe(0);
    expect(d.notified).toEqual([OS_OPEN_MISS_MESSAGE]);
  });

  it('un path che fa fallire il server non ferma gli altri', async () => {
    const d = deps({
      queue: ['/w/rotto', '/w/buono'],
      resolve: async (p) => {
        if (p === '/w/rotto') throw new Error('offline');
        return { kind: 'project', key: p };
      },
    });
    expect(await drainOsOpenPaths(d.deps)).toBe(1);
    expect(d.opened).toEqual([{ kind: 'project', key: '/w/buono' }]);
  });

  it('un tetto alle aperture per giro: venti file non fanno venti tab', async () => {
    const d = deps({ queue: Array.from({ length: 20 }, (_, i) => `/w/f${i}`) });
    expect(await drainOsOpenPaths(d.deps)).toBe(8);
  });

  it('apre nell ordine in cui l OS li ha consegnati, uno alla volta', async () => {
    const d = deps({ queue: ['/w/a', '/w/b', '/w/c'] });
    await drainOsOpenPaths(d.deps);
    expect(d.resolved).toEqual(['/w/a', '/w/b', '/w/c']);
    expect(d.opened.map((t) => t.key)).toEqual(['/w/a', '/w/b', '/w/c']);
  });
});
