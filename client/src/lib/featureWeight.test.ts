/** @covers RES-ATTR-06 */
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  registerFeatureWeight,
  collectFeatureWeights,
  inventarioVisibile,
  ordinaVoci,
  voceVuota,
  roughBytes,
  _resetFeatureWeights,
  _countFeatureWeightOwners,
  type VocePeso,
} from './featureWeight';

const voce = (p: Partial<VocePeso>): VocePeso => ({
  id: p.id ?? 'x',
  label: p.label ?? 'X',
  natura: p.natura ?? 'trattenuto',
  peso: p.peso ?? { entries: 0 },
  errore: p.errore,
});

beforeEach(() => _resetFeatureWeights());

describe('registrazione', () => {
  it('raccoglie cio\' che i proprietari dichiarano', () => {
    registerFeatureWeight('chat', 'Le tue chat', 'trattenuto', () => ({ entries: 3, items: 4312 }));
    const v = collectFeatureWeights();
    expect(v).toHaveLength(1);
    expect(v[0].label).toBe('Le tue chat');
    expect(v[0].peso.items).toBe(4312);
  });

  it('la de-registrazione toglie la voce', () => {
    const off = registerFeatureWeight('chat', 'Le tue chat', 'trattenuto', () => ({ entries: 1 }));
    expect(_countFeatureWeightOwners()).toBe(1);
    off();
    expect(_countFeatureWeightOwners()).toBe(0);
  });

  it('registrare due volte lo stesso id SOSTITUISCE invece di duplicare', () => {
    // StrictMode monta ogni effetto due volte: una Map che accumulasse
    // duplicati conterebbe la stessa funzionalita' due volte in sviluppo e una
    // in produzione.
    registerFeatureWeight('chat', 'Le tue chat', 'trattenuto', () => ({ entries: 1 }));
    registerFeatureWeight('chat', 'Le tue chat', 'trattenuto', () => ({ entries: 9 }));
    expect(_countFeatureWeightOwners()).toBe(1);
    expect(collectFeatureWeights()[0].peso.entries).toBe(9);
  });

  it('una cleanup tardiva non cancella la registrazione che l\'ha sostituita', () => {
    // L'ordine di StrictMode e': monta A, monta B, smonta A. Se la cleanup di A
    // cancellasse per id, toglierebbe B — cioe' una funzionalita' viva.
    const offA = registerFeatureWeight('chat', 'Le tue chat', 'trattenuto', () => ({ entries: 1 }));
    registerFeatureWeight('chat', 'Le tue chat', 'trattenuto', () => ({ entries: 2 }));
    offA();
    expect(_countFeatureWeightOwners()).toBe(1);
    expect(collectFeatureWeights()[0].peso.entries).toBe(2);
  });
});

describe('un proprietario che fallisce', () => {
  it('non azzera gli altri, e si dichiara NON MISURATO invece che zero', () => {
    registerFeatureWeight('rotto', 'Rotta', 'trattenuto', () => { throw new Error('boom'); });
    registerFeatureWeight('sano', 'Sana', 'trattenuto', () => ({ entries: 5 }));
    const v = collectFeatureWeights();
    expect(v).toHaveLength(2);
    const rotto = v.find(x => x.id === 'rotto')!;
    expect(rotto.errore).toBe('boom');
    expect(v.find(x => x.id === 'sano')!.peso.entries).toBe(5);
  });

  it('una voce in errore NON e\' vuota: non lo sappiamo, quindi resta visibile', () => {
    expect(voceVuota(voce({ errore: 'boom' }))).toBe(false);
    registerFeatureWeight('rotto', 'Rotta', 'trattenuto', () => { throw new Error('boom'); });
    expect(inventarioVisibile()).toHaveLength(1);
  });
});

describe('voci vuote', () => {
  it('una funzionalita\' che non tiene niente non compare', () => {
    registerFeatureWeight('vuota', 'Vuota', 'trattenuto', () => ({ entries: 0 }));
    registerFeatureWeight('piena', 'Piena', 'trattenuto', () => ({ entries: 2 }));
    const v = inventarioVisibile();
    expect(v.map(x => x.id)).toEqual(['piena']);
  });

  it('zero voci ma elementi presenti NON e\' vuota', () => {
    expect(voceVuota(voce({ peso: { entries: 0, items: 7 } }))).toBe(false);
  });

  it('una voce misurata con MB ma zero voci NON e\' vuota', () => {
    expect(voceVuota(voce({ natura: 'misurato', peso: { entries: 0, memoryMB: 120 } }))).toBe(false);
  });

  it('tutto a zero e\' vuota', () => {
    expect(voceVuota(voce({ peso: { entries: 0, items: 0, memoryMB: 0, processCount: 0 } }))).toBe(true);
  });

  it('inventario interamente vuoto torna una lista vuota, non una sezione di zeri', () => {
    registerFeatureWeight('a', 'A', 'trattenuto', () => ({ entries: 0 }));
    registerFeatureWeight('b', 'B', 'misurato', () => ({ entries: 0, memoryMB: 0 }));
    expect(inventarioVisibile()).toEqual([]);
  });
});

describe('ordinamento', () => {
  it('il misurato viene prima del trattenuto: sono MB veri', () => {
    const v = ordinaVoci([
      voce({ id: 't', natura: 'trattenuto', peso: { entries: 9999 } }),
      voce({ id: 'm', natura: 'misurato', peso: { entries: 1, memoryMB: 1 } }),
    ]);
    expect(v.map(x => x.id)).toEqual(['m', 't']);
  });

  it('dentro il misurato ordina per MB decrescenti', () => {
    const v = ordinaVoci([
      voce({ id: 'piccolo', natura: 'misurato', peso: { entries: 1, memoryMB: 10 } }),
      voce({ id: 'grosso', natura: 'misurato', peso: { entries: 1, memoryMB: 900 } }),
    ]);
    expect(v.map(x => x.id)).toEqual(['grosso', 'piccolo']);
  });

  it('dentro il trattenuto ordina per byte stimati, e senza byte per elementi', () => {
    const v = ordinaVoci([
      voce({ id: 'pochi', peso: { entries: 1, bytes: 10 } }),
      voce({ id: 'tanti', peso: { entries: 1, bytes: 5000 } }),
      voce({ id: 'senzaByte', peso: { entries: 1, items: 900 } }),
    ]);
    expect(v.map(x => x.id)).toEqual(['tanti', 'senzaByte', 'pochi']);
  });

  it('a parita\' di peso l\'ordine e\' deterministico per id', () => {
    const a = ordinaVoci([
      voce({ id: 'zeta', peso: { entries: 5 } }),
      voce({ id: 'alfa', peso: { entries: 5 } }),
    ]);
    expect(a.map(x => x.id)).toEqual(['alfa', 'zeta']);
  });

  it('due letture consecutive senza cambiamenti danno lo stesso ordine', () => {
    registerFeatureWeight('b', 'B', 'trattenuto', () => ({ entries: 5 }));
    registerFeatureWeight('a', 'A', 'trattenuto', () => ({ entries: 5 }));
    registerFeatureWeight('c', 'C', 'trattenuto', () => ({ entries: 5 }));
    expect(collectFeatureWeights().map(v => v.id)).toEqual(collectFeatureWeights().map(v => v.id));
  });

  it('le voci in errore vanno in fondo alla loro natura, non in cima', () => {
    const v = ordinaVoci([
      voce({ id: 'rotta', errore: 'boom' }),
      voce({ id: 'viva', peso: { entries: 1 } }),
    ]);
    expect(v.map(x => x.id)).toEqual(['viva', 'rotta']);
  });
});

describe('le due nature non si sommano', () => {
  it('un conteggio non diventa MB: `memoryMB` di una voce trattenuta non entra nell\'ordine', () => {
    // Se qualcuno scrivesse memoryMB su una voce trattenuta, non deve poterla
    // far salire come se fosse una misura: l'ordine dei trattenuti guarda
    // bytes/items, mai i MB.
    const v = ordinaVoci([
      voce({ id: 'furba', peso: { entries: 1, memoryMB: 99999, items: 1 } }),
      voce({ id: 'onesta', peso: { entries: 1, items: 50 } }),
    ]);
    expect(v.map(x => x.id)).toEqual(['onesta', 'furba']);
  });
});

describe('roughBytes', () => {
  it('stima la dimensione di uno stato serializzabile', () => {
    expect(roughBytes({ a: 1 })).toBe(JSON.stringify({ a: 1 }).length);
  });

  it('un ciclo torna 0 invece di far fallire tutta la misura', () => {
    const ciclo: Record<string, unknown> = {};
    ciclo.self = ciclo;
    expect(roughBytes(ciclo)).toBe(0);
  });

  it('undefined non esplode', () => {
    expect(roughBytes(undefined)).toBe(0);
  });
});
