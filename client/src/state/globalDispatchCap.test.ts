/**
 * Il tetto globale è UNO. Questo file copre la parte che si può rompere in
 * silenzio: che le due superfici che lo mostrano leggano lo stesso valore e
 * scrivano nello stesso posto.
 *
 * Perché conta: prima il tetto viveva in una `useState` dentro il menu del
 * titolo, e il pannello delle impostazioni non lo mostrava affatto. Aggiungerlo
 * con una seconda `useState` avrebbe prodotto due numeri liberi di divergere,
 * che è esattamente il guasto già visto su `board:global-cap` (la finestra che
 * cambiava il tetto si aggiornava, le altre no).
 *
 * `fetch` è finto: qui si misura lo store, non il server. Il contratto del
 * filo (PATCH /api/all-boards/settings, frame `board:global-cap`) è coperto
 * dalle sue prove altrove.
 *
 * @covers KANBAN-07, KANBAN-12
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  adoptDispatchCapacity,
  adoptGlobalCap,
  currentCapLimit,
  getGlobalDispatchCapState,
  saveGlobalCap,
  subscribeGlobalDispatchCap,
} from './globalDispatchCap';
import { clampGlobalCap, type DispatchCapacity } from '../lib/board';
import { dispatchFrame } from '../lib/wsFrameBus';

const machine = (over: Partial<DispatchCapacity> = {}): DispatchCapacity => ({
  recommended: 4,
  cores: 12,
  totalMemGB: 32,
  // Measured (20 GB free of 32): `null` would be "no probe", which is another
  // case with a test of its own.
  availableMemGB: 20,
  load1: 2.5,
  // Vedi `GlobalCapControl.test.tsx`: il freno vivo è la CPU della flotta sulla
  // quota che le spetta, non più il load average della macchina intera.
  oursCores: 0,
  budgetCores: 6,
  reason: '12 core, base 4',
  running: 0,
  ...over,
});

/**
 * Le risposte del server, per URL. `PATCH` restituisce quel che riceve, come fa
 * il vero, e stringe il numero negli estremi. `echo` forza la risposta a un
 * valore DIVERSO da quello chiesto: serve a distinguere «lo store ha adottato
 * la risposta del server» da «lo store ha tenuto il proprio ottimismo», che
 * altrimenti si somigliano.
 */
function stubFetch(
  echo?: { maxAgentsAuto: boolean; maxAgents: number; maxAgentsMode?: 'count' | 'resources'; maxLoadRatio?: number; maxMemRatio?: number },
  opts: { knowsMode?: boolean } = {},
): { patched: Array<Record<string, unknown>> } {
  const patched: Array<Record<string, unknown>> = [];
  let auto = false;
  let max = 5;
  // A NEW server (KANBAN-75) keeps and echoes the mode and the thresholds; an
  // old one ignores them and answers without: `knowsMode` tells the two apart.
  const extras: Record<string, unknown> = {};
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/api/system/dispatch-capacity')) {
      return new Response(JSON.stringify(machine()), { status: 200 });
    }
    if (String(url).endsWith('/api/all-boards/settings')) {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        patched.push(body);
        if (typeof body.maxAgentsAuto === 'boolean') auto = body.maxAgentsAuto;
        if (typeof body.maxAgents === 'number') max = clampGlobalCap(body.maxAgents);
        if (opts.knowsMode) {
          for (const k of ['maxAgentsMode', 'maxLoadRatio', 'maxMemRatio']) if (k in body) extras[k] = body[k];
        }
      }
      return new Response(
        JSON.stringify({ autoDispatch: false, ...(echo ?? { maxAgentsAuto: auto, maxAgents: max, ...extras }) }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { patched };
}

const realFetch = globalThis.fetch;

/** Lascia atterrare la lettura iniziale che parte col PRIMO abbonato, prima di
 *  misurare: altrimenti la si misura in corsa contro la scrittura del test. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  // Ogni prova riparte da un tetto noto: lo store è di modulo, quindi vive
  // fra un test e l'altro come vive fra un componente e l'altro.
  // The mode and the thresholds too: a frame that does not carry them KEEPS
  // the ones already there, so a test that switched would leak into the next.
  adoptGlobalCap({ maxAgentsAuto: false, maxAgents: 5, maxAgentsMode: 'count', maxLoadRatio: 0.9, maxMemRatio: 0.85 });
  adoptDispatchCapacity(machine());
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('currentCapLimit', () => {
  test('auto follows the machine, fixed follows the number', () => {
    adoptGlobalCap({ maxAgentsAuto: true });
    adoptDispatchCapacity(machine({ recommended: 6 }));
    expect(currentCapLimit(getGlobalDispatchCapState())).toBe(6);

    adoptGlobalCap({ maxAgentsAuto: false, maxAgents: 2 });
    expect(currentCapLimit(getGlobalDispatchCapState())).toBe(2);
  });

  test('in auto with no probe it says nothing rather than the fallback number', () => {
    // Il numero fisso resta scritto sotto, ma in auto non è lui a valere:
    // mostrarlo sarebbe una bugia comoda, e il dispatcher applicherebbe altro.
    adoptGlobalCap({ maxAgentsAuto: true, maxAgents: 5 });
    expect(currentCapLimit({ cap: { auto: true, max: 5 }, capacity: null, saving: false, spend: null })).toBe(null);
  });
});

describe('one store, two readers', () => {
  test('a write from ONE surface is seen by the OTHER, with no reload', async () => {
    stubFetch();
    // Due abbonati = le due superfici montate insieme (il menu del titolo e il
    // pannello delle impostazioni della board).
    const menuSaw: Array<number | null> = [];
    const panelSaw: Array<number | null> = [];
    const unsubMenu = subscribeGlobalDispatchCap(() => menuSaw.push(getGlobalDispatchCapState().cap?.max ?? null));
    const unsubPanel = subscribeGlobalDispatchCap(() => panelSaw.push(getGlobalDispatchCapState().cap?.max ?? null));
    try {
      await settle();
      // Il controllo del PANNELLO scrive.
      await saveGlobalCap({ max: 7 });
      expect(getGlobalDispatchCapState().cap).toMatchObject({ auto: false, max: 7 });
      // Il MENU l'ha visto, senza aver chiesto niente al server per conto suo.
      expect(menuSaw.at(-1)).toBe(7);
      expect(panelSaw.at(-1)).toBe(7);
    } finally {
      unsubMenu();
      unsubPanel();
    }
  });

  test('the two readers hold the SAME snapshot object, not two copies', async () => {
    stubFetch();
    let fromMenu = getGlobalDispatchCapState();
    let fromPanel = getGlobalDispatchCapState();
    const unsubMenu = subscribeGlobalDispatchCap(() => { fromMenu = getGlobalDispatchCapState(); });
    const unsubPanel = subscribeGlobalDispatchCap(() => { fromPanel = getGlobalDispatchCapState(); });
    try {
      await settle();
      await saveGlobalCap({ auto: true });
      expect(fromMenu).toBe(fromPanel);
      expect(fromMenu.cap?.auto).toBe(true);
    } finally {
      unsubMenu();
      unsubPanel();
    }
  });

  test('the number moves under the finger, before the server answers', async () => {
    stubFetch();
    const inFlight = saveGlobalCap({ max: 999 });
    // Ancora nessuna risposta: quel che si vede è il valore ottimistico, già
    // stretto negli estremi (un campo che accetta 999 e ne salva 20 mente).
    expect(getGlobalDispatchCapState().cap?.max).toBe(20);
    expect(getGlobalDispatchCapState().saving).toBe(true);
    await inFlight;
  });

  test('the server ANSWER wins over the optimistic value', async () => {
    // Il server risponde 6 a qualunque richiesta: se lo store tenesse il proprio
    // ottimismo resterebbe su 7, e il numero mostrato smetterebbe di essere
    // quello applicato dal dispatcher.
    stubFetch({ maxAgentsAuto: false, maxAgents: 6 });
    await saveGlobalCap({ max: 7 });
    expect(getGlobalDispatchCapState().cap).toMatchObject({ auto: false, max: 6 });
  });

  test('a failed write goes back to the value that was there', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = async () => new Response('{"error":"nope"}', { status: 500 });
    const before = getGlobalDispatchCapState().cap;
    await saveGlobalCap({ max: 11 });
    expect(getGlobalDispatchCapState().cap).toEqual(before!);
  });
});

describe('adoptGlobalCap', () => {
  test('another window changing the cap lands here (the WS frame shape)', () => {
    adoptGlobalCap({ maxAgentsAuto: true, maxAgents: 9 });
    expect(getGlobalDispatchCapState().cap).toMatchObject({ auto: true, max: 9 });
  });

  test('an unchanged value keeps the snapshot identity (no render churn)', () => {
    adoptGlobalCap({ maxAgentsAuto: false, maxAgents: 5 });
    const first = getGlobalDispatchCapState();
    adoptGlobalCap({ maxAgentsAuto: false, maxAgents: 5 });
    expect(getGlobalDispatchCapState()).toBe(first);
  });

  test('a partial frame only moves what it carries', () => {
    adoptGlobalCap({ maxAgentsAuto: false, maxAgents: 5 });
    adoptGlobalCap({ maxAgents: 8 });
    expect(getGlobalDispatchCapState().cap).toMatchObject({ auto: false, max: 8 });
  });
});

/**
 * THE WIRE ITSELF, not the adopter behind it.
 *
 * Everything above calls `adoptGlobalCap` by hand, which exercises the function
 * a frame would reach — and leaves the part that makes a frame reach it
 * completely uncovered. Measured: deleting the whole `subscribeFrames(...)` call
 * in `start()` left this suite green. That subscription is the entire reason
 * this store exists: the original defect was a cap in a `useState` that nobody
 * broadcast to, so one window moved and the others did not.
 *
 * These go through `dispatchFrame`, the same door the socket pushes through.
 */
describe('the broadcast actually arrives', () => {
  test('a board:global-cap frame from another window lands in the store', () => {
    const off = subscribeGlobalDispatchCap(() => {});
    try {
      adoptGlobalCap({ maxAgentsAuto: false, maxAgents: 3 });
      dispatchFrame({ type: 'board:global-cap', maxAgentsAuto: false, maxAgents: 13 });
      expect(getGlobalDispatchCapState().cap).toMatchObject({ auto: false, max: 13 });
    } finally { off(); }
  });

  test('someone else’s frame type does not move the cap', () => {
    const off = subscribeGlobalDispatchCap(() => {});
    try {
      adoptGlobalCap({ maxAgentsAuto: false, maxAgents: 3 });
      dispatchFrame({ type: 'board:dispatch', maxAgents: 99 });
      expect(getGlobalDispatchCapState().cap).toMatchObject({ auto: false, max: 3 });
    } finally { off(); }
  });

  test('with nobody watching, the subscription is gone (no leak, no ghost writes)', () => {
    const off = subscribeGlobalDispatchCap(() => {});
    off();
    adoptGlobalCap({ maxAgentsAuto: false, maxAgents: 3 });
    dispatchFrame({ type: 'board:global-cap', maxAgentsAuto: true, maxAgents: 13 });
    expect(getGlobalDispatchCapState().cap).toMatchObject({ auto: false, max: 3 });
  });
});

/**
 * THE OTHER BRAKE (KANBAN-75), on the wire and in the store: the mode and the
 * two thresholds ride the same row, the same PATCH and the same frame as the
 * cap, and a server that predates them must not be able to break the client.
 */
describe('the brake by resources', () => {
  test('nothing on the wire = count with the default thresholds, never undefined', () => {
    adoptGlobalCap({ maxAgentsAuto: true, maxAgents: 3 });
    // The beforeEach wrote `count` already; what is asserted is that the store
    // ALWAYS carries the three fields resolved, so no reader has to default them.
    expect(getGlobalDispatchCapState().cap).toEqual({ auto: true, max: 3, mode: 'count', maxLoadRatio: 0.9, maxMemRatio: 0.85 });
  });

  test('the frame carries the mode and the thresholds, clamped to the shared bounds', () => {
    adoptGlobalCap({ maxAgentsMode: 'resources', maxLoadRatio: 9, maxMemRatio: 0.1 });
    expect(getGlobalDispatchCapState().cap).toMatchObject({ mode: 'resources', maxLoadRatio: 3, maxMemRatio: 0.5 });
  });

  test('a frame WITHOUT the mode keeps the one it has: an old server never resets a choice', () => {
    adoptGlobalCap({ maxAgentsMode: 'resources', maxLoadRatio: 1.1 });
    adoptGlobalCap({ maxAgentsAuto: false, maxAgents: 4 });
    expect(getGlobalDispatchCapState().cap).toMatchObject({ auto: false, max: 4, mode: 'resources', maxLoadRatio: 1.1 });
  });

  test('an unreadable mode is count, not the stricter brake', () => {
    adoptGlobalCap({ maxAgentsMode: 'whatever' as unknown as 'count' });
    expect(getGlobalDispatchCapState().cap?.mode).toBe('count');
  });

  test('switching the brake writes ONLY the mode, in the wire name, through the same PATCH', async () => {
    const { patched } = stubFetch(undefined, { knowsMode: true });
    await saveGlobalCap({ mode: 'resources' });
    expect(patched).toEqual([{ maxAgentsMode: 'resources' }]);
    expect(getGlobalDispatchCapState().cap).toMatchObject({ mode: 'resources', auto: false, max: 5 });
  });

  test('a threshold moves under the finger already clamped, then the server answer lands', async () => {
    const { patched } = stubFetch(undefined, { knowsMode: true });
    const inFlight = saveGlobalCap({ maxLoadRatio: 7 });
    expect(getGlobalDispatchCapState().cap?.maxLoadRatio).toBe(3);
    await inFlight;
    expect(patched).toEqual([{ maxLoadRatio: 7 }]);
    expect(getGlobalDispatchCapState().cap?.maxLoadRatio).toBe(3);
  });

  test('an OLD server answers without the mode: the choice under the finger is kept, not snapped back', async () => {
    // The old `setGlobalCap` rebuilt the cap from the answer alone, and an answer
    // without `maxAgentsMode` would have flipped the selector back to "count"
    // one round trip after the click. The answer goes through `adoptGlobalCap`
    // instead, which keeps what a frame does not carry.
    stubFetch(undefined, { knowsMode: false });
    await saveGlobalCap({ mode: 'resources', maxMemRatio: 0.9 });
    expect(getGlobalDispatchCapState().cap).toMatchObject({ mode: 'resources', maxMemRatio: 0.9 });
  });

  test('a NEW server that disagrees wins: the answer is authoritative', async () => {
    stubFetch({ maxAgentsAuto: false, maxAgents: 5, maxAgentsMode: 'count', maxLoadRatio: 1.2 });
    await saveGlobalCap({ mode: 'resources', maxLoadRatio: 0.7 });
    expect(getGlobalDispatchCapState().cap).toMatchObject({ mode: 'count', maxLoadRatio: 1.2 });
  });

  test('a failed write goes back to the brake that was there', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = async () => new Response('{"error":"nope"}', { status: 500 });
    await saveGlobalCap({ mode: 'resources' });
    expect(getGlobalDispatchCapState().cap?.mode).toBe('count');
  });
});
