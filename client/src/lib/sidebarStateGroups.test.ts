/**
 * Raggruppamento della sidebar per STATO (FASE 2, AC c).
 *
 * Perché esiste. La sidebar raggruppa per TIPO e ordina con un boost BINARIO
 * sulle notifiche: chi ha un numero addosso sale, e basta. Quel boost non
 * distingue le tre cose che l'utente distingue eccome — "aspetta una mia
 * risposta", "ha finito e non l'ho guardato", "sta lavorando" — e le mescola nello
 * stesso blocco. La partizione a tre esisteva già ma solo come CONTEGGI, per i
 * chip della status bar: le liste venivano buttate.
 *
 * Il test fissa le due cose che si possono sbagliare in silenzio: la chiave con
 * cui si guarda un item nei Set (il SOGGETTO, non la chiave di render) e la
 * conservazione dell'ordine dentro il bucket.
 *
 * @covers TOPIC-02
 */
import { describe, test, expect } from 'bun:test';
import {
  groupSidebarItemsByState,
  sidebarItemState,
  sidebarItemSubject,
  type SidebarItem,
  type SidebarStateSignals,
} from './buildSidebarItems';

const S = (...ids: string[]): ReadonlySet<string> => new Set(ids);

const noSignals: SidebarStateSignals = {
  awaitingTopics: S(),
  awaitingTermIds: S(),
  workingTopics: S(),
  workingTermIds: S(),
};

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

describe('sidebarItemState — in quale bucket sta un item', () => {
  test('senza segnali, tutto sta in rest', () => {
    expect(sidebarItemState(chat('t1'), noSignals)).toBe('rest');
    expect(sidebarItemState(terminal('s1'), noSignals)).toBe('rest');
    expect(sidebarItemState(project('/p'), noSignals)).toBe('rest');
  });

  test('una chat in attesa va in awaiting; una che lavora in working', () => {
    expect(sidebarItemState(chat('t1'), { ...noSignals, awaitingTopics: S('t1') })).toBe('awaiting');
    expect(sidebarItemState(chat('t1'), { ...noSignals, workingTopics: S('t1') })).toBe('working');
  });

  test('un terminale usa i Set dei TERMINALI, non quelli delle topic', () => {
    // Incrocio sbagliato: l'id del terminale messo nel set delle topic non deve
    // spostarlo di bucket.
    expect(sidebarItemState(terminal('s1'), { ...noSignals, awaitingTopics: S('s1') })).toBe('rest');
    expect(sidebarItemState(terminal('s1'), { ...noSignals, awaitingTermIds: S('s1') })).toBe('awaiting');
    expect(sidebarItemState(terminal('s1'), { ...noSignals, workingTermIds: S('s1') })).toBe('working');
  });

  test('"attende te" PRECEDE "al lavoro" quando i due si sovrappongono', () => {
    // I due assi sono dichiarati mutuamente esclusivi nel tempo, ma una
    // sovrapposizione momentanea non deve spostare la riga sotto gli occhi
    // dell'utente: chi aspetta una risposta resta in cima.
    const sig = { ...noSignals, awaitingTopics: S('t1'), workingTopics: S('t1') };
    expect(sidebarItemState(chat('t1'), sig)).toBe('awaiting');
  });

  test('un progetto resta in rest anche se un suo figlio attende', () => {
    // Il progetto è un contenitore: i figli entrano nei bucket per conto proprio.
    const sig = { ...noSignals, awaitingTopics: S('figlio') };
    expect(sidebarItemState(project('/p'), sig)).toBe('rest');
  });
});

describe('groupSidebarItemsByState', () => {
  test('partiziona nei tre bucket', () => {
    const items = [chat('a'), chat('b'), terminal('s1'), project('/p')];
    const g = groupSidebarItemsByState(items, {
      awaitingTopics: S('a'),
      awaitingTermIds: S(),
      workingTopics: S(),
      workingTermIds: S('s1'),
    });
    expect(g.awaiting.map(i => i.name)).toEqual(['a']);
    expect(g.working.map(i => i.name)).toEqual(['s1']);
    expect(g.rest.map(i => i.name)).toEqual(['b', '/p']);
  });

  test('CONSERVA l\'ordine relativo dentro ogni bucket', () => {
    // buildSidebarItems ha già ordinato per notifica e attività: riordinare qui
    // butterebbe via quel lavoro, e un utente che rilegge la stessa lista
    // troverebbe le righe rimescolate.
    const items = [chat('x'), chat('y'), chat('z')];
    const g = groupSidebarItemsByState(items, { ...noSignals, awaitingTopics: S('x', 'z') });
    expect(g.awaiting.map(i => i.name)).toEqual(['x', 'z']);
    expect(g.rest.map(i => i.name)).toEqual(['y']);
  });

  test('i tre bucket esistono sempre, anche vuoti', () => {
    const g = groupSidebarItemsByState([], noSignals);
    expect(g.awaiting).toEqual([]);
    expect(g.working).toEqual([]);
    expect(g.rest).toEqual([]);
  });

  test('i FIGLI di un progetto entrano nei bucket per conto proprio', () => {
    // La premessa scritta in `sidebarItemState` («i figli entrano nei bucket per
    // conto proprio») era falsa: questa funzione iterava solo gli item top-level,
    // e i figli di un progetto vivono in `item.children`. Effetto: «Attende te»
    // era cieca a tutto ciò che sta dentro un progetto — cioè quasi tutto.
    const figlioAttende = chat('f1', 'attende');
    const figlioLavora = terminal('s9', 'lavora');
    const figlioFermo = chat('f2', 'fermo');
    const g = groupSidebarItemsByState([project('/p', [figlioAttende, figlioLavora, figlioFermo])], {
      awaitingTopics: S('f1'),
      awaitingTermIds: S(),
      workingTopics: S(),
      workingTermIds: S('s9'),
    });
    expect(g.awaiting.map(i => i.name)).toEqual(['attende']);
    expect(g.working.map(i => i.name)).toEqual(['lavora']);
    // Il progetto resta, ma con appesi solo i figli non promossi.
    expect(g.rest.map(i => i.name)).toEqual(['/p']);
    expect(g.rest[0].children?.map(c => c.name)).toEqual(['fermo']);
  });

  test('un progetto i cui figli sono tutti fermi non viene ricostruito', () => {
    // Identità preservata quando non c'è niente da promuovere: un oggetto nuovo
    // a ogni rebuild farebbe ri-renderizzare la riga per nulla.
    const p = project('/p', [chat('f1')]);
    const g = groupSidebarItemsByState([p], noSignals);
    expect(g.rest[0]).toBe(p);
  });

  test('nessun item si perde né si duplica', () => {
    const items = [chat('a'), terminal('s1'), project('/p'), chat('b'), terminal('s2')];
    const g = groupSidebarItemsByState(items, {
      awaitingTopics: S('a'),
      awaitingTermIds: S('s2'),
      workingTopics: S('b'),
      workingTermIds: S('s1'),
    });
    const total = g.awaiting.length + g.working.length + g.rest.length;
    expect(total).toBe(items.length);
    const ids = [...g.awaiting, ...g.working, ...g.rest].map(i => i.id).sort();
    expect(ids).toEqual(items.map(i => i.id).sort());
  });
});
