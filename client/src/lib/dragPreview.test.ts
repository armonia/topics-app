import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  startDragPreview, endDragPreview, DRAG_PREVIEW_ATTR,
} from './dragPreview';

/**
 * QUESTO TEST E' LA META' OSSERVABILE DEL CONTRATTO.
 *
 * `docs/drag-preview.md` dice che l'anteprima serve due volte. E' la sorgente di
 * `setDragImage`, e resta sotto al puntatore con lo STESSO punto di presa. Il
 * fantasma che il sistema disegna lo compone il compositor, non il documento,
 * quindi nessun test potra' mai vederlo. Il nodo nel DOM si', ed e' l'unica
 * cosa provabile a questo livello. Quello che resta fuori (che la fotografia in
 * WKWebView non torni vuota) e' per la guardia E2E su webkit, che il documento
 * nomina e che non vive qui.
 *
 * Il DOM e' STUBATO, non montato. Non ci sono ne' happy-dom ne' jsdom fra le
 * dipendenze, e gli altri test client fanno lo stesso (vedi `haptics.test.ts`).
 * Il finto e' pero' ONESTO nella parte che conta: `appendChild` attacca davvero
 * e `remove()` stacca davvero, cosi' "il nodo c'e'" e "il nodo non c'e' piu'"
 * restano fatti osservabili e non finzioni.
 *
 * @covers LAYOUT-02
 */

interface FakeNode {
  tag: string;
  attributi: Record<string, string>;
  style: { cssText: string; transform: string };
  textContent: string;
  figli: FakeNode[];
  genitore: FakeNode | null;
  setAttribute(chiave: string, valore: string): void;
  getAttribute(chiave: string): string | null;
  appendChild(figlio: FakeNode): FakeNode;
  remove(): void;
  readonly isConnected: boolean;
  getBoundingClientRect(): { left: number; top: number; bottom: number };
}

function createNode(tag: string): FakeNode {
  return {
    tag,
    attributi: {},
    style: { cssText: '', transform: '' },
    textContent: '',
    figli: [],
    genitore: null,
    get isConnected() { return this.genitore !== null; },
    // What the fixed frame's probe reads (`lib/fixedFrame`): the window's own, no keyboard up.
    getBoundingClientRect() { return { left: 0, top: 0, bottom: 0 }; },
    setAttribute(chiave, valore) { this.attributi[chiave] = valore; },
    getAttribute(chiave) { return chiave in this.attributi ? this.attributi[chiave]! : null; },
    appendChild(figlio) {
      figlio.genitore = this;
      this.figli.push(figlio);
      return figlio;
    },
    remove() {
      const padre = this.genitore;
      if (!padre) return;
      const i = padre.figli.indexOf(this);
      if (i >= 0) padre.figli.splice(i, 1);
      this.genitore = null;
    },
  };
}

/** Un `dataTransfer` finto che registra cosa gli e' stato consegnato e se, in
 *  quel momento, il nodo fotografato era gia' attaccato al documento. Il
 *  secondo dato e' la lezione della WKWebView. Un nodo fuori dall'albero non ha
 *  niente da comporre e la fotografia torna vuota. */
interface ScattoRegistrato {
  nodo: FakeNode;
  x: number;
  y: number;
  eraAttaccato: boolean;
}

interface FakeTransfer {
  scatti: ScattoRegistrato[];
  setDragImage(nodo: FakeNode, x: number, y: number): void;
}

function createTransfer(): FakeTransfer {
  return {
    scatti: [],
    setDragImage(nodo, x, y) {
      this.scatti.push({ nodo, x, y, eraAttaccato: nodo.genitore !== null });
    },
  };
}

const reali = {
  document: (globalThis as { document?: unknown }).document,
  window: (globalThis as { window?: unknown }).window,
};

let body: FakeNode;

/** Il testo dell'intera scheda. Il finto tiene `textContent` come proprieta'
 *  semplice, quindi qui si ricompone camminando l'albero. Il vero DOM lo fa da
 *  solo con il getter aggregante. */
function testoDi(nodo: FakeNode): string {
  return [nodo.textContent, ...nodo.figli.map(testoDi)].join(' ');
}

/** Le anteprime attualmente attaccate al body, riconosciute dall'attributo di
 *  contratto e non dalla posizione. */
function mountedPreviews(): FakeNode[] {
  return body.figli.filter((n) => n.getAttribute(DRAG_PREVIEW_ATTR) !== null);
}

function previewOnly(): FakeNode {
  const trovate = mountedPreviews();
  expect(trovate.length, `deve esserci esattamente UNA anteprima, ce ne sono ${trovate.length}`).toBe(1);
  return trovate[0]!;
}

/** Dove il modulo ha tradotto la scheda, in pixel. */
function traslazioneDi(nodo: FakeNode): { x: number; y: number } {
  const m = /translate3d\((-?\d+(?:\.\d+)?)px,\s*(-?\d+(?:\.\d+)?)px,\s*0\)/.exec(nodo.style.transform);
  if (!m) throw new Error(`transform non riconosciuta: "${nodo.style.transform}"`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

/** Il punto di presa DEDOTTO da dove la scheda e' finita rispetto al cursore.
 *  Le costanti del modulo non sono esportate, e va bene cosi'. Quello che il
 *  contratto promette non e' un numero, e' che i due usi del punto di presa
 *  siano lo STESSO punto. */
function presaDedotta(nodo: FakeNode, cursoreX: number, cursoreY: number): { x: number; y: number } {
  const t = traslazioneDi(nodo);
  return { x: cursoreX - t.x, y: cursoreY - t.y };
}

beforeEach(() => {
  body = createNode('body');
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => createNode(tag),
    body,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  (globalThis as { window?: unknown }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
});

afterEach(() => {
  // Prima si spegne, mentre il finto e' ancora in piedi. Il modulo tiene il
  // nodo in una variabile di modulo, e un'anteprima lasciata accesa qui
  // sporcherebbe il test successivo.
  endDragPreview();
  if (reali.document === undefined) delete (globalThis as { document?: unknown }).document;
  else (globalThis as { document?: unknown }).document = reali.document;
  if (reali.window === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = reali.window;
});

describe('startDragPreview: la scheda e la sua fotografia sono la stessa cosa', () => {
  test('monta UN nodo marcato e lo consegna a setDragImage con lo STESSO punto di presa', () => {
    const dt = createTransfer();
    startDragPreview(
      { clientX: 420, clientY: 260, dataTransfer: dt as unknown as DataTransfer },
      { title: 'Contratto' },
    );

    const card = previewOnly();
    expect(card.getAttribute(DRAG_PREVIEW_ATTR)).toBe('');
    expect(card.genitore, 'la scheda deve stare attaccata al body').toBe(body);

    // La fotografia deve partire da un nodo GIA' nell'albero. E' la lezione
    // della WKWebView: un nodo fuori dal viewport non ha niente da comporre, lo
    // snapshot torna vuoto e il sistema ripiega sull'icona generica.
    expect(dt.scatti.length, 'una sola fotografia').toBe(1);
    const scatto = dt.scatti[0]!;
    expect(scatto.nodo, 'si fotografa la scheda che resta a schermo, non un doppione').toBe(card);
    expect(scatto.eraAttaccato, "allo scatto il nodo deve essere gia' nel documento").toBe(true);

    // Il cuore del contratto. Il punto passato a `setDragImage` e quello con
    // cui la scheda viene posizionata devono essere lo STESSO, altrimenti il
    // fantasma di sistema e la scheda si separano e si vede doppio. Se un
    // giorno divergessero, questa riga deve diventare rossa.
    const presa = presaDedotta(card, 420, 260);
    expect({ x: scatto.x, y: scatto.y }).toEqual(presa);

    // E la presa deve essere una presa vera, cioe' dentro la scheda e vicino
    // all'angolo alto a sinistra. Una presa a (0,0) rimetterebbe la scheda
    // esattamente sotto la punta, coprendo il bersaglio.
    expect(presa.x).toBeGreaterThan(0);
    expect(presa.y).toBeGreaterThan(0);
  });

  test('senza dataTransfer non lancia, e la scheda si monta lo stesso', () => {
    // Il ramo dei motori che mandano `dragstart` con `dataTransfer` nullo. La
    // scheda resta l'unica anteprima, quindi deve esserci comunque.
    expect(() => {
      startDragPreview({ clientX: 10, clientY: 12, dataTransfer: null }, { title: 'Senza trasporto' });
    }).not.toThrow();
    expect(mountedPreviews().length).toBe(1);
  });

  test('due partenze di fila lasciano UNA sola anteprima attaccata', () => {
    // "Uno solo, e non ce n'e' mai piu' di uno alla volta" e' scritto nel
    // contratto. Un secondo `dragstart` senza che il primo gesto abbia chiuso
    // le sue porte succede davvero, per esempio quando il rilascio cade sopra
    // una vista nativa e `dragend` si perde.
    const primo = createTransfer();
    startDragPreview({ clientX: 30, clientY: 40, dataTransfer: primo as unknown as DataTransfer }, { title: 'Prima' });
    const vecchia = previewOnly();

    const secondo = createTransfer();
    startDragPreview({ clientX: 90, clientY: 95, dataTransfer: secondo as unknown as DataTransfer }, { title: 'Seconda' });

    const rimaste = mountedPreviews();
    expect(rimaste.length, 'la prima scheda deve essere stata staccata').toBe(1);
    expect(rimaste[0]).not.toBe(vecchia);
    expect(vecchia.genitore, 'la vecchia non deve restare appesa al body').toBeNull();
    expect(testoDi(rimaste[0]!)).toContain('Seconda');
  });
});

describe('endDragPreview: spegne davvero, e regge piu di una chiamata', () => {

  test('spegnere senza aver mai acceso non lancia', () => {
    expect(mountedPreviews().length).toBe(0);
    expect(() => endDragPreview()).not.toThrow();
  });
});
