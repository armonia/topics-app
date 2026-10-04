/**
 * Raggruppamento della sidebar per STATO (FASE 2, AC c; notifications-redesign
 * ATTN-12: the sections read the TIER of the attention state).
 *
 * Il test fissa le due cose che si possono sbagliare in silenzio: la chiave con
 * cui si guarda un item nello stato di attenzione (il SOGGETTO, non la chiave
 * di render) e la conservazione dell'ordine dentro la sezione.
 *
 * @covers TOPIC-02, CHROME-07, ATTN-12
 */
import { describe, test, expect } from 'bun:test';
import {
  groupSidebarItemsByState,
  sidebarItemState,
  sidebarItemSubject,
  type SidebarItem,
} from './buildSidebarItems';
import type { AttentionSnapshot, AttentionState } from '../../../shared/attention';
import type { AttentionRows } from '../state/attention';

function snap(subject: string, state: AttentionState, over: Partial<AttentionSnapshot> = {}): AttentionSnapshot {
  return {
    subject, state, reason: state === 'needs-you' ? 'question' : null, outcome: state === 'finished' ? 'done' : null, detail: null,
    since: '2026-10-03T10:00:00.000Z', epoch: 1, seenEpoch: 0, lit: state === 'needs-you' || state === 'finished', unread: 0,
    turnUnseen: false, lastTurnAt: null, background: [], ...over,
  };
}
/** `t:<id>` is a chat, `s:<id>` a terminal. */
function rows(entries: Record<string, AttentionState>): AttentionRows {
  return new Map(Object.entries(entries).map(([k, st]) => {
    const subject = k.startsWith('s:') ? `terminal:${k.slice(2)}` : `topic:${k.slice(2)}`;
    return [subject, snap(subject, st)];
  }));
}
const none: AttentionRows = new Map();

function chat(topicId: string, name = topicId): SidebarItem {
  return {
    id: topicId,
    type: 'chat',
    name,
    icon: '',
    lastActivity: 0,
    notificationCount: 0,
    archived: false,
    topic: { id: topicId, name } as SidebarItem['topic'],
  };
}

function terminal(sessionId: string, name = sessionId): SidebarItem {
  return {
    // La chiave di RENDER è `terminal:<id>`, il soggetto è `<id>`: è esattamente
    // la coppia che si può confondere.
    id: `terminal:${sessionId}`,
    type: 'terminal',
    name,
    icon: 'terminal',
    lastActivity: 0,
    notificationCount: 0,
    archived: false,
    terminal: { id: sessionId, name } as SidebarItem['terminal'],
  };
}

function project(path: string, children?: SidebarItem[]): SidebarItem {
  return {
    id: `project:${path}`, type: 'project', name: path, icon: '', lastActivity: 0,
    notificationCount: 0, archived: false, projectPath: path,
    ...(children ? { children } : {}),
  };
}

describe('sidebarItemSubject — la chiave con cui i segnali conoscono un item', () => {
  test('una chat è il suo topicId, non la chiave di render', () => {
    expect(sidebarItemSubject(chat('t1'))).toBe('t1');
  });

  test('un terminale è il sessionId NUDO, non `terminal:<id>`', () => {
    // Se qui tornasse `terminal:abc`, ogni bucket sarebbe vuoto per sempre e
    // nessun errore lo direbbe.
    expect(sidebarItemSubject(terminal('abc'))).toBe('abc');
  });

  test('progetti, browser e utility non hanno soggetto', () => {
    expect(sidebarItemSubject(project('/tmp/p'))).toBe(null);
  });
});

describe('sidebarItemState — in quale sezione sta un item', () => {
  test('senza stato, tutto sta in rest', () => {
    expect(sidebarItemState(chat('t1'), none)).toBe('rest');
    expect(sidebarItemState(terminal('s1'), none)).toBe('rest');
    expect(sidebarItemState(project('/p'), none)).toBe('rest');
  });

  test('il tier decide: needs-you, finished, working', () => {
    expect(sidebarItemState(chat('t1'), rows({ 't:t1': 'needs-you' }))).toBe('needs-you');
    expect(sidebarItemState(chat('t1'), rows({ 't:t1': 'finished' }))).toBe('finished');
    expect(sidebarItemState(chat('t1'), rows({ 't:t1': 'working' }))).toBe('working');
  });

  test('un finito già visto non sta fra le finite', () => {
    const seen: AttentionRows = new Map([['topic:t1', snap('topic:t1', 'finished', { lit: false, seenEpoch: 1 })]]);
    expect(sidebarItemState(chat('t1'), seen)).toBe('rest');
  });

  test('un terminale si legge sul soggetto TERMINALE, non su quello della chat con lo stesso id', () => {
    expect(sidebarItemState(terminal('s1'), rows({ 't:s1': 'needs-you' }))).toBe('rest');
    expect(sidebarItemState(terminal('s1'), rows({ 's:s1': 'needs-you' }))).toBe('needs-you');
    expect(sidebarItemState(terminal('s1'), rows({ 's:s1': 'working' }))).toBe('working');
  });

  test('un progetto resta in rest anche se un suo figlio attende', () => {
    expect(sidebarItemState(project('/p'), rows({ 't:figlio': 'needs-you' }))).toBe('rest');
  });
});

describe('groupSidebarItemsByState', () => {
  test('partiziona nelle sezioni', () => {
    const items = [chat('a'), chat('b'), terminal('s1'), project('/p')];
    const g = groupSidebarItemsByState(items, rows({ 't:a': 'needs-you', 's:s1': 'working' }));
    expect(g['needs-you'].map(i => i.name)).toEqual(['a']);
    expect(g.working.map(i => i.name)).toEqual(['s1']);
    expect(g.rest.map(i => i.name)).toEqual(['b', '/p']);
  });

  test('CONSERVA l\'ordine relativo dentro ogni sezione', () => {
    const items = [chat('x'), chat('y'), chat('z')];
    const g = groupSidebarItemsByState(items, rows({ 't:x': 'finished', 't:z': 'finished' }));
    expect(g.finished.map(i => i.name)).toEqual(['x', 'z']);
    expect(g.rest.map(i => i.name)).toEqual(['y']);
  });

  test('le sezioni esistono sempre, anche vuote', () => {
    const g = groupSidebarItemsByState([], none);
    expect(g).toEqual({ 'needs-you': [], finished: [], working: [], rest: [] });
  });

  test('i FIGLI di un progetto entrano nelle sezioni per conto proprio', () => {
    const figlioAttende = chat('f1', 'attende');
    const figlioLavora = terminal('s9', 'lavora');
    const stoppedChild = chat('f2', 'fermo');
    const g = groupSidebarItemsByState([project('/p', [figlioAttende, figlioLavora, stoppedChild])], rows({ 't:f1': 'needs-you', 's:s9': 'working' }));
    expect(g['needs-you'].map(i => i.name)).toEqual(['attende']);
    expect(g.working.map(i => i.name)).toEqual(['lavora']);
    expect(g.rest.map(i => i.name)).toEqual(['/p']);
    expect(g.rest[0].children?.map(c => c.name)).toEqual(['fermo']);
  });

  test('un progetto i cui figli sono tutti fermi non viene ricostruito', () => {
    const p = project('/p', [chat('f1')]);
    expect(groupSidebarItemsByState([p], none).rest[0]).toBe(p);
  });

  test('nessun item si perde né si duplica', () => {
    const items = [chat('a'), terminal('s1'), project('/p'), chat('b'), terminal('s2')];
    const g = groupSidebarItemsByState(items, rows({ 't:a': 'needs-you', 's:s2': 'finished', 't:b': 'working', 's:s1': 'working' }));
    const all = [...g['needs-you'], ...g.finished, ...g.working, ...g.rest];
    expect(all.length).toBe(items.length);
    expect(all.map(i => i.id).sort()).toEqual(items.map(i => i.id).sort());
  });

  test('a chat parked on a question sits in «Ti aspetta», not in «Al lavoro» (CHROME-07)', () => {
    const g = groupSidebarItemsByState([chat('ask'), chat('busy')], rows({ 't:ask': 'needs-you', 't:busy': 'working' }));
    expect(g['needs-you'].map(i => i.name)).toEqual(['ask']);
    expect(g.working.map(i => i.name)).toEqual(['busy']);
  });

  test('a chat waiting on its background work sits in «Al lavoro», never in «Ti aspetta» (BG-4)', () => {
    const waitsOnJob: AttentionRows = new Map([['topic:bg', snap('topic:bg', 'working', { background: [{ id: 'b', kind: 'bash', label: 'x', startedAt: '' }] })]]);
    expect(sidebarItemState(chat('bg'), waitsOnJob)).toBe('working');
  });
});
