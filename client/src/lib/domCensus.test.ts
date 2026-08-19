/**
 * Il censimento e' lo STRUMENTO DI MISURA della card: se sbaglia a contare, il
 * "prima" e il "dopo" non sono una prova, sono due numeri. Quindi qui si
 * verifica che attribuisca ogni `<svg>` al proprietario giusto — non che sia
 * veloce, non che il totale sia un certo numero.
 *
 * Perche' un documento finto e non uno vero: jsdom e happy-dom non sono
 * dipendenze di questo progetto (stessa scelta di `Shared/Toast.test.ts`), e
 * sotto `bun test` `document` e' `undefined`. Il finto qui sotto implementa
 * esattamente i quattro pezzi che `domCensus` tocca, il che rende anche
 * esplicito quanto poco della DOM API serva davvero.
 */
import { describe, test, expect } from 'bun:test';
import { domCensus } from './devHeapProbe';

/** Un elemento finto: quanto basta a `closest` e a `parentElement.className`. */
function elemento(testid: string | null, classePadre = 'anonima'): Element {
  return {
    closest: (sel: string) =>
      sel === '[data-testid]' && testid !== null
        ? ({ getAttribute: () => testid } as unknown as Element)
        : null,
    parentElement: { className: classePadre },
  } as unknown as Element;
}

/** Un documento finto con dentro esattamente questi `<svg>`. */
function documento(svgs: Element[], nodiTotali = 100): Document {
  return {
    querySelectorAll: () => svgs as unknown as NodeListOf<Element>,
    getElementsByTagName: () => ({ length: nodiTotali }),
  } as unknown as Document;
}

describe('domCensus', () => {
  test('conta gli svg vivi nel documento', () => {
    const c = domCensus(documento([elemento('a'), elemento('b'), elemento('c')]));
    expect(c.svg).toBe(3);
  });

  test('raggruppa per data-testid: il totale dice CHE cresce, questo dice CHI', () => {
    const c = domCensus(
      documento([elemento('riga'), elemento('riga'), elemento('sidebar')]),
    );
    expect(c.perOwner).toEqual({ riga: 2, sidebar: 1 });
  });

  test('ordina per conteggio decrescente: la testa e la diagnosi', () => {
    const svgs = [
      elemento('poco'),
      ...Array.from({ length: 5 }, () => elemento('tanto')),
      elemento('medio'),
      elemento('medio'),
    ];
    // Chi legge il campione guarda la prima riga: se l'ordine non fosse
    // garantito, il colpevole potrebbe finire in fondo alla lista.
    expect(Object.keys(domCensus(documento(svgs)).perOwner)[0]).toBe('tanto');
  });

  test('senza testid ripiega sulla classe del padre, e non si perde il nodo', () => {
    const c = domCensus(documento([elemento(null, 'icona-riga'), elemento(null, 'icona-riga')]));
    // Non identifica il componente, ma raggruppa le occorrenze dello stesso:
    // un conteggio che sale sotto una chiave sola resta leggibile.
    expect(c.svg).toBe(2);
    expect(Object.values(c.perOwner)).toEqual([2]);
  });

  test('un documento senza svg da zero, non un errore', () => {
    const c = domCensus(documento([]));
    expect(c.svg).toBe(0);
    expect(c.perOwner).toEqual({});
  });

  test('tiene i nodi totali, per distinguere "crescono gli svg" da "cresce tutto"', () => {
    expect(domCensus(documento([elemento('x')], 4242)).nodes).toBe(4242);
  });

  test('fuori dal browser risponde vuoto invece di esplodere', () => {
    // La sonda gira anche dove non c'e' un documento: deve tacere, non rompere
    // il campione e con esso tutta la serie.
    expect(domCensus(undefined)).toEqual({ svg: 0, nodes: 0, perOwner: {} });
  });
});
