import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  startDragPreview,
  startTouchDragPreview,
  moveDragPreview,
  endDragPreview,
  dragPreviewActive,
  DRAG_PREVIEW_ATTR,
  DROP_ACTIVE_ATTR,
  type DropIntent,
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

interface NodoFinto {
  tag: string;
  attributi: Record<string, string>;
  style: { cssText: string; transform: string };
  textContent: string;
  figli: NodoFinto[];
  genitore: NodoFinto | null;
  setAttribute(chiave: string, valore: string): void;
  getAttribute(chiave: string): string | null;
  appendChild(figlio: NodoFinto): NodoFinto;
  remove(): void;
}

function creaNodo(tag: string): NodoFinto {
  return {
    tag,
    attributi: {},
    style: { cssText: '', transform: '' },
    textContent: '',
    figli: [],
    genitore: null,
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
  nodo: NodoFinto;
  x: number;
  y: number;
  eraAttaccato: boolean;
}

interface TrasferimentoFinto {
  scatti: ScattoRegistrato[];
  setDragImage(nodo: NodoFinto, x: number, y: number): void;
}

function creaTrasferimento(): TrasferimentoFinto {
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

let body: NodoFinto;

/** Il testo dell'intera scheda. Il finto tiene `textContent` come proprieta'
 *  semplice, quindi qui si ricompone camminando l'albero. Il vero DOM lo fa da
 *  solo con il getter aggregante. */
function testoDi(nodo: NodoFinto): string {
  return [nodo.textContent, ...nodo.figli.map(testoDi)].join(' ');
}

/** Le anteprime attualmente attaccate al body, riconosciute dall'attributo di
 *  contratto e non dalla posizione. */
function anteprimeMontate(): NodoFinto[] {
  return body.figli.filter((n) => n.getAttribute(DRAG_PREVIEW_ATTR) !== null);
}

function anteprimaSola(): NodoFinto {
  const trovate = anteprimeMontate();
  expect(trovate.length, `deve esserci esattamente UNA anteprima, ce ne sono ${trovate.length}`).toBe(1);
  return trovate[0]!;
}

/** Dove il modulo ha tradotto la scheda, in pixel. */
function traslazioneDi(nodo: NodoFinto): { x: number; y: number } {
  const m = /translate3d\((-?\d+(?:\.\d+)?)px,\s*(-?\d+(?:\.\d+)?)px,\s*0\)/.exec(nodo.style.transform);
  if (!m) throw new Error(`transform non riconosciuta: "${nodo.style.transform}"`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

/** Il punto di presa DEDOTTO da dove la scheda e' finita rispetto al cursore.
 *  Le costanti del modulo non sono esportate, e va bene cosi'. Quello che il
 *  contratto promette non e' un numero, e' che i due usi del punto di presa
 *  siano lo STESSO punto. */
function presaDedotta(nodo: NodoFinto, cursoreX: number, cursoreY: number): { x: number; y: number } {
  const t = traslazioneDi(nodo);
  return { x: cursoreX - t.x, y: cursoreY - t.y };
}

beforeEach(() => {
  body = creaNodo('body');
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => creaNodo(tag),
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
    const dt = creaTrasferimento();
    startDragPreview(
      { clientX: 420, clientY: 260, dataTransfer: dt as unknown as DataTransfer },
      { title: 'Contratto' },
    );

    const card = anteprimaSola();
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
    expect(dragPreviewActive()).toBe(true);
    expect(anteprimeMontate().length).toBe(1);
  });

  test('due partenze di fila lasciano UNA sola anteprima attaccata', () => {
    // "Uno solo, e non ce n'e' mai piu' di uno alla volta" e' scritto nel
    // contratto. Un secondo `dragstart` senza che il primo gesto abbia chiuso
    // le sue porte succede davvero, per esempio quando il rilascio cade sopra
    // una vista nativa e `dragend` si perde.
    const primo = creaTrasferimento();
    startDragPreview({ clientX: 30, clientY: 40, dataTransfer: primo as unknown as DataTransfer }, { title: 'Prima' });
    const vecchia = anteprimaSola();

    const secondo = creaTrasferimento();
    startDragPreview({ clientX: 90, clientY: 95, dataTransfer: secondo as unknown as DataTransfer }, { title: 'Seconda' });

    const rimaste = anteprimeMontate();
    expect(rimaste.length, 'la prima scheda deve essere stata staccata').toBe(1);
    expect(rimaste[0]).not.toBe(vecchia);
    expect(vecchia.genitore, 'la vecchia non deve restare appesa al body').toBeNull();
    expect(testoDi(rimaste[0]!)).toContain('Seconda');
  });

  test('anche col DITO due sollevamenti di fila lasciano UNA sola anteprima', () => {
    // Il gemello del test qui sopra sul ramo touch, e qui la posta e' piu'
    // alta: su iOS non c'e' nessun fantasma di sistema, quindi il nodo del
    // modulo E' l'anteprima. Un secondo sollevamento senza che il primo abbia
    // chiuso lascerebbe una scheda incollata sopra l'interfaccia, e nessuna
    // delle cinque porte la staccherebbe piu' perche' il modulo ha smesso di
    // tenerla. Due long press di fila su due tessere diverse e' proprio il
    // gesto che lo produce.
    startTouchDragPreview({ title: 'Prima' }, 30, 40);
    const vecchia = anteprimaSola();

    startTouchDragPreview({ title: 'Seconda' }, 90, 95);

    const rimaste = anteprimeMontate();
    expect(rimaste.length, 'la prima scheda deve essere stata staccata').toBe(1);
    expect(rimaste[0]).not.toBe(vecchia);
    expect(vecchia.genitore, 'la vecchia non deve restare appesa al body').toBeNull();
    expect(testoDi(rimaste[0]!)).toContain('Seconda');
  });
});

describe('il ramo del dito: nessun fantasma di sistema, la scheda e tutto', () => {
  test('startTouchDragPreview monta senza nessun dataTransfer, e dragPreviewActive() lo dice', () => {
    // Su iOS il drag HTML5 non esiste, il gesto e' un long press: qui non c'e'
    // nessun `dataTransfer` a cui passare il nodo, e quindi questa scheda e'
    // l'UNICA anteprima che l'utente vedra'.
    expect(dragPreviewActive()).toBe(false);
    startTouchDragPreview({ title: 'Col dito' }, 300, 220);
    expect(dragPreviewActive()).toBe(true);
    expect(anteprimaSola().getAttribute(DRAG_PREVIEW_ATTR)).toBe('');
  });

  test('il dito e il mouse tengono la scheda nello stesso punto', () => {
    // Due rami diversi che posizionano la stessa scheda. Se uno dei due
    // cambiasse presa, sullo stesso dispositivo la scheda salterebbe fra mouse
    // e dito, e su iOS finirebbe sotto il pollice invece che accanto.
    const dt = creaTrasferimento();
    startDragPreview({ clientX: 512, clientY: 333, dataTransfer: dt as unknown as DataTransfer }, { title: 'X' });
    const conMouse = anteprimaSola().style.transform;

    endDragPreview();
    startTouchDragPreview({ title: 'X' }, 512, 333);
    expect(anteprimaSola().style.transform).toBe(conMouse);
  });

  test('moveDragPreview sposta il nodo, e lo sposta dove dicono le coordinate nuove', () => {
    startTouchDragPreview({ title: 'Trascinata' }, 100, 100);
    const card = anteprimaSola();
    const prima = traslazioneDi(card);

    moveDragPreview(160, 210);
    const dopo = traslazioneDi(card);

    expect(dopo).not.toEqual(prima);
    // Non basta che sia cambiata. Deve essere cambiata DELLA STESSA quantita'
    // di cui si sono mosse le coordinate, altrimenti la scheda deriva rispetto
    // al dito man mano che il gesto continua.
    expect(dopo.x - prima.x).toBe(60);
    expect(dopo.y - prima.y).toBe(110);
  });
});

describe('endDragPreview: spegne davvero, e regge piu di una chiamata', () => {
  test('stacca il nodo dal documento e dragPreviewActive() torna false', () => {
    startTouchDragPreview({ title: 'Da spegnere' }, 50, 60);
    const card = anteprimaSola();

    endDragPreview();

    expect(dragPreviewActive()).toBe(false);
    expect(card.genitore, "una scheda rimasta appesa sarebbe incollata sopra l'interfaccia").toBeNull();
    expect(anteprimeMontate().length).toBe(0);
  });

  test('chiamarlo due volte non lancia, e la seconda non fa danni', () => {
    // Le porte di spegnimento sono cinque, e scattano anche tutte insieme:
    // `dragend`, `drop`, `blur`, `pointerup` e il `pointermove` senza bottone.
    // Un gesto che finisce su due porte diverse chiama questa funzione due
    // volte, e se non fosse idempotente il secondo giro lancerebbe.
    startTouchDragPreview({ title: 'Doppio spegnimento' }, 5, 5);
    endDragPreview();
    expect(() => endDragPreview()).not.toThrow();
    expect(dragPreviewActive()).toBe(false);
    expect(anteprimeMontate().length).toBe(0);
  });

  test('spegnere senza aver mai acceso non lancia', () => {
    expect(dragPreviewActive()).toBe(false);
    expect(() => endDragPreview()).not.toThrow();
  });
});

describe('la scheda mostra la cosa che si ha in mano', () => {
  test('titolo, sottotitolo, icona e badge finiscono nel testo del nodo', () => {
    // E' la meta' della segnalazione: "non si vede cosa ho in mano". Il giorno
    // in cui l'anteprima perdesse il sottotitolo, cioe' il contesto (percorso,
    // progetto, colonna, URL), la scheda tornerebbe a essere un'etichetta e
    // senza questa asserzione resterebbe tutto verde.
    startTouchDragPreview({
      title: 'Rifare il drop',
      subtitle: 'topics-app / In revisione',
      icon: '\u{1F4CC}',
      badges: ['bugfix', 'p1'],
    }, 0, 0);

    const testo = testoDi(anteprimaSola());
    expect(testo).toContain('Rifare il drop');
    expect(testo).toContain('topics-app / In revisione');
    expect(testo).toContain('\u{1F4CC}');
    expect(testo).toContain('bugfix');
    expect(testo).toContain('p1');
  });

  test('con il solo titolo non compaiono righe vuote', () => {
    // Il contrario dello stesso contratto. `subtitle` e `badges` sono
    // opzionali, e una scheda che disegnasse comunque le loro scatole avrebbe
    // due righe di aria sotto al nome.
    startTouchDragPreview({ title: 'Solo nome' }, 0, 0);
    expect(testoDi(anteprimaSola()).trim()).toBe('Solo nome');
  });
});

describe('il bersaglio si dichiara: nome dell attributo e quattro intenti', () => {
  // I quattro intenti, dichiarati come mappa ESAUSTIVA sul tipo. Se un domani
  // il contratto ne aggiungesse un quinto, questo oggetto non compilerebbe piu'
  // finche' non gli si scrive accanto la regola che lo disegna.
  const INTENTI: Record<DropIntent, true> = { into: true, before: true, after: true, split: true };
  const css = readFileSync(join(import.meta.dir, '..', 'index.css'), 'utf8');

  test('DROP_ACTIVE_ATTR e il nome che il foglio di stile aggancia', () => {
    // La costante e il selettore sono le due meta' della stessa cosa, e stanno
    // in due file diversi. Chi rinominasse la costante non romperebbe niente in
    // TypeScript: la regola CSS smetterebbe semplicemente di agganciarsi, in
    // silenzio, e il bersaglio tornerebbe invisibile mentre il drop continua a
    // funzionare. E' esattamente il guasto che questa asserzione prende.
    expect(DROP_ACTIVE_ATTR).toBe('data-drop-active');
    expect(css, "index.css deve avere la regola base sull'attributo").toContain(`[${DROP_ACTIVE_ATTR}]`);
  });

  test('DRAG_PREVIEW_ATTR e il nome che le altre superfici scrivono a mano', () => {
    // Stesso guasto del gemello qui sopra, e qui il duplicato e' nel codice di
    // produzione: due superfici disegnano la LORO anteprima con la cosa vera
    // (la tessera dei fissati, la card della board) e si marcano scrivendo
    // l'attributo a mano, perche' non passano dalla funzione che lo mette. Una
    // rinomina della costante le lascerebbe indietro con il nome vecchio, e
    // lascerebbe indietro il selettore che il documento assegna alla guardia
    // E2E. Il resto del test cerca il nodo TRAMITE la costante, quindi si
    // sposterebbe insieme a lei e non se ne accorgerebbe.
    expect(DRAG_PREVIEW_ATTR).toBe('data-drag-preview');
    for (const superficie of [
      '../components/Sidebar/PinnedTiles.tsx',
      '../components/Board/KanbanBoardPane.tsx',
    ]) {
      const sorgente = readFileSync(join(import.meta.dir, superficie), 'utf8');
      expect(sorgente, `${superficie} marca la sua anteprima con l'attributo del contratto`)
        .toContain(DRAG_PREVIEW_ATTR);
    }
  });

  test('ognuno dei quattro intenti ha una regola sua in index.css', () => {
    // Non sono lo stesso atterraggio: `into` entra dentro, `before`/`after` si
    // inseriscono accanto, `split` taglia in due. Un intento senza disegno e' un
    // valore che non si vede, cioe' un bersaglio muto.
    // Il conteggio non si asserisce: `Record<DropIntent, true>` lo impone gia'
    // in compilazione, e un `toBe(4)` su un letterale scritto qui sopra non
    // potrebbe diventare rosso per nessuna modifica al codice di produzione.
    const intenti = Object.keys(INTENTI) as DropIntent[];
    const senzaRegola = intenti.filter((intento) => {
      const selettori = [
        `[${DROP_ACTIVE_ATTR}='${intento}']`,
        `[${DROP_ACTIVE_ATTR}="${intento}"]`,
        `[${DROP_ACTIVE_ATTR}=${intento}]`,
      ];
      return !selettori.some((s) => css.includes(s));
    });
    expect(senzaRegola, 'intenti senza nessuna regola nel foglio di stile').toEqual([]);
  });
});
