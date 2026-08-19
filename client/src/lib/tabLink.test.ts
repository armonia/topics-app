import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import {
  buildTabLinkForTarget,
  selfTabLinkTarget,
  currentTabTarget,
  openTabInApp,
  openTabInAppWhenHydrated,
  consumeTabLinkFromUrl,
  deepLinkClickRoute,
  tabAckReleasesIntent,
  DEAD_TAB_MESSAGE,
  __resetTabLinkStateForTests,
  __setTabLinkRetryDelayForTests,
  UNVERIFIED_TAB_MESSAGE,
  type ProjectPanesReader,
} from './tabLink';
import {
  markServerHydrated,
  __resetServerHydratedForTests,
} from '../state/pane/middleware/serverHydrated';
import { buildTabPath, type TabTarget } from '../../../shared/tab-link';
import { usePaneStore } from '../state/pane/store';
import { useProjectFocusStore } from '../state/projectFocus';
import { projectPanesKey } from '../../../shared/project-keys';

// jsdom-less, come `openTaskLink.test.ts`: una vista minima e tipata della
// superficie globale che il modulo tocca, così gli stub non hanno bisogno di
// `any` (questo file è lintato sotto no-explicit-any).
type StubWindow = {
  location: { origin: string; href: string; pathname: string; search: string };
  dispatchEvent?: (e: { type: string; detail?: unknown }) => boolean;
  history?: { replaceState: (state: unknown, title: unknown, url: string) => void };
  localStorage?: undefined;
};
type StubFetch = (input: string, init?: unknown) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
const g = globalThis as unknown as { window: StubWindow; CustomEvent: unknown; fetch: StubFetch };

const origin = 'https://localhost:3333';

class StubCustomEvent {
  type: string;
  detail: unknown;
  constructor(type: string, opts?: { detail?: unknown }) {
    this.type = type;
    this.detail = opts?.detail;
  }
}

function stubWindow(href: string) {
  const events: Array<{ type: string; detail: unknown }> = [];
  const u0 = new URL(href);
  const sync = (url: string) => {
    const u = new URL(url);
    g.window.location.href = u.href;
    g.window.location.pathname = u.pathname;
    g.window.location.search = u.search;
    g.window.location.origin = u.origin;
  };
  g.window = {
    location: { origin: u0.origin, href: u0.href, pathname: u0.pathname, search: u0.search },
    dispatchEvent: (e) => { events.push({ type: e.type, detail: e.detail }); return true; },
    history: { replaceState: (_s, _t, url) => sync(url) },
    // Niente localStorage: il lettore dei layout di progetto degrada a vuoto,
    // che è esattamente il caso "nessun progetto ospita questa pane".
    localStorage: undefined,
  };
  g.CustomEvent = StubCustomEvent;
  return { events };
}

/**
 * Il resolver del server (`GET /api/tabs/resolve`) in memoria: `known` elenca i
 * SOGGETTI che esistono, tutto il resto risponde `state: 'unknown'` — cioè
 * «non l'ho trovato da nessuna parte», la risposta che deve fermare
 * l'apertura. Restituisce i ref chiesti, così si può verificare CHE COSA viene
 * verificato (per un file/diff è il PROGETTO, non il file).
 */
function stubResolver(known: TabTarget[] = []) {
  const refs = new Set(known.map((t) => buildTabPath(t)!));
  const asked: string[] = [];
  g.fetch = async (input: string) => {
    const url = new URL(String(input), 'http://stub.local');
    const ref = url.searchParams.get('ref') ?? '';
    asked.push(ref);
    return { ok: true, json: async () => ({ state: refs.has(ref) ? 'open' : 'unknown' }) };
  };
  return { asked };
}

/** Il server irraggiungibile: un errore di TRASPORTO, non una risposta. */
function stubResolverDown() {
  g.fetch = async () => { throw new Error('ECONNREFUSED'); };
}

/** Il server c'è ma risponde male (5xx, gate di pairing, corpo illeggibile):
 *  anche questo non è una risposta sul soggetto. */
function stubResolverBroken(status = 503) {
  const asked: string[] = [];
  g.fetch = async (input: string) => {
    asked.push(new URL(String(input), 'http://stub.local').searchParams.get('ref') ?? '');
    return { ok: status < 400, json: async () => { throw new Error(`HTTP ${status}`); } };
  };
  return { asked };
}

// `bun test` esegue tutti i file nello STESSO processo: uno stub su un globale
// che non viene ripristinato non resta in questo file. Il `fetch` finto qui
// sopra aveva già fatto cadere `server/browser-native-delegate.socket.test.ts`,
// che fa una fetch VERA — un rosso a chilometri di distanza dalla sua causa.
const realFetch = globalThis.fetch;
afterAll(() => { g.fetch = realFetch as unknown as StubFetch; });

/** Lascia sfilare le micro-task della verifica (e i timer a 0ms). */
const settle = () => new Promise((r) => setTimeout(r, 5));

/**
 * Attesa DETERMINISTICA: si aspetta il fatto atteso, non un cronometro.
 *
 * I casi qui sotto aspettavano 5 ms perche' la catena e' fatta di timer a 0 ms:
 * su una macchina scarica bastano, dentro `test:unit` intero (853 file, altri
 * processi vivi) no, e il caso cadeva a intermittenza misurando il carico
 * invece del codice. Qui il tempo e' solo il TETTO di pazienza.
 */
const settleUntil = async (ready: () => boolean, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!ready() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1));
  await new Promise((r) => setTimeout(r, 1));
};

/** Un lettore dei layout di progetto in memoria (nessun localStorage nei test). */
function panesReader(records: Record<string, unknown>): ProjectPanesReader {
  const raw = new Map(Object.entries(records).map(([k, v]) => [k, JSON.stringify(v)]));
  return { keys: () => [...raw.keys()], getItem: (k) => raw.get(k) ?? null };
}

function collectNotes() {
  const notes: string[] = [];
  return { notes, notify: (m: string) => notes.push(m) };
}

function resetPaneStore() {
  usePaneStore.setState((s) => {
    s.panes = {};
    s.groups = {};
    s.focusedPaneId = null;
  });
  useProjectFocusStore.setState({ activePaneByProject: {} });
}

beforeEach(() => {
  stubWindow(`${origin}/`);
  resetPaneStore();
  // La cache dei soggetti verificati è di modulo: senza reset un «esiste» di un
  // test diventerebbe il permesso a materializzare nel test dopo.
  __resetTabLinkStateForTests();
  // Il ritentativo esiste per coprire i ~2s del ricarico del server: nei test
  // aspettarli davvero significherebbe una suite che dorme.
  __setTabLinkRetryDelayForTests(1);
  // Idem per il flag di idratazione: è di modulo, e un test che marca idratato
  // renderebbe immediato il gate di quello dopo.
  __resetServerHydratedForTests();
  stubResolver();
});

// ── Costruzione ──────────────────────────────────────────────────────────────

describe('buildTabLinkForTarget', () => {
  test('senza base esplicita usa l’origine della pagina (serverHttpBase è vuoto fuori da Tauri)', () => {
    expect(buildTabLinkForTarget({ kind: 'chat', key: 'topic-1' }))
      .toBe(`${origin}/tab/chat/topic-1`);
  });

  test('con una base esplicita il link nasce sull’ORIGINE DEL SERVER, non su quella della pagina', () => {
    // È il caso Tauri: la UI vive su `tauri://localhost`, un’origine che non si
    // può aprire né incollare a nessuno — il link deve puntare al data server.
    stubWindow('tauri://localhost/');
    const link = buildTabLinkForTarget({ kind: 'panel', key: 'board' }, 'http://127.0.0.1:13333');
    expect(link).toBe('http://127.0.0.1:13333/tab/panel/board');
  });

  test('un path di progetto non finisce mai nudo nella URL (niente punti, niente slash)', () => {
    const link = buildTabLinkForTarget({ kind: 'project', key: '/Users/x/my.app' })!;
    const seg = new URL(link).pathname.slice('/tab/project/'.length);
    expect(seg.startsWith('~')).toBe(true);
    expect(seg.includes('.')).toBe(false);
    expect(seg.includes('/')).toBe(false);
  });

  test('un target incoerente non produce un link: è il gate della voce di menu', () => {
    expect(buildTabLinkForTarget({ kind: 'file', key: '/a/b.ts' })).toBeNull(); // manca projectPath
    expect(buildTabLinkForTarget({ kind: 'panel', key: 'agents' })).toBeNull();
    expect(buildTabLinkForTarget({ kind: 'chat', key: '' })).toBeNull();
  });
});

// ── Lettura ──────────────────────────────────────────────────────────────────

describe('selfTabLinkTarget', () => {
  test('stessa origine, assoluta o relativa → target', () => {
    expect(selfTabLinkTarget(`${origin}/tab/terminal/sess-7`)).toEqual({ kind: 'terminal', key: 'sess-7' });
    expect(selfTabLinkTarget('/tab/panel/dashboard')).toEqual({ kind: 'panel', key: 'dashboard' });
  });

  test('origine estranea → null (chi chiama apre nel browser esterno)', () => {
    expect(selfTabLinkTarget('https://evil.example/tab/chat/t1')).toBeNull();
  });

  test('self ma non un permalink, o spazzatura → null', () => {
    expect(selfTabLinkTarget(`${origin}/docs`)).toBeNull();
    expect(selfTabLinkTarget('not a url ::://')).toBeNull();
  });

  test('legge anche gli alias storici: è un SOVRAINSIEME di selfTaskLinkTarget', () => {
    expect(selfTabLinkTarget(`${origin}/task/t1`)).toEqual({ kind: 'task', key: 't1' });
    expect(selfTabLinkTarget(`${origin}/topic/tp1`)).toEqual({ kind: 'chat', key: 'tp1' });
  });

  test('round-trip build → parse su un file (chiavi codificate)', () => {
    const target = { kind: 'file' as const, key: 'src/a.ts', projectPath: '/Users/x/my.app' };
    const link = buildTabLinkForTarget(target)!;
    expect(selfTabLinkTarget(link)).toEqual(target);
  });
});

describe('currentTabTarget', () => {
  test('legge il target dalla location corrente, query inclusa', () => {
    stubWindow(`${origin}/tab/browser/ctx-9?task=task-3`);
    expect(currentTabTarget()).toEqual({ kind: 'browser', key: 'ctx-9', taskId: 'task-3' });
  });
  test('null quando la location non è un permalink', () => {
    stubWindow(`${origin}/?keep=1`);
    expect(currentTabTarget()).toBeNull();
  });
});

// ── Instradamento ────────────────────────────────────────────────────────────

describe('openTabInApp — un ramo per tipo, tutti su eventi che l’app già gestisce', () => {
  test('chat: porta il TOPIC (mai l’id della pane) e chiede un’apertura permanente', async () => {
    const { events } = stubWindow(`${origin}/`);
    stubResolver([{ kind: 'chat', key: 'topic-1' }]);
    openTabInApp({ kind: 'chat', key: 'topic-1' });
    await settle();
    expect(events).toEqual([
      // ARMA l'intento di focus di boot: il topicId NUDO è l'id della pane a
      // livello App (vedi il blocco «intento di focus» più sotto).
      { type: 'topics:open-tab', detail: { paneId: 'topic-1' } },
      { type: 'topics:open-topic', detail: { topicId: 'topic-1', mode: 'permanent' } },
    ]);
  });

  test('terminal: passa dalla porta che guarda ENTRAMBE le superfici', async () => {
    const { events } = stubWindow(`${origin}/`);
    stubResolver([{ kind: 'terminal', key: 'sess-7' }]);
    openTabInApp({ kind: 'terminal', key: 'sess-7' });
    await settle();
    expect(events).toEqual([
      { type: 'topics:open-tab', detail: { paneId: 'terminal:sess-7' } },
      { type: 'topics:open-terminal-pane', detail: { sessionId: 'sess-7', name: '' } },
    ]);
  });

  test('project: apre/focussa la finestra di progetto', async () => {
    const { events } = stubWindow(`${origin}/`);
    stubResolver([{ kind: 'project', key: '/work/x' }]);
    openTabInApp({ kind: 'project', key: '/work/x' });
    await settle();
    expect(events).toEqual([
      { type: 'topics:open-tab', detail: { paneId: `project:${encodeURIComponent('/work/x')}` } },
      { type: 'topics:open-project', detail: { projectPath: '/work/x' } },
    ]);
  });

  test('panel: solo i tipi indirizzabili; un panel morto avvisa e NON emette niente', () => {
    const { events } = stubWindow(`${origin}/`);
    openTabInApp({ kind: 'panel', key: 'cron' });
    expect(events).toEqual([
      { type: 'topics:open-tab', detail: { paneId: '__cron__' } },
      { type: 'topics:open-utility', detail: { type: 'cron' } },
    ]);

    const { events: e2 } = stubWindow(`${origin}/`);
    const { notes, notify } = collectNotes();
    openTabInApp({ kind: 'panel', key: 'agents' }, { notify });
    // Nessun evento CREATIVO — e l'ack del vicolo cieco, che è l'unica cosa che
    // spegne la ri-asserzione di boot (prima qui non partiva, perché il wrapper
    // che lo emette era montato solo quando c'era un intento da rilasciare).
    expect(e2).toEqual([
      { type: 'topics:tab-opened', detail: { paneId: null, dead: true } },
    ]);
    expect(notes).toEqual([DEAD_TAB_MESSAGE]);
  });

  test('task: delega al drawer della board, che è già l’unico proprietario della rotta', () => {
    const { events } = stubWindow(`${origin}/`);
    openTabInApp({ kind: 'task', key: 't1' });
    expect(events.map((e) => e.type)).toEqual(['topics:open-tab', 'topics:open-utility', 'topics:open-task']);
    expect(events[0]!.detail).toEqual({ paneId: '__board__' });
    expect(events[2]!.detail).toEqual({ taskId: 't1' });
  });

  test('chiave vuota o tipo ignoto: avvisa e non materializza niente', () => {
    const { events } = stubWindow(`${origin}/`);
    const { notes, notify } = collectNotes();
    openTabInApp({ kind: 'chat', key: '' }, { notify });
    openTabInApp({ kind: 'bogus' as 'chat', key: 'x' }, { notify });
    // Solo i due ack di vicolo cieco: nessun evento che apra qualcosa.
    expect(events.map((e) => e.type)).toEqual(['topics:tab-opened', 'topics:tab-opened']);
    expect(notes).toEqual([DEAD_TAB_MESSAGE, DEAD_TAB_MESSAGE]);
  });
});

describe('openTabInApp — browser: la pane esiste già, va solo trovata', () => {
  test('a livello App il focus lo dà il pane-store (lì nessuno ascolta request-focus)', () => {
    const { events } = stubWindow(`${origin}/`);
    usePaneStore.setState((s) => {
      s.panes = { 'browser:ctx-1': { id: 'browser:ctx-1', type: 'browser' } };
      s.groups = { 'group:default': { id: 'group:default', paneIds: ['browser:ctx-1'], splitRatio: 0.5, splitAxis: 'horizontal' } };
    });
    const { notes, notify } = collectNotes();
    openTabInApp({ kind: 'browser', key: 'ctx-1' }, { notify });
    // L'evento parte SEMPRE per primo (una finestra di progetto potrebbe
    // possederla senza che lo snapshot su localStorage lo sappia ancora) —
    // preceduto solo dall'arma dell'intento di focus. In coda l'ack: la pane era
    // GIÀ nello store, quindi l'apertura è conclusa nello stesso battito.
    expect(events).toEqual([
      { type: 'topics:open-tab', detail: { paneId: 'browser:ctx-1' } },
      { type: 'browser:request-focus', detail: { contextId: 'ctx-1' } },
      { type: 'topics:tab-opened', detail: { paneId: 'browser:ctx-1', dead: false } },
    ]);
    expect(usePaneStore.getState().focusedPaneId).toBe('browser:ctx-1');
    expect(notes).toEqual([]);
  });

  test('hint `?in=<progetto>` che la ospita davvero: apre quella finestra e ripete il focus', async () => {
    const { events } = stubWindow(`${origin}/`);
    const reader = panesReader({
      [projectPanesKey('/work/x')]: { nonChatPanes: [{ id: 'browser:ctx-2' }] },
    });
    useProjectFocusStore.setState({ activePaneByProject: { '/work/x': null } }); // finestra montata
    const { notes, notify } = collectNotes();
    openTabInApp(
      { kind: 'browser', key: 'ctx-2', projectPath: '/work/x' },
      { notify, projectPanes: reader, retry: { attempts: 4, intervalMs: 0 } },
    );
    await settleUntil(() => events.length >= 5);
    expect(events.map((e) => e.type)).toEqual([
      'topics:open-tab',         // arma l'intento di focus
      'browser:request-focus',   // il tentativo immediato
      'topics:open-project',     // 1° hop
      'browser:request-focus',   // giro 1 del retry
      'browser:request-focus',   // giro 2: finestra confermata montata → stop
    ]);
    expect(notes).toEqual([]);
  });

  test('nessuna superficie la possiede, ma è di un TASK: apri il task, che è dove vive', () => {
    const { events } = stubWindow(`${origin}/`);
    const { notes, notify } = collectNotes();
    openTabInApp({ kind: 'browser', key: 'ctx-3', taskId: 'task-9' }, { notify, projectPanes: panesReader({}) });
    expect(events.map((e) => e.type)).toEqual([
      'topics:open-tab', 'browser:request-focus', 'topics:open-utility', 'topics:open-task',
    ]);
    expect(notes).toEqual([]);
  });

  test('nessuna superficie, nessun hint: avvisa (e non conia nessuna pane)', () => {
    const { events } = stubWindow(`${origin}/`);
    const { notes, notify } = collectNotes();
    openTabInApp({ kind: 'browser', key: 'ctx-4' }, { notify, projectPanes: panesReader({}) });
    // …e il vicolo cieco RILASCIA l'intento di focus appena armato: senza
    // niente da aprire non c'è niente da tenere a fuoco.
    expect(events.map((e) => e.type)).toEqual([
      'topics:open-tab', 'browser:request-focus', 'topics:tab-opened',
    ]);
    expect(notes).toEqual([DEAD_TAB_MESSAGE]);
    expect(usePaneStore.getState().panes['browser:ctx-4']).toBeUndefined();
  });

  test('un layout persistito la contiene ma non sappiamo nominarlo: nessun falso allarme', () => {
    const { events } = stubWindow(`${origin}/`);
    const reader = panesReader({
      [projectPanesKey('/work/ignoto')]: { nonChatPanes: [{ id: 'browser:ctx-5' }] },
    });
    const { notes, notify } = collectNotes();
    openTabInApp({ kind: 'browser', key: 'ctx-5' }, { notify, projectPanes: reader });
    expect(events.map((e) => e.type)).toEqual(['topics:open-tab', 'browser:request-focus']);
    expect(notes).toEqual([]);
  });
});

describe('openTabInApp — file/diff: due hop, e il secondo aspetta la finestra', () => {
  test('file: prima il progetto, poi `open-file` MIRATO a quella finestra', async () => {
    const { events } = stubWindow(`${origin}/`);
    stubResolver([{ kind: 'project', key: '/work/x' }]);
    useProjectFocusStore.setState({ activePaneByProject: { '/work/x': null } });
    openTabInApp(
      { kind: 'file', key: '/work/x/src/a.ts', projectPath: '/work/x' },
      { retry: { attempts: 4, intervalMs: 0 } },
    );
    await settleUntil(() => events.length >= 4);
    expect(events.map((e) => e.type)).toEqual([
      // L'intento di focus di un file è la FINESTRA DI PROGETTO che lo ospita:
      // la pane del file ha un id sorteggiato a ogni apertura.
      'topics:open-tab', 'topics:open-project', 'open-file', 'open-file',
    ]);
    expect(events[0]!.detail).toEqual({ paneId: `project:${encodeURIComponent('/work/x')}` });
    // `topicId` NON è un topic: è il pane id della finestra che deve aprirlo.
    expect(events[2]!.detail).toEqual({
      path: '/work/x/src/a.ts',
      topicId: `project:${encodeURIComponent('/work/x')}`,
    });
  });

  test('diff: `handleOpenDiff` vuole il path RELATIVO, il permalink porta il pieno', async () => {
    const { events } = stubWindow(`${origin}/`);
    stubResolver([{ kind: 'project', key: '/work/x' }]);
    useProjectFocusStore.setState({ activePaneByProject: { '/work/x': null } });
    openTabInApp(
      { kind: 'diff', key: '/work/x/src/a.ts', projectPath: '/work/x' },
      { retry: { attempts: 4, intervalMs: 0 } },
    );
    await settleUntil(() => events.length >= 3);
    expect(events[0]!.type).toBe('topics:open-tab');
    expect(events[1]!.type).toBe('topics:open-project');
    expect(events[2]).toEqual({ type: 'open-file-diff', detail: { filePath: 'src/a.ts', projectPath: '/work/x' } });
  });

  test('la finestra non si monta mai: il retry si esaurisce e AVVISA', async () => {
    const { events } = stubWindow(`${origin}/`);
    // Il progetto ESISTE (altrimenti il ramo si fermerebbe prima): quello che
    // non si monta è la sua finestra.
    stubResolver([{ kind: 'project', key: '/work/mai-aperto' }]);
    const { notes, notify } = collectNotes();
    openTabInApp(
      { kind: 'file', key: 'src/a.ts', projectPath: '/work/mai-aperto' },
      { notify, retry: { attempts: 2, intervalMs: 0 }, settleMs: 5000 },
    );
    await settleUntil(
      () =>
        events.filter((e) => e.type === 'open-file').length >= 2 &&
        events.some((e) => e.type === 'topics:tab-opened'),
    );
    expect(events.filter((e) => e.type === 'open-file').length).toBe(2);
    // Il retry esaurito è un vicolo cieco come gli altri: rilascia l'intento…
    const acks = events.filter((e) => e.type === 'topics:tab-opened');
    expect(acks.length).toBe(1);
    // …e ANNULLA l'ack di successo armato quando aveva instradato: un'apertura
    // fallita non deve promettere di essere andata a buon fine.
    expect(acks[0]!.detail).toEqual({
      paneId: `project:${encodeURIComponent('/work/mai-aperto')}`,
      dead: true,
    });
    expect(notes).toEqual([DEAD_TAB_MESSAGE]);
  });

  // Il ripiego di ChatMarkdown («se non si apre in casa, aprilo fuori») è
  // appeso a `notify`, ma qui `notify` arriva a cose GIÀ APERTE: la finestra di
  // progetto è partita al primo hop, si è arreso solo il secondo. Ripiegare lì
  // significherebbe lasciare all'utente la finestra di progetto in-app PIÙ una
  // seconda copia completa di Topics nel browser di sistema, collegata allo
  // stesso WS e allo stesso pane-store. `onRouted` è il segnale che disarma il
  // ripiego: scatta appena qualcosa è stato instradato davvero.
  test('il retry esaurito NON è «non ho aperto niente»: onRouted è già scattato', async () => {
    stubWindow(`${origin}/`);
    stubResolver([{ kind: 'project', key: '/work/mai-aperto' }]);
    const seen: string[] = [];
    openTabInApp(
      { kind: 'file', key: 'src/a.ts', projectPath: '/work/mai-aperto' },
      {
        onRouted: () => seen.push('routed'),
        notify: () => seen.push('notify'),
        retry: { attempts: 2, intervalMs: 0 },
        settleMs: 5000,
      },
    );
    await settleUntil(() => seen.length >= 2);
    // L'ordine è il punto: `routed` PRIMA di `notify`, così chi ripiega sa già
    // che qualcosa in casa si è aperto e sta fermo.
    expect(seen).toEqual(['routed', 'notify']);
  });

  test('senza projectPath un file non è indirizzabile', () => {
    const { events } = stubWindow(`${origin}/`);
    const { notes, notify } = collectNotes();
    openTabInApp({ kind: 'file', key: 'src/a.ts' }, { notify });
    // Nemmeno la GET di verifica: senza progetto non c'è nulla da chiedere.
    // L'unico evento è l'ack del vicolo cieco (M1: prima non partiva).
    expect(events).toEqual([
      { type: 'topics:tab-opened', detail: { paneId: null, dead: true } },
    ]);
    expect(notes).toEqual([DEAD_TAB_MESSAGE]);
  });
});

// ── L'intento di focus del boot ──────────────────────────────────────────────

describe('openTabInApp — l’intento di focus (`topics:open-tab`)', () => {
  // Perché conta: a freddo la tab si apre e poi il primo hydrate del pane-store
  // restituisce il focus alla pane che ce l'aveva PRIMA del reload. L'intento è
  // ciò che usePanelLifecycle usa per tenere il punto finché il boot si calma,
  // quindi il pane id qui dentro deve essere ESATTAMENTE quello con cui la pane
  // compare nell'ordine dello store — un id "quasi giusto" è inerte, e il bug
  // torna senza fare rumore.
  const enc = encodeURIComponent('/work/x');
  const cases: Array<[string, Parameters<typeof openTabInApp>[0], string]> = [
    ['chat → il topicId NUDO (a livello App la pane si chiama così)', { kind: 'chat', key: 'topic-1' }, 'topic-1'],
    ['terminal', { kind: 'terminal', key: 'sess-7' }, 'terminal:sess-7'],
    ['browser', { kind: 'browser', key: 'ctx-1' }, 'browser:ctx-1'],
    ['project', { kind: 'project', key: '/work/x' }, `project:${enc}`],
    ['panel', { kind: 'panel', key: 'dashboard' }, '__dashboard__'],
    ['task → la board, che è dove vive il drawer', { kind: 'task', key: 't1' }, '__board__'],
    ['file → la FINESTRA di progetto che lo ospita', { kind: 'file', key: 'a.ts', projectPath: '/work/x' }, `project:${enc}`],
    ['diff → idem', { kind: 'diff', key: 'a.ts', projectPath: '/work/x' }, `project:${enc}`],
  ];
  for (const [name, target, paneId] of cases) {
    test(`${name}`, () => {
      const { events } = stubWindow(`${origin}/`);
      openTabInApp(target, { projectPanes: panesReader({}), retry: { attempts: 1, intervalMs: 0 } });
      expect(events[0]).toEqual({ type: 'topics:open-tab', detail: { paneId } });
    });
  }

  test('un target senza pane id deterministico non arma NIENTE', () => {
    const { events } = stubWindow(`${origin}/`);
    const { notify } = collectNotes();
    openTabInApp({ kind: 'panel', key: 'agents' }, { notify });          // non indirizzabile
    openTabInApp({ kind: 'file', key: 'a.ts' }, { notify });              // senza progetto
    openTabInApp({ kind: 'chat', key: '' }, { notify });                  // senza chiave
    expect(events.filter((e) => e.type === 'topics:open-tab')).toEqual([]);
    // …ma l'ack parte comunque, tre volte: chi aspetta (App.tsx) deve poter
    // smettere anche quando non c'era nessun intento da rilasciare.
    expect(events.map((e) => e.type)).toEqual([
      'topics:tab-opened', 'topics:tab-opened', 'topics:tab-opened',
    ]);
  });
});

// ── Consumo al boot ──────────────────────────────────────────────────────────

describe('consumeTabLinkFromUrl', () => {
  test('apre il target e poi RIPULISCE la rotta /tab/ (replaceState, non push)', async () => {
    const { events } = stubWindow(`${origin}/tab/panel/dashboard`);
    consumeTabLinkFromUrl();
    // La URL si pulisce SUBITO: è indipendente dall'apertura, e lasciarla lì
    // anche solo per un secondo significa che un reload la riaprirebbe.
    expect(g.window.location.pathname).toBe('/');
    expect(g.window.location.search).toBe('');
    // L'apertura invece aspetta l'idratazione (vedi il blocco dedicato).
    markServerHydrated();
    await settle();
    expect(events).toEqual([
      { type: 'topics:open-tab', detail: { paneId: '__dashboard__' } },
      { type: 'topics:open-utility', detail: { type: 'dashboard' } },
    ]);
  });

  test('una rotta /tab/ illeggibile viene comunque consumata: non deve ripresentarsi', () => {
    const { events } = stubWindow(`${origin}/tab/panel/agents`);
    const { notes, notify } = collectNotes();
    // `parseTabPath` non riconosce `agents` (la pane non esiste più): qui non passiamo nemmeno da
    // `openTabInApp`, quindi l'unico effetto è l'avviso + la pulizia della URL.
    consumeTabLinkFromUrl({ notify });
    expect(events).toEqual([]);
    expect(notes).toEqual([DEAD_TAB_MESSAGE]);
    expect(g.window.location.pathname).toBe('/');
  });

  test('NON tocca gli alias `/task/<id>` e `/topic/<id>`: quelli li possiede openTaskFromUrl', () => {
    const { events } = stubWindow(`${origin}/task/t1`);
    consumeTabLinkFromUrl();
    expect(events).toEqual([]);
    expect(g.window.location.pathname).toBe('/task/t1');
  });

  test('senza permalink è un no-op', () => {
    const { events } = stubWindow(`${origin}/?keep=1`);
    consumeTabLinkFromUrl();
    expect(events).toEqual([]);
    expect(g.window.location.pathname).toBe('/');
    expect(g.window.location.search).toBe('?keep=1');
  });

  test('restituisce l’annullatore SOLO se ha armato qualcosa (il secondo mount di StrictMode)', async () => {
    // Chi chiama distingue i due casi: `null` vuol dire «il colpo garantito
    // devi darlo tu». In dev StrictMode il primo mount consuma la URL e il suo
    // cleanup annulla l'apertura; al secondo mount la URL è già `/`, e se qui
    // tornasse un annullatore inerte App.tsx lo scambierebbe per un colpo già
    // armato — il permalink non si aprirebbe mai.
    stubWindow(`${origin}/tab/panel/dashboard`);
    expect(typeof consumeTabLinkFromUrl()).toBe('function');   // 1° mount: armato
    expect(g.window.location.pathname).toBe('/');
    expect(consumeTabLinkFromUrl()).toBeNull();                // 2° mount: niente da fare

    // Stessa risposta per gli altri «non ho armato niente».
    stubWindow(`${origin}/tab/panel/agents`);
    expect(consumeTabLinkFromUrl()).toBeNull();                // target illeggibile
    stubWindow(`${origin}/tab/panel/board?topics=t1`);
    expect(consumeTabLinkFromUrl()).toBeNull();                // finestra staccata
  });

  test('in una finestra STACCATA non tocca la URL: `?topics=` è la sua IDENTITÀ', async () => {
    // Ripulire la query trasformerebbe la pop-out in una main al primo reload
    // — riaprirebbe l'intero workspace invece delle sue chat. App.tsx si
    // protegge già con `if (isDetached) return`, ma l'invariante è di QUESTO
    // modulo: il prossimo chiamante non deve doverla riscoprire.
    const { events } = stubWindow(`${origin}/tab/panel/board?topics=t1,t2`);
    const { notes, notify } = collectNotes();
    consumeTabLinkFromUrl({ notify });
    markServerHydrated();
    await settle();
    expect(g.window.location.pathname).toBe('/tab/panel/board');
    expect(g.window.location.search).toBe('?topics=t1,t2');
    expect(events).toEqual([]);
    expect(notes).toEqual([]);
  });
});

// ── L'attesa dell'IDRATAZIONE (TABLINK-06) ───────────────────────────────────
//
// Il difetto: un permalink verso una chat GIÀ APERTA la faceva SPARIRE dalla
// barra. L'`OPEN_PANE` partiva PRIMA della prima idratazione del pane-store, e
// l'`HYDRATE_FROM_SNAPSHOT` che arrivava subito dopo se la mangiava — la pane
// restava nello store persistito, ma non nell'ordine visibile del client.
// La correzione è strutturale: un link dice «portami su questa tab», e per
// sapere se la tab c'è già bisogna aver ricevuto lo stato.

describe('openTabInAppWhenHydrated — prima lo stato, poi il link', () => {
  test('non instrada NIENTE finché l’idratazione non è arrivata', async () => {
    const { events } = stubWindow(`${origin}/`);
    openTabInAppWhenHydrated({ kind: 'panel', key: 'board' }, { hydrateTimeoutMs: 10_000 });
    await settle();
    expect(events).toEqual([]);

    markServerHydrated();
    await settle();
    expect(events.map((e) => e.type)).toEqual(['topics:open-tab', 'topics:open-utility']);
  });

  test('idratazione già avvenuta: si apre subito, senza aspettare il fallback', async () => {
    markServerHydrated();
    const { events } = stubWindow(`${origin}/`);
    openTabInAppWhenHydrated({ kind: 'panel', key: 'cron' }, { hydrateTimeoutMs: 10_000 });
    await settle();
    expect(events.map((e) => e.type)).toEqual(['topics:open-tab', 'topics:open-utility']);
  });

  test('se l’idratazione non arriva MAI, il fallback a tempo apre lo stesso', async () => {
    // Offline, primo avvio, server irraggiungibile: un link appeso per sempre
    // sarebbe l'esito peggiore. Si apre, e si accetta la corsa che c'era prima.
    const { events } = stubWindow(`${origin}/`);
    openTabInAppWhenHydrated({ kind: 'panel', key: 'dashboard' }, { hydrateTimeoutMs: 0 });
    await settle();
    expect(events.map((e) => e.type)).toEqual(['topics:open-tab', 'topics:open-utility']);
  });

  test('una sola apertura: il fallback non spara DOPO l’idratazione', async () => {
    const { events } = stubWindow(`${origin}/`);
    openTabInAppWhenHydrated({ kind: 'panel', key: 'board' }, { hydrateTimeoutMs: 1 });
    markServerHydrated();
    await new Promise((r) => setTimeout(r, 20));
    expect(events.filter((e) => e.type === 'topics:open-utility').length).toBe(1);
  });

  test('annullato: non apre nemmeno quando l’idratazione arriva', async () => {
    const { events } = stubWindow(`${origin}/`);
    const cancel = openTabInAppWhenHydrated({ kind: 'panel', key: 'board' }, { hydrateTimeoutMs: 0 });
    cancel();
    markServerHydrated();
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual([]);
  });
});

// ── La PANE FANTASMA: nessun ramo materializza un soggetto non confermato ────
//
// Il difetto che questi test fissano: `topics:open-topic` e `topics:open-project`
// sono eventi CREATIVI (usePanelLifecycle registra la pane senza chiedere
// niente), la pane finisce in `pane-store-v2`, viene PUTtata sul server e si
// propaga a ogni dispositivo — e non la ripulisce nessuno, perché `project:` è
// un prefisso noto e un topicId è un UUID (tenuto «ottimisticamente»). Bastava
// un link con una chiave inventata, e i link ora si cliccano dalla chat.

describe('openTabInApp — un soggetto non confermato non diventa MAI una pane', () => {
  test('chat: un topicId che il server non conosce non emette `topics:open-topic`', async () => {
    const { events } = stubWindow(`${origin}/`);
    stubResolver([]); // nessun topic: il resolver risponde `unknown`
    const { notes, notify } = collectNotes();
    openTabInApp({ kind: 'chat', key: '123e4567-e89b-12d3-a456-426614174000' }, { notify });
    await settle();
    expect(events.some((e) => e.type === 'topics:open-topic')).toBe(false);
    expect(events.map((e) => e.type)).toEqual(['topics:open-tab', 'topics:tab-opened']);
    expect(notes).toEqual([DEAD_TAB_MESSAGE]);
  });

  test('project: un path che il server non conosce non emette `topics:open-project`', async () => {
    const { events } = stubWindow(`${origin}/`);
    stubResolver([]);
    const { notes, notify } = collectNotes();
    openTabInApp({ kind: 'project', key: '/Users/altro/proj' }, { notify });
    await settle();
    expect(events.some((e) => e.type === 'topics:open-project')).toBe(false);
    expect(notes).toEqual([DEAD_TAB_MESSAGE]);
  });

  test('file: la verifica è sul PROGETTO ospite, e senza di lui non si apre niente', async () => {
    const { events } = stubWindow(`${origin}/`);
    const { asked } = stubResolver([]);
    const { notes, notify } = collectNotes();
    openTabInApp(
      { kind: 'file', key: 'src/App.tsx', projectPath: '/Users/altro/proj' },
      { notify, retry: { attempts: 2, intervalMs: 0 } },
    );
    await settle();
    // Chiesto il progetto, non il file: la pane del file non sta nel pane-store
    // (nessun fantasma da lì), la FINESTRA di progetto sì.
    expect(asked).toEqual([buildTabPath({ kind: 'project', key: '/Users/altro/proj' })!]);
    expect(events.some((e) => e.type === 'topics:open-project')).toBe(false);
    expect(events.some((e) => e.type === 'open-file')).toBe(false);
    expect(notes).toEqual([DEAD_TAB_MESSAGE]);
  });

  test('terminal: una sessione che il server non conosce non conia una tab (e non ruba il fuoco)', async () => {
    // `handleTerminalClick` NON è una guardia, al contrario di quel che diceva
    // il commento: con un sessionId ignoto `terminalSessions.find` dà
    // `undefined`, il locator non trova niente, e il ramo finale fa comunque
    // `setOpenPanels([… 'terminal:<id>'])` + `setFocusedPanelId` — cioè conia la
    // tab e strappa il fuoco a quella su cui stavi.
    const { events } = stubWindow(`${origin}/`);
    stubResolver([]);
    const { notes, notify } = collectNotes();
    openTabInApp({ kind: 'terminal', key: 'sess-inventata' }, { notify });
    await settle();
    expect(events.some((e) => e.type === 'topics:open-terminal-pane')).toBe(false);
    expect(events.map((e) => e.type)).toEqual(['topics:open-tab', 'topics:tab-opened']);
    expect(notes).toEqual([DEAD_TAB_MESSAGE]);
  });

  test('un SÌ si ricorda, un NO no: la GET non si ripete a ogni ri-asserzione', async () => {
    stubWindow(`${origin}/`);
    const { asked } = stubResolver([{ kind: 'project', key: '/work/x' }]);
    openTabInApp({ kind: 'project', key: '/work/x' });
    await settle();
    openTabInApp({ kind: 'project', key: '/work/x' });
    await settle();
    expect(asked.length).toBe(1);

    // Il «non trovato» invece non si sedimenta: il topic può arrivare un istante
    // dopo da un peer, e un no memorizzato lo renderebbe irraggiungibile.
    const { asked: asked2 } = stubResolver([]);
    openTabInApp({ kind: 'chat', key: 'topic-nuovo' });
    await settle();
    openTabInApp({ kind: 'chat', key: 'topic-nuovo' });
    await settle();
    expect(asked2.length).toBe(2);
  });
});

// ── «Non ho potuto chiedere» ≠ «so che non esiste» ──────────────────────────
//
// Il difetto: `askServerIfSubjectExists` faceva `.catch(() => false)`, quindi un
// errore di TRASPORTO rifiutava esattamente come un `unknown`. Su questa
// macchina il server si ricarica a ogni salvataggio in `server/`
// (`TOPICS_SERVER_WATCH=1`): per ~2s un click su un `/tab/chat/<id>`
// perfettamente valido non apriva niente — e, non essendo cablato nessun
// `notify`, non lo diceva nemmeno.

describe('openTabInApp — la guardia rifiuta il NOTO-CATTIVO, non ciò che non ha potuto verificare', () => {
  test('server irraggiungibile: si instrada LO STESSO, ma ora lo si DICE', async () => {
    // Il fail-open resta (rifiutare romperebbe i link buoni a ogni ricarico del
    // server), ma prima l'unica traccia era un `console.warn` — cioè niente, per
    // chi usa l'app. Era il caso che può lasciare una pane fantasma persistita e
    // sincronizzata su ogni device, e taceva; quello benigno parlava.
    const { events } = stubWindow(`${origin}/`);
    stubResolverDown();
    const { notes, notify } = collectNotes();
    openTabInApp({ kind: 'project', key: '/work/x' }, { notify });
    await settle();
    expect(events.some((e) => e.type === 'topics:open-project')).toBe(true);
    expect(notes).toEqual([UNVERIFIED_TAB_MESSAGE]);
  });

  test('risposta non-2xx o corpo illeggibile: idem — non è una risposta sul soggetto', async () => {
    const { events } = stubWindow(`${origin}/`);
    stubResolverBroken(503);
    const { notes, notify } = collectNotes();
    openTabInApp({ kind: 'chat', key: 'topic-1' }, { notify });
    await settle();
    expect(events.some((e) => e.type === 'topics:open-topic')).toBe(true);
    expect(notes).toEqual([UNVERIFIED_TAB_MESSAGE]);
  });

  test('un `unavailable` viene RIPROVATO una volta: la finestra tipica è il ricarico del server', async () => {
    // Primo colpo a vuoto, secondo con la risposta vera: il link buono si apre e
    // NON si avvisa di niente, perché la verifica alla fine è riuscita. È il
    // motivo per cui il ritentativo esiste — quasi tutti gli `unavailable` sono
    // due secondi di server che si ricarica, non un ref inventato.
    const { events } = stubWindow(`${origin}/`);
    let colpi = 0;
    (globalThis as unknown as { fetch: unknown }).fetch = async () => {
      colpi++;
      if (colpi === 1) throw new Error('ECONNREFUSED');
      return { ok: true, json: async () => ({ state: 'open' }) };
    };
    const { notes, notify } = collectNotes();
    openTabInApp({ kind: 'chat', key: 'topic-1' }, { notify });
    await settle();
    expect(colpi).toBe(2);
    expect(events.some((e) => e.type === 'topics:open-topic')).toBe(true);
    expect(notes).toEqual([]);
  });

  test('il ritentativo NON si applica a un «non esiste»: è una risposta, ripeterla non la cambia', async () => {
    const { asked } = stubResolver([]);
    stubWindow(`${origin}/`);
    const { notes, notify } = collectNotes();
    openTabInApp({ kind: 'chat', key: 'topic-inventato' }, { notify });
    await settle();
    expect(asked.length).toBe(1);
    expect(notes).toEqual([DEAD_TAB_MESSAGE]);
  });

  test('ma un `unknown` ESPLICITO continua a rifiutare: la guardia non è stata spenta', async () => {
    const { events } = stubWindow(`${origin}/`);
    stubResolver([]);
    const { notes, notify } = collectNotes();
    openTabInApp({ kind: 'chat', key: 'topic-inventato' }, { notify });
    await settle();
    expect(events.some((e) => e.type === 'topics:open-topic')).toBe(false);
    expect(notes).toEqual([DEAD_TAB_MESSAGE]);
  });

  test('un «non ho potuto chiedere» NON si sedimenta in cache come un sì', async () => {
    // Se lo facesse, un blackout di due secondi diventerebbe il permesso a
    // materializzare quel ref per tutta la sessione — cioè la pane fantasma
    // rientrerebbe dalla finestra.
    stubWindow(`${origin}/`);
    stubResolverDown();
    openTabInApp({ kind: 'project', key: '/work/x' });
    await settle();

    // Server tornato, e il ref NON esiste: dev'essere richiesto di nuovo, e
    // stavolta rifiutato.
    const { events } = stubWindow(`${origin}/`);
    const { asked } = stubResolver([]);
    const { notes, notify } = collectNotes();
    openTabInApp({ kind: 'project', key: '/work/x' }, { notify });
    await settle();
    // Richiesto di nuovo: il «non ho potuto chiedere» non è rimasto in cache.
    expect(asked.length).toBe(1);
    expect(events.some((e) => e.type === 'topics:open-project')).toBe(false);
    expect(notes).toEqual([DEAD_TAB_MESSAGE]);
  });
});

// ── L'ACK di successo: la ri-asserzione di boot deve poter SMETTERE ──────────
//
// Senza un ack sul successo, `topics:tab-opened` lo emetteva solo il wrapper dei
// fallimenti: per un'apertura RIUSCITA la finestra di 8s di App.tsx restava
// accesa tutta intera, e dentro quella finestra ogni click (che bumpa `lastSeq`
// via FOCUS_PANE) faceva ri-asserire il permalink 400ms dopo. Cioè: apri
// `/tab/panel/cron`, clicchi altrove, e vieni ributtato su Cron. A ogni click.

describe('openTabInApp — l’ack di apertura (`topics:tab-opened`)', () => {
  test('la pane COMPARE nello store ⇒ ack `dead:false` (l’intento resta, la ri-asserzione no)', async () => {
    const { events } = stubWindow(`${origin}/`);
    openTabInApp({ kind: 'panel', key: 'cron' }, { settleMs: 5000 });
    // Nessun ack finché la pane non c'è: l'apertura si OSSERVA.
    expect(events.some((e) => e.type === 'topics:tab-opened')).toBe(false);
    // …ed è quello che fa `handleOpenAsPage` quando l'evento atterra.
    usePaneStore.setState((s) => {
      s.panes = { __cron__: { id: '__cron__', type: 'cron' } };
      s.groups = { 'group:default': { id: 'group:default', paneIds: ['__cron__'], splitRatio: 0.5, splitAxis: 'horizontal' } };
      s.lastSeq = (s.lastSeq ?? 0) + 1;
    });
    await settle();
    expect(events.filter((e) => e.type === 'topics:tab-opened')).toEqual([
      { type: 'topics:tab-opened', detail: { paneId: '__cron__', dead: false } },
    ]);
  });

  test('la pane non compare mai: l’ack arriva comunque a scadenza, invece di lasciare accesi 8s', async () => {
    const { events } = stubWindow(`${origin}/`);
    stubResolver([{ kind: 'terminal', key: 'sess-in-un-progetto' }]);
    openTabInApp({ kind: 'terminal', key: 'sess-in-un-progetto' }, { settleMs: 0 });
    await settle();
    expect(events.filter((e) => e.type === 'topics:tab-opened')).toEqual([
      { type: 'topics:tab-opened', detail: { paneId: 'terminal:sess-in-un-progetto', dead: false } },
    ]);
  });

  test('un TASK non acka da qui: il suo ack è del drawer (`topics:task-opened`)', async () => {
    const { events } = stubWindow(`${origin}/`);
    openTabInApp({ kind: 'task', key: 't1' }, { settleMs: 0 });
    await settle();
    expect(events.some((e) => e.type === 'topics:tab-opened')).toBe(false);
  });

  test('solo un VICOLO CIECO rilascia l’intento di focus', () => {
    // Il contratto letto da usePanelLifecycle: su un'apertura riuscita l'intento
    // è l'unica cosa che tiene la tab a fuoco sotto la tempesta di hydrate del
    // boot — spegnerlo lì riaprirebbe il bug che esiste per chiudere.
    expect(tabAckReleasesIntent({ dead: true })).toBe(true);
    expect(tabAckReleasesIntent({ dead: false })).toBe(false);
    // Default prudente: un detail vecchio o assente vale come «morto».
    expect(tabAckReleasesIntent({})).toBe(true);
    expect(tabAckReleasesIntent(undefined)).toBe(true);
  });
});

// ── Finestre STACCATE: il click non deve restare muto ───────────────────────

describe('deep-link in una finestra STACCATA (`?topics=`)', () => {
  test('openTabInApp non instrada e non tocca lo store: lì niente si persiste', async () => {
    const { events } = stubWindow(`${origin}/?topics=t1,t2`);
    stubResolver([{ kind: 'project', key: '/work/x' }, { kind: 'chat', key: 'topic-1' }]);
    const { notes, notify } = collectNotes();
    openTabInApp({ kind: 'chat', key: 'topic-1' }, { notify });
    openTabInApp({ kind: 'project', key: '/work/x' }, { notify });
    openTabInApp({ kind: 'panel', key: 'cron' }, { notify });
    await settle();
    expect(events).toEqual([]);
    expect(usePaneStore.getState().panes['topic-1']).toBeUndefined();
    expect(notes).toEqual([]);
  });

  test('deepLinkClickRoute manda il link al browser ESTERNO, invece che nel vuoto', () => {
    stubWindow(`${origin}/?topics=t1`);
    expect(deepLinkClickRoute(`${origin}/tab/chat/topic-1`)).toEqual({ via: 'external' });
    expect(deepLinkClickRoute(`${origin}/topic/topic-1`)).toEqual({ via: 'external' });
    expect(deepLinkClickRoute(`${origin}/task/t-42`)).toEqual({ via: 'external' });
    // La forma storica singolare `?topic=` vale uguale.
    stubWindow(`${origin}/?topic=t1`);
    expect(deepLinkClickRoute(`${origin}/tab/panel/board`)).toEqual({ via: 'external' });
  });

  test('in una finestra normale invece instrada in-app, task prima di tab', () => {
    stubWindow(`${origin}/`);
    expect(deepLinkClickRoute(`${origin}/task/t-42`)).toEqual({ via: 'task', target: { taskId: 't-42' } });
    expect(deepLinkClickRoute(`${origin}/tab/chat/topic-1`))
      .toEqual({ via: 'tab', target: { kind: 'chat', key: 'topic-1' } });
    expect(deepLinkClickRoute('https://evil.example/tab/chat/t1')).toEqual({ via: 'external' });
    expect(deepLinkClickRoute('')).toEqual({ via: 'external' });
  });
});
