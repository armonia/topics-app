/**
 * I DUE MODI DI SBAGLIARE UNA RIGA DI PRESENZA, e il test che li tiene fermi.
 *
 *  1. CONTARE TE STESSO. La riga risponde a «chi ALTRO c'e'»: chi lavora da
 *     solo con due macchine deve leggere «nessuno», non «1 online». Vale per il
 *     numero e vale per le facce, che sono la stessa domanda disegnata.
 *  2. LA STESSA PERSONA DUE VOLTE. Chi sta in due organizzazioni con te e' una
 *     persona sola: la riga degli amici unisce i gruppi, e senza la dedup la
 *     stessa faccia comparirebbe due volte accanto a se stessa.
 *
 * L'ordine e' parte del contratto: chi si e' fatto vivo per ultimo per primo.
 * Un elenco che si riordina a ogni giro di rete e' un elenco in cui non si
 * riconosce piu' nessuno.
 */
import { describe, it, expect } from 'bun:test';
import { presentiOra, facceOnline, unisciFacce, PRESENZA_MS } from './orgPresence';

const ADESSO = 1_700_000_000_000;
const poco = ADESSO - 60_000;
const tanto = ADESSO - PRESENZA_MS - 1;

const membri = [
  { id: 'io', lastSeenAt: ADESSO },
  { id: 'a', lastSeenAt: poco },
  { id: 'b', lastSeenAt: ADESSO - 10_000 },
  { id: 'c', lastSeenAt: tanto },
  { id: 'd', lastSeenAt: null },
];

const rubrica = [
  { id: 'io', displayName: 'Io Stesso', github: { avatarUrl: 'io.png' } },
  { id: 'a', displayName: 'Anna Rossi', github: { avatarUrl: 'a.png' } },
  { id: 'b', displayName: 'Bruno Verdi', github: null },
];

describe('presentiOra', () => {
  it('non conta te, ne chi non si vede da piu' + '\u2019' + ' di cinque minuti', () => {
    expect(presentiOra(membri, 'io', ADESSO)).toBe(2);
  });

  it('senza sapere chi sei non spara un numero', () => {
    expect(presentiOra(membri, null, ADESSO)).toBe(0);
  });
});

describe('facceOnline', () => {
  it('da le facce di chi c e ora, il piu recente per primo', () => {
    const facce = facceOnline(membri, rubrica, 'io', ADESSO);
    expect(facce.map((f) => f.id)).toEqual(['b', 'a']);
    expect(facce[0].nome).toBe('Bruno Verdi');
    expect(facce[0].avatarUrl).toBeNull();
    expect(facce[0].iniziali).toBe('BV');
    expect(facce[1].avatarUrl).toBe('a.png');
  });

  it('non mette mai te per primo nell elenco di chi altro c e', () => {
    expect(facceOnline(membri, rubrica, 'io', ADESSO).some((f) => f.id === 'io')).toBe(false);
    expect(facceOnline(membri, rubrica, null, ADESSO)).toEqual([]);
  });

  it('ripiega sul nome dei membri quando la rubrica non ha ancora risposto', () => {
    const facce = facceOnline([{ id: 'z', lastSeenAt: poco, name: 'Zeta Uno' }], [], 'io', ADESSO);
    expect(facce.map((f) => `${f.nome}/${f.iniziali}`)).toEqual(['Zeta Uno/ZU']);
  });

  it('un ultimo accesso nel futuro conta come presente', () => {
    const facce = facceOnline([{ id: 'f', lastSeenAt: ADESSO + 60_000 }], rubrica, 'io', ADESSO);
    expect(facce.map((f) => f.id)).toEqual(['f']);
  });
});

describe('unisciFacce', () => {
  it('la stessa persona in due organizzazioni resta una faccia sola', () => {
    const a = { id: 'a', nome: 'Anna Rossi', avatarUrl: null, iniziali: 'AR' };
    const b = { id: 'b', nome: 'Bruno Verdi', avatarUrl: null, iniziali: 'BV' };
    expect(unisciFacce([[a, b], [a]]).map((f) => f.id)).toEqual(['a', 'b']);
  });
});
