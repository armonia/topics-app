/**
 * THE TWO WAYS A PRESENCE ROW CAN LIE, and the test that pins them down.
 *
 *  1. COUNTING YOURSELF. The row answers "who ELSE is here": somebody working
 *     alone on two machines must read "nobody", not "1 online". It holds for
 *     the number and it holds for the faces, which are the same question drawn.
 *  2. THE SAME PERSON TWICE. Somebody who shares two organisations with you is
 *     one single person: the friends row merges the groups, and without the
 *     dedup the same face would turn up twice, right next to itself.
 *
 * The order is part of the contract: whoever showed up last comes first. A list
 * that reshuffles on every network round trip is a list in which nobody is
 * recognisable any more.
  *
 * @covers STATUSLINE-01
 */
import { describe, it, expect } from 'bun:test';
import { presentiOra, facceOnline, mergeFaces, gentePresenza, mergePeople, PRESENZA_MS } from './orgPresence';

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
    const faces = facceOnline(membri, rubrica, 'io', ADESSO);
    expect(faces.map((f) => f.id)).toEqual(['b', 'a']);
    expect(faces[0].nome).toBe('Bruno Verdi');
    expect(faces[0].avatarUrl).toBeNull();
    expect(faces[0].iniziali).toBe('BV');
    expect(faces[1].avatarUrl).toBe('a.png');
  });

  it('non mette mai te per primo nell elenco di chi altro c e', () => {
    expect(facceOnline(membri, rubrica, 'io', ADESSO).some((f) => f.id === 'io')).toBe(false);
    expect(facceOnline(membri, rubrica, null, ADESSO)).toEqual([]);
  });

  it('ripiega sul nome dei membri quando la rubrica non ha ancora risposto', () => {
    const faces = facceOnline([{ id: 'z', lastSeenAt: poco, name: 'Zeta Uno' }], [], 'io', ADESSO);
    expect(faces.map((f) => `${f.nome}/${f.iniziali}`)).toEqual(['Zeta Uno/ZU']);
  });

  it('un ultimo accesso nel futuro conta come presente', () => {
    const faces = facceOnline([{ id: 'f', lastSeenAt: ADESSO + 60_000 }], rubrica, 'io', ADESSO);
    expect(faces.map((f) => f.id)).toEqual(['f']);
  });
});

describe('unisciFacce', () => {
  it('la stessa persona in due organizzazioni resta una faccia sola', () => {
    const a = { id: 'a', nome: 'Anna Rossi', avatarUrl: null, iniziali: 'AR' };
    const b = { id: 'b', nome: 'Bruno Verdi', avatarUrl: null, iniziali: 'BV' };
    expect(mergeFaces([[a, b], [a]]).map((f) => f.id)).toEqual(['a', 'b']);
  });
});

/**
 * THE OPEN LIST has a contract DIFFERENT from the closed row, and that is where
 * it is easy to go wrong: the row shows who is here, the panel shows EVERYONE.
 * Whoever is offline is not a case to filter away, they are half the reason the
 * panel gets opened at all: looking somebody up who is not here right now.
 */
describe('gentePresenza', () => {
  it('tiene anche gli assenti, ma i presenti stanno in cima', () => {
    const righe = gentePresenza(membri, rubrica, 'io', ADESSO);
    // The present ones by last seen (b more recent than a), then the absent:
    // `c` was seen a while back, `d` is unknown (null), which sinks to the end.
    expect(righe.map((r) => r.id)).toEqual(['b', 'a', 'c', 'd']);
    expect(righe.map((r) => r.presente)).toEqual([true, true, false, false]);
  });

  it('te stesso non entri nel tuo elenco', () => {
    expect(gentePresenza(membri, rubrica, 'io', ADESSO).some((r) => r.id === 'io')).toBe(false);
  });

  it('senza sapere chi sei non risponde: la prima riga saresti tu', () => {
    expect(gentePresenza(membri, rubrica, null, ADESSO)).toEqual([]);
  });
});

describe('unisciGente', () => {
  it('la stessa persona online in un gruppo e spenta nell' + '\u2019' + 'altro conta come presente', () => {
    // Saying "offline" about somebody who is typing is the worse of the two
    // mistakes: it is the one that makes people stop writing to them.
    const spenta = { id: 'a', nome: 'Anna Rossi', avatarUrl: null, iniziali: 'AR', presente: false, vistoA: tanto };
    const accesa = { id: 'a', nome: 'Anna Rossi', avatarUrl: null, iniziali: 'AR', presente: true, vistoA: poco };
    expect(mergePeople([[spenta], [accesa]]).map((r) => r.presente)).toEqual([true]);
  });

  it('non ripete chi sta in due organizzazioni', () => {
    const a = { id: 'a', nome: 'Anna Rossi', avatarUrl: null, iniziali: 'AR', presente: true, vistoA: poco };
    const b = { id: 'b', nome: 'Bruno Verdi', avatarUrl: null, iniziali: 'BV', presente: false, vistoA: tanto };
    expect(mergePeople([[a, b], [a]]).map((r) => r.id)).toEqual(['a', 'b']);
  });
});
