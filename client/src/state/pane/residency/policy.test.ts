/**
 * Who stays mounted and who is evicted when a long session keeps opening
 * panes: cost classes, per-class budgets, the floors that protect what is on
 * screen or held, and the minimum dwell that stops thrashing.
 *
 * @covers LEAK-01
 */
import { describe, expect, test } from 'bun:test';
import {
  computeResident,
  residencyClassOf,
  RESIDENCY_BUDGET,
  MIN_DWELL_MS,
  type ResidencyCandidate,
  type ResidencyInput,
} from './policy';

const NOW = 1_000_000;

function input(over: Partial<ResidencyInput> = {}): ResidencyInput {
  return {
    candidates: [],
    visible: new Set(),
    held: new Set(),
    lastTouchedAt: new Map(),
    now: NOW,
    budget: { native: Infinity, heavy: 2, light: 3 },
    minDwellMs: 1000,
    ...over,
  };
}

function heavy(...keys: string[]): ResidencyCandidate[] {
  return keys.map((key) => ({ key, cls: 'heavy' as const }));
}
function light(...keys: string[]): ResidencyCandidate[] {
  return keys.map((key) => ({ key, cls: 'light' as const }));
}

/** Tutte le chiavi ordinate, per confronti stabili. */
function sorted(s: ReadonlySet<string>): string[] {
  return [...s].sort();
}

/** `lastTouchedAt` con età in ms nel passato, per leggibilità. */
function touched(ages: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(ages).map(([k, ageMs]) => [k, NOW - ageMs]));
}

describe('residencyClassOf', () => {
  test('browser è NATIVE, project è heavy, il resto leggero', () => {
    // La distinzione non è "quanto pesa" ma "smontarla restituisce qualcosa?".
    // Una pane browser possiede una WKWebView, e wry non la dealloca mai
    // (vedi la nota su `native` in policy.ts): sfrattarla e' in perdita secca.
    expect(residencyClassOf('browser')).toBe('native');
    // `project` e' cara ma di solo DOM: smontarla libera davvero.
    expect(residencyClassOf('project')).toBe('heavy');
    for (const t of ['chat', 'terminal', 'files', 'git', 'kanban', 'agents', 'session-viewer']) {
      expect(residencyClassOf(t)).toBe('light');
    }
  });

  test('una pane browser non viene MAI sfrattata, per quante se ne aprano', () => {
    // Il caso che ha fatto crescere l'app a 4,1 GB in un'ora e mezza: sfratto,
    // rientro, e un processo WebContent in piu' che non morira'.
    const keys = Array.from({ length: 30 }, (_, i) => `browser-${i}`);
    const d = computeResident(
      input({
        candidates: keys.map((key) => ({ key, cls: 'native' as const })),
        visible: new Set([keys[0]!]),
        budget: RESIDENCY_BUDGET,
        minDwellMs: MIN_DWELL_MS,
        lastTouchedAt: touched(Object.fromEntries(keys.map((k, i) => [k, 600_000 + i * 1000]))),
      }),
    );
    expect(d.evicted.size).toBe(0);
    expect(d.resident.size).toBe(30);
  });

  test('un tipo sconosciuto ricade su leggero invece di rompersi', () => {
    expect(residencyClassOf('tipo-che-non-esiste')).toBe('light');
  });
});

describe('computeResident — pavimenti', () => {
  test("una pane visibile non è MAI sfrattata, nemmeno oltre il budget", () => {
    // Sei pane care tutte visibili: è uno split 6-way. Il budget è 2, e non
    // conta: sfrattare ciò che l'utente sta guardando è il solo errore visibile.
    const keys = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'];
    const d = computeResident(
      input({ candidates: heavy(...keys), visible: new Set(keys) }),
    );
    expect(sorted(d.resident)).toEqual(keys);
    expect(d.evicted.size).toBe(0);
  });

  test("l'invariante evicted ∩ visible = ∅ regge anche sotto pressione", () => {
    const d = computeResident(
      input({
        candidates: heavy('v1', 'v2', 'h1', 'h2', 'h3', 'h4'),
        visible: new Set(['v1', 'v2']),
        lastTouchedAt: touched({ h1: 9000, h2: 9001, h3: 9002, h4: 9003 }),
      }),
    );
    for (const k of d.evicted) expect(['v1', 'v2']).not.toContain(k);
    expect(d.resident.has('v1')).toBe(true);
    expect(d.resident.has('v2')).toBe(true);
  });

  test('una chiave trattenuta resta residente anche se è la meno recente', () => {
    const d = computeResident(
      input({
        candidates: heavy('vecchia', 'a', 'b', 'c'),
        held: new Set(['vecchia']),
        lastTouchedAt: touched({ vecchia: 999_999, a: 3000, b: 4000, c: 5000 }),
      }),
    );
    expect(d.resident.has('vecchia')).toBe(true);
    expect(d.evicted.has('vecchia')).toBe(false);
  });

  test('il dwell protegge chi è stato lasciato un istante fa', () => {
    // budget heavy = 2, ma tre chiavi sono state visibili entro minDwellMs.
    const d = computeResident(
      input({
        candidates: heavy('a', 'b', 'c'),
        lastTouchedAt: touched({ a: 100, b: 200, c: 300 }),
        minDwellMs: 1000,
      }),
    );
    expect(sorted(d.resident)).toEqual(['a', 'b', 'c']);
    expect(d.evicted.size).toBe(0);
  });

  test('scaduto il dwell, il budget torna a mordere', () => {
    const d = computeResident(
      input({
        candidates: heavy('a', 'b', 'c'),
        lastTouchedAt: touched({ a: 5000, b: 6000, c: 7000 }),
        minDwellMs: 1000,
      }),
    );
    expect(sorted(d.resident)).toEqual(['a', 'b']); // i due più recenti
    expect(sorted(d.evicted)).toEqual(['c']);
  });
});

describe('computeResident — budget e ordine', () => {
  test('il tetto è per classe: le chat non consumano gli slot delle pane browser', () => {
    const d = computeResident(
      input({
        candidates: [...heavy('b1', 'b2', 'b3'), ...light('c1', 'c2', 'c3', 'c4')],
        lastTouchedAt: touched({
          b1: 3000, b2: 4000, b3: 5000,
          c1: 3000, c2: 4000, c3: 5000, c4: 6000,
        }),
      }),
    );
    // heavy: budget 2 → b1, b2 · light: budget 3 → c1, c2, c3
    expect(sorted(d.resident)).toEqual(['b1', 'b2', 'c1', 'c2', 'c3']);
    expect(sorted(d.evicted)).toEqual(['b3', 'c4']);
  });

  test('MRU: sopravvive chi è stato visto più di recente', () => {
    const d = computeResident(
      input({
        candidates: heavy('vecchissima', 'media', 'recente'),
        budget: { native: Infinity, heavy: 1, light: 3 },
        lastTouchedAt: touched({ vecchissima: 90_000, media: 50_000, recente: 5000 }),
      }),
    );
    expect(sorted(d.resident)).toEqual(['recente']);
    expect(sorted(d.evicted)).toEqual(['media', 'vecchissima']);
  });

  test('mai stata visibile = non si monta, nemmeno se ci sarebbe posto', () => {
    // Il tetto RESTRINGE, non allarga: montare una chat che nessuno ha aperto
    // solo perché avanzava uno slot ne fetcherebbe la cronologia per niente. È
    // la semantica "visita-all'attivazione" del keep-alive di prima.
    const d = computeResident(
      input({
        candidates: heavy('mai-vista-1', 'mai-vista-2', 'antica'),
        budget: { native: Infinity, heavy: 10, light: 10 }, // posto in abbondanza
        lastTouchedAt: touched({ antica: 10_000_000 }),
      }),
    );
    expect(sorted(d.resident)).toEqual(['antica']);
    expect(sorted(d.evicted)).toEqual(['mai-vista-1', 'mai-vista-2']);
  });

  test('una pane mai vista ma VISIBILE si monta comunque', () => {
    // Il pavimento viene prima: è il primo render dopo l'apertura di una tab.
    const d = computeResident(
      input({ candidates: heavy('appena-aperta'), visible: new Set(['appena-aperta']) }),
    );
    expect(sorted(d.resident)).toEqual(['appena-aperta']);
  });

  test("a parità di recency l'esito è deterministico, non dipende dall'ordine di input", () => {
    const same = touched({ a: 9000, b: 9000, c: 9000 });
    const one = computeResident(
      input({ candidates: heavy('a', 'b', 'c'), budget: { native: Infinity, heavy: 1, light: 0 }, lastTouchedAt: same }),
    );
    const other = computeResident(
      input({ candidates: heavy('c', 'b', 'a'), budget: { native: Infinity, heavy: 1, light: 0 }, lastTouchedAt: same }),
    );
    expect(sorted(one.resident)).toEqual(sorted(other.resident));
  });

  test('budget a zero: resta solo il pavimento', () => {
    const d = computeResident(
      input({
        candidates: heavy('visibile', 'a', 'b'),
        visible: new Set(['visibile']),
        budget: { native: Infinity, heavy: 0, light: 0 },
        lastTouchedAt: touched({ a: 60_000, b: 70_000 }),
      }),
    );
    expect(sorted(d.resident)).toEqual(['visibile']);
    expect(sorted(d.evicted)).toEqual(['a', 'b']);
  });

  test('budget infinito ripristina esattamente il comportamento di prima', () => {
    // È la via di rollback dichiarata in policy.ts: nessuno sfratto, mai.
    const keys = Array.from({ length: 40 }, (_, i) => `k${i}`);
    const d = computeResident(
      input({
        candidates: heavy(...keys),
        budget: { native: Infinity, heavy: Infinity, light: Infinity },
        lastTouchedAt: touched(Object.fromEntries(keys.map((k, i) => [k, 100_000 + i]))),
      }),
    );
    expect(d.resident.size).toBe(40);
    expect(d.evicted.size).toBe(0);
  });
});

describe('computeResident — unione di superfici', () => {
  test('la stessa chiave riportata da due superfici consuma UN solo slot', () => {
    // Il bug che il tetto globale esiste per evitare: `visitedKeys` era
    // per-superficie, quindi quattro progetti aperti moltiplicavano per quattro.
    const d = computeResident(
      input({
        candidates: [...heavy('condivisa', 'a'), ...heavy('condivisa', 'b')],
        budget: { native: Infinity, heavy: 2, light: 0 },
        lastTouchedAt: touched({ condivisa: 1000, a: 2000, b: 3000 }),
      }),
    );
    expect(sorted(d.resident)).toEqual(['a', 'condivisa']);
    expect(sorted(d.evicted)).toEqual(['b']);
  });

  test('in caso di classificazione discorde vince heavy', () => {
    const d = computeResident(
      input({
        candidates: [{ key: 'x', cls: 'light' }, { key: 'x', cls: 'heavy' }],
        budget: { native: Infinity, heavy: 0, light: 5 },
        lastTouchedAt: touched({ x: 60_000 }),
      }),
    );
    // Se avesse contato come `light` sarebbe sopravvissuta (budget 5).
    expect(sorted(d.evicted)).toEqual(['x']);
  });
});

describe('computeResident — totalità', () => {
  test('resident ed evicted partizionano i candidati, senza intersezione', () => {
    const d = computeResident(
      input({
        candidates: [...heavy('b1', 'b2', 'b3'), ...light('c1', 'c2', 'c3', 'c4', 'c5')],
        visible: new Set(['b1']),
        held: new Set(['c5']),
        lastTouchedAt: touched({ b2: 8000, b3: 9000, c1: 8000, c2: 9000, c3: 10_000, c4: 11_000 }),
      }),
    );
    const all = ['b1', 'b2', 'b3', 'c1', 'c2', 'c3', 'c4', 'c5'];
    expect(sorted(new Set([...d.resident, ...d.evicted]))).toEqual(all);
    for (const k of d.resident) expect(d.evicted.has(k)).toBe(false);
  });

  test('una chiave sparita dai candidati non compare da nessuna parte', () => {
    // Potatura ≠ sfratto: se la pane è stata CHIUSA non c'è niente da sfrattare,
    // e il registro non deve trattarla come tale (né ritardo, né notifica).
    const d = computeResident(input({ candidates: heavy('viva'), visible: new Set(['viva']) }));
    expect(d.resident.has('chiusa')).toBe(false);
    expect(d.evicted.has('chiusa')).toBe(false);
  });

  test('nessun candidato: decisione vuota, non un errore', () => {
    const d = computeResident(input());
    expect(d.resident.size).toBe(0);
    expect(d.evicted.size).toBe(0);
  });
});

describe('costanti di produzione', () => {
  test('i tetti reali contengono davvero qualcosa', () => {
    expect(RESIDENCY_BUDGET.heavy).toBeGreaterThan(0);
    expect(RESIDENCY_BUDGET.heavy).toBeLessThan(RESIDENCY_BUDGET.light);
    expect(Number.isFinite(RESIDENCY_BUDGET.heavy)).toBe(true);
  });

  test('il dwell supera la grazia di chiusura della WKWebView (350 ms)', () => {
    // Vedi la nota su BROWSER_CLOSE_GRACE_MS in policy.ts e useTauriBrowser.ts:
    // lo sfratto deve arrivare DOPO che l'effetto di spegnimento è girato.
    expect(MIN_DWELL_MS).toBeGreaterThan(350);
  });

  test('col budget di produzione venti pane care non restano montate', () => {
    const keys = Array.from({ length: 20 }, (_, i) => `browser-${i}`);
    const d = computeResident(
      input({
        candidates: heavy(...keys),
        visible: new Set([keys[0]!]),
        budget: RESIDENCY_BUDGET,
        minDwellMs: MIN_DWELL_MS,
        lastTouchedAt: touched(Object.fromEntries(keys.map((k, i) => [k, 60_000 + i * 1000]))),
      }),
    );
    expect(d.resident.size).toBe(1 + RESIDENCY_BUDGET.heavy);
    expect(d.evicted.size).toBe(20 - 1 - RESIDENCY_BUDGET.heavy);
  });
});
