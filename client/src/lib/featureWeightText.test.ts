import { describe, it, expect } from 'bun:test';
import { rigaVoce, bloccoTooltip, vociPerNatura, fmt, RIGHE_NEL_TOOLTIP } from './featureWeightText';
import type { VocePeso } from './featureWeight';

const v = (p: Partial<VocePeso>): VocePeso => ({
  id: p.id ?? 'x', label: p.label ?? 'X',
  natura: p.natura ?? 'trattenuto',
  peso: p.peso ?? { entries: 1 },
  errore: p.errore,
});

describe('rigaVoce — misurato', () => {
  it('MB e processi, che dicono se si chiude una cosa o dodici', () => {
    const r = rigaVoce(v({
      label: 'Terminali e sessioni', natura: 'misurato',
      peso: { entries: 2, memoryMB: 426, processCount: 4 },
    }));
    expect(r).toContain('426 MB');
    expect(r).toContain('4 processi');
  });

  it('un processo solo si scrive al singolare', () => {
    const r = rigaVoce(v({ natura: 'misurato', peso: { entries: 1, memoryMB: 372, processCount: 1 } }));
    expect(r).toContain('1 processo');
    expect(r).not.toContain('1 processi');
  });
});

describe('rigaVoce — trattenuto', () => {
  it('conta le cose, e NON scrive byte: un conteggio non e\' una misura di memoria', () => {
    const r = rigaVoce(v({
      label: 'Chat caricate in memoria',
      peso: { entries: 3, items: 4312, bytes: 1_500_000 },
    }));
    expect(r).toContain('3 voci');
    expect(r).toContain('4312 elementi');
    expect(r).not.toContain('MB');
    expect(r).not.toContain('1500000');
  });

  it('una voce sola si scrive al singolare', () => {
    expect(rigaVoce(v({ peso: { entries: 1 } }))).toContain('1 voce');
  });

  it('senza elementi mostra solo le voci', () => {
    const r = rigaVoce(v({ label: 'Task della board', peso: { entries: 47 } }));
    expect(r).toBe('Task della board: 47 voci');
  });

  it('le migliaia si scrivono col punto, all\'italiana', () => {
    expect(rigaVoce(v({ peso: { entries: 1, items: 12345 } }))).toContain('12.345');
  });
});

describe('fmt — il raggruppamento italiano, non «un punto ogni tre cifre»', () => {
  it('quattro cifre NON si raggruppano: e\' la regola CLDR italiana', () => {
    // `minimumGroupingDigits: 2`. Scritto a mano perche' `toLocaleString`
    // dipende dall'ICU di chi esegue, e le stesse righe girano sotto bun test
    // e dentro WebKit.
    expect(fmt(4312)).toBe('4312');
    expect(fmt(9999)).toBe('9999');
  });

  it('da cinque cifre in su si raggruppa', () => {
    expect(fmt(10000)).toBe('10.000');
    expect(fmt(12345)).toBe('12.345');
    expect(fmt(1234567)).toBe('1.234.567');
  });

  it('i numeri piccoli restano nudi', () => {
    expect(fmt(0)).toBe('0');
    expect(fmt(7)).toBe('7');
    expect(fmt(999)).toBe('999');
  });

  it('coincide con il runtime dove il runtime ha un\'opinione', () => {
    // Se un domani cambiassimo la regola a mano, questo lo direbbe: e' il
    // confronto con la fonte autorevole, non una copia della nostra logica.
    for (const n of [0, 7, 999, 4312, 10000, 12345, 1234567]) {
      expect(fmt(n)).toBe(n.toLocaleString('it-IT'));
    }
  });
});

describe('rigaVoce — errore', () => {
  it('dice NON MISURATO, che non e\' zero', () => {
    const r = rigaVoce(v({ label: 'Rotta', errore: 'boom' }));
    expect(r).toBe('Rotta: non misurato');
    expect(r).not.toContain('0');
  });
});

describe('l\'invariante delle due nature (RES-ATTR-07)', () => {
  it('NESSUNA riga trattenuta puo\' contenere «MB», comunque sia fatta la voce', () => {
    // Non un caso solo: il difetto che questo cattura — scrivere i byte
    // stimati come megabyte — e' stato iniettato davvero, ed era passato sotto
    // l'E2E perche' viveva in un tooltip che nessuno guardava. Qui non ha dove
    // nascondersi.
    const casi: VocePeso[] = [
      v({ peso: { entries: 3, items: 4312, bytes: 1_500_000 } }),
      v({ peso: { entries: 1 } }),
      v({ peso: { entries: 0, items: 5 } }),
      v({ peso: { entries: 200, bytes: 900_000_000 } }),
      // Anche se qualcuno ci scrivesse dei MB dentro per sbaglio: una voce
      // trattenuta non li mostra, perche' non e' quella la sua unita'.
      v({ peso: { entries: 2, memoryMB: 4096 } }),
      v({ errore: 'boom' }),
    ];
    for (const c of casi) expect(rigaVoce(c)).not.toContain('MB');
  });

  it('OGNI riga misurata contiene «MB»: il contrario non e\' una correzione', () => {
    const casi: VocePeso[] = [
      v({ natura: 'misurato', peso: { entries: 1, memoryMB: 372, processCount: 1 } }),
      v({ natura: 'misurato', peso: { entries: 2, memoryMB: 749, processCount: 5 } }),
      v({ natura: 'misurato', peso: { entries: 1, memoryMB: 0 } }),
    ];
    for (const c of casi) expect(rigaVoce(c)).toContain('MB');
  });
});

describe('bloccoTooltip', () => {
  const molte = Array.from({ length: 9 }, (_, i) =>
    v({ id: `v${i}`, label: `Voce ${i}`, peso: { entries: 9 - i } }));

  it('taglia alle prime righe e DICHIARA quante ne restano', () => {
    const t = bloccoTooltip(molte)!;
    expect(t.split('\n')).toHaveLength(1 + RIGHE_NEL_TOOLTIP + 1); // titolo + righe + coda
    expect(t).toContain('e altre 4');
  });

  it('senza coda non scrive «e altre 0»', () => {
    const t = bloccoTooltip(molte.slice(0, 3))!;
    expect(t).not.toContain('e altre');
  });

  it('esattamente al limite non dichiara una coda', () => {
    const t = bloccoTooltip(molte.slice(0, RIGHE_NEL_TOOLTIP))!;
    expect(t).not.toContain('e altre');
  });

  it('un inventario vuoto non produce un\'intestazione a vuoto', () => {
    // Un titolo «Cosa tiene questo numero:» senza righe sotto occupa una riga
    // per dire zero, che e' peggio dell'assenza.
    expect(bloccoTooltip([])).toBeNull();
  });

  it('ha un\'intestazione che dice di cosa e\' l\'elenco', () => {
    expect(bloccoTooltip([v({})])!.split('\n')[0]).toBe('Cosa tiene questo numero:');
  });

  it('rispetta l\'ordine che riceve: l\'ordinamento e\' deciso a monte, una volta sola', () => {
    const t = bloccoTooltip([
      v({ id: 'a', label: 'Prima' }), v({ id: 'b', label: 'Seconda' }),
    ])!;
    expect(t.indexOf('Prima')).toBeLessThan(t.indexOf('Seconda'));
  });
});

describe('vociPerNatura', () => {
  it('separa le due nature senza mescolarle', () => {
    const tutte = [
      v({ id: 'm', natura: 'misurato', peso: { entries: 1, memoryMB: 10 } }),
      v({ id: 't', natura: 'trattenuto', peso: { entries: 1 } }),
    ];
    expect(vociPerNatura(tutte, 'misurato').map(x => x.id)).toEqual(['m']);
    expect(vociPerNatura(tutte, 'trattenuto').map(x => x.id)).toEqual(['t']);
  });
});

describe('la ridondanza voci/processi, vista sui dati veri', () => {
  it('«1 voce · 1 processo» non si scrive: e\' lo stesso numero detto due volte', () => {
    const r = rigaVoce(v({
      label: 'Ponte AI', natura: 'misurato',
      peso: { entries: 1, memoryMB: 68, processCount: 1 },
    }));
    expect(r).toBe('Ponte AI: 68 MB · 1 processo');
    expect(r).not.toContain('voce');
  });

  it('vale anche in grande: 24 e 24 restano un numero solo', () => {
    const r = rigaVoce(v({
      label: 'Comandi lanciati dagli agenti', natura: 'misurato',
      peso: { entries: 24, memoryMB: 565, processCount: 24 },
    }));
    expect(r).toBe('Comandi lanciati dagli agenti: 565 MB · 24 processi');
  });

  it('ma quando DIFFERISCONO si dicono entrambi: e\' li\' che sta il dato', () => {
    // Due sessioni con cinque processi sotto: «2 voci, 5 processi» dice una
    // cosa che nessuno dei due numeri da solo direbbe.
    const r = rigaVoce(v({
      label: 'Terminali e sessioni', natura: 'misurato',
      peso: { entries: 2, memoryMB: 749, processCount: 5 },
    }));
    expect(r).toContain('2 voci');
    expect(r).toContain('5 processi');
  });
});
