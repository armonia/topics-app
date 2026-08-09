import { describe, expect, test } from 'bun:test';
import {
  CHROME_ROW_ACTION_INSET,
  CHROME_ROW_ACTION_INSET_LEFT,
  CHROME_ROW_ACTION_RESERVE,
  CHROME_ROW_ACTION_RESERVE_LEFT,
  CHROME_ROW_CONTENT_H,
  COLUMN_GAP,
  ROW_ACTION_BOX,
  ROW_ACTION_BOX_PX,
  ROW_INSET,
  TAB_GAP_CLASS,
  chromeRowInset,
  sidebarRowCard,
} from './selectionStyles';

/**
 * I NUMERI DELLA RIGA DI CHROME, RILETTI INVECE CHE RACCONTATI.
 *
 * `CHROME_ROW_ACTION_INSET` e compagni sono LETTERALI Tailwind, e devono
 * restarlo: Tailwind genera le utility leggendo i sorgenti come testo, quindi
 * un `right-[${n}px]` composto a runtime non produce nessuna regola e il
 * bottone finisce a `right: 0` senza che niente lo dica. Il prezzo del
 * letterale è che l'aritmetica che lo giustifica vive in un commento — e un
 * commento non diventa rosso.
 *
 * Questo file è il prezzo pagato: ricalcola l'incasso da `chromeRowInset` e lo
 * confronta con la stringa. Se qualcuno cambia l'altezza della riga, il box del
 * comando o uno dei letterali, i tre si separano QUI invece che sullo schermo
 * di Attilio — che è il difetto da cui questa tornata è partita: «la spaziatura
 * a destra dovrebbe essere uguale a quella che ha sopra e sotto», misurata
 * 5,5/5,5/6 col mouse e 1,5/1,5/6 col dito.
 */

/** La scala di Tailwind: `n` vale `n × 0.25rem`, cioè `n × 4px`. */
const STEP_PX = 4;

/**
 * Il valore che vince per una proprietà, sulle due larghezze.
 *
 * Legge sia le classi della scala (`w-7`) sia i valori arbitrari
 * (`right-[5.5px]`): sono le due forme in cui queste misure sono scritte, e
 * mescolarle è proprio ciò che rende facile perderne una di vista.
 */
function risolvi(classes: string, prop: string): { wide: number; compact: number } {
  let nuda: number | null = null;
  let md: number | null = null;
  let maxMd: number | null = null;
  for (const cls of classes.split(/\s+/).filter(Boolean)) {
    const m = new RegExp(`^(?:(md|max-md):)?${prop}-(?:\\[(\\d+(?:\\.\\d+)?)px\\]|(\\d+(?:\\.\\d+)?))$`).exec(cls);
    if (!m) continue;
    const px = m[2] !== undefined ? Number(m[2]) : Number(m[3]) * STEP_PX;
    if (m[1] === 'md') md = px;
    else if (m[1] === 'max-md') maxMd = px;
    else nuda = px;
  }
  const wide = md ?? nuda;
  const compact = maxMd ?? nuda;
  if (wide === null || compact === null) {
    throw new Error(`nessuna misura '${prop}-' leggibile in "${classes}"`);
  }
  return { wide, compact };
}

describe('la riga di chrome e il comando in coda', () => {
  test('ROW_ACTION_BOX_PX dice davvero i pixel di ROW_ACTION_BOX', () => {
    // La coppia in pixel esiste solo perché l'aritmetica non può leggere una
    // classe. Se diverge dalla classe, ogni conto qui sotto è su un box che
    // non esiste.
    const h = risolvi(ROW_ACTION_BOX, 'h');
    expect(h).toEqual({ wide: ROW_ACTION_BOX_PX.desktop, compact: ROW_ACTION_BOX_PX.touch });
    // Quadrato: l'incasso vale su tre lati solo se lo è.
    expect(risolvi(ROW_ACTION_BOX, 'w')).toEqual(h);
  });

  test("il comando lascia alla riga la stessa aria della tab che gli sta accanto", () => {
    // Il verticale non si sceglie: (40 − box)/2. Vale per il comando come per
    // la tab, quindi i due respirano uguale SOLO se hanno la stessa misura sullo
    // stesso breakpoint — che è il difetto vero dietro «il + e apri sidebar
    // dovrebbero avere aria intorno uguale, anche rispetto alle tab» (Attilio,
    // 09/08): il comando seguiva `md:` e la tab un `isTouch` in JS, quindi in
    // una finestra stretta senza touch erano 36 e 28 nella stessa riga.
    //
    // `TAB_H` ricopia la classe della tab (PaneTabBar), che non è esportabile
    // — sta dentro un template con dieci altre cose. È una copia, e il suo
    // prezzo è dichiarato: se qualcuno cambia l'altezza della tab senza toccare
    // qui, questo test resta verde su una bugia. Ciò che NON può più succedere
    // in silenzio è il disaccordo di meccanismo, perché entrambe le stringhe
    // ora si leggono con lo stesso risolutore di breakpoint.
    const TAB_H = 'h-9 md:h-7';
    expect(risolvi(TAB_H, 'h')).toEqual(risolvi(ROW_ACTION_BOX, 'h'));
    const box = risolvi(ROW_ACTION_BOX, 'h');
    expect(chromeRowInset(box.wide)).toBe(6);
    expect(chromeRowInset(box.compact)).toBe(2);
  });

  test("l'incasso dal bordo è ROW_INSET, non il respiro verticale", () => {
    // Era `chromeRowInset(box)`: col dito veniva 2, cioè il bottone incollato
    // al bordo mentre la strip senza comando si ferma a 6. Il bordo è una
    // domanda ORIZZONTALE e ha già il suo numero.
    const dx = risolvi(CHROME_ROW_ACTION_INSET, 'right');
    expect(dx).toEqual({ wide: ROW_INSET, compact: ROW_INSET });
  });

  test('il comando in testa alla riga ha lo stesso incasso di quello in coda', () => {
    // Il tasto che riapre la sidebar e il «+» sono le due estremità della
    // stessa riga: se i due incassi divergono, uno dei due galleggia.
    expect(risolvi(CHROME_ROW_ACTION_INSET_LEFT, 'left')).toEqual(
      risolvi(CHROME_ROW_ACTION_INSET, 'right'),
    );
  });

  test('la riserva della strip è bordo + box + la stessa aria del bordo', () => {
    // I tre pezzi ci sono tutti: 6 dal bordo, il box, e altri 6 prima della
    // tab. Era `box + chromeRowInset(box)`, cioè senza il terzo: la strip
    // finiva ESATTAMENTE sul bordo del bottone e la tab lo toccava.
    const box = risolvi(ROW_ACTION_BOX, 'w');
    const pr = risolvi(CHROME_ROW_ACTION_RESERVE, 'pr');
    expect(pr.wide).toBe(ROW_INSET + box.wide + ROW_INSET);
    expect(pr.compact).toBe(ROW_INSET + box.compact + ROW_INSET);
  });

  test('la riserva a SINISTRA è la stessa, specchiata', () => {
    // Era un `paddingLeft: 30` in linea: fisso sui due breakpoint, quindi
    // sbagliato su almeno uno dei due. I due capi della strip ospitano bottoni
    // gemelli e devono riservare lo stesso spazio.
    expect(risolvi(CHROME_ROW_ACTION_RESERVE_LEFT, 'pl')).toEqual(
      risolvi(CHROME_ROW_ACTION_RESERVE, 'pr'),
    );
  });

  test('il comando ci sta dentro la riga', () => {
    // Un box più alto del contenuto darebbe un incasso NEGATIVO, cioè un
    // bottone che sborda — e le classi arbitrarie lo accetterebbero in
    // silenzio.
    for (const box of Object.values(ROW_ACTION_BOX_PX)) {
      expect(chromeRowInset(box)).toBeGreaterThan(0);
      expect(box).toBeLessThan(CHROME_ROW_CONTENT_H);
    }
  });
});

/**
 * IL PASSO DELLA COLONNA, PER LO STESSO MOTIVO DI SOPRA.
 *
 * `COLUMN_GAP` è un numero, ma la metà che tocca alle card è scritta come
 * classe (`my-[3px]`) e deve restare un letterale — Tailwind legge il sorgente
 * come testo. L'altra metà la mette il contenitore che scorre
 * (`TopicTree`, `paddingBlock: COLUMN_GAP / 2`), che invece il numero lo
 * importa. Due metà della stessa distanza, di cui una sola segue la costante:
 * se qualcuno porta COLUMN_GAP a 8 e la classe resta 3, sopra la prima card
 * restano 7px mentre fra due card ne passano 6, ed è di nuovo il near-miss che
 * questo giro serviva a togliere.
 */
describe('il passo verticale della colonna', () => {
  test('il margine della card è mezzo COLUMN_GAP, e sta scritto nella classe', () => {
    const base = sidebarRowCard({});
    const my = /(?:^|\s)my-\[(\d+)px\]/.exec(base);
    expect(my).not.toBeNull();
    expect(Number(my![1])).toBe(COLUMN_GAP / 2);
  });

  // NIENTE «due card adiacenti distano COLUMN_GAP» QUI, e vale la pena dire
  // perché: c'era, e non poteva fallire.
  //
  // Faceva `my * 2 === COLUMN_GAP` su una stringa — cioè riscriveva 3+3=6 in un
  // altro modo — e si giustificava dicendo che i margini «NON collassano,
  // perché stanno in un contenitore che scorre, che è un contesto di
  // formattazione a sé». Sbagliato: un BFC impedisce ai margini dei FIGLI di
  // sfuggire al contenitore, non il collasso FRA FRATELLI. A schermo le righe
  // stavano a 3px (misurato: `3,3,3`) mentre questo test era verde.
  //
  // Una distanza renderizzata si misura dove viene renderizzata:
  // `tests/e2e/tab-coherence-mobile.spec.ts` (TAB-COERENZA-3) legge i rettangoli
  // di due righe adiacenti a 390×844. Qui resta solo ciò che è davvero
  // verificabile da una stringa: che la classe dichiari mezzo passo.

  test('il passo ORIZZONTALE è lo stesso, e lo dice la stessa costante', () => {
    // Fra due tab c'erano 2px (`gap-0.5`) e fra due card della colonna 6: non
    // due scelte, lo stesso numero prima e dopo una correzione applicata a
    // metà. «Normalizza spaziature e dimensioni in tutte le tab sia verticali
    // che orizzontali» (Attilio, 09/08). Questo test è ciò che impedisce alla
    // metà orizzontale di restare di nuovo indietro.
    expect(risolvi(TAB_GAP_CLASS, 'gap').wide).toBe(COLUMN_GAP);
    expect(risolvi(TAB_GAP_CLASS, 'gap').compact).toBe(COLUMN_GAP);
  });

  test('mezzo passo è un numero intero di pixel', () => {
    // Un COLUMN_GAP dispari darebbe mezzi pixel su entrambe le metà, e un bordo
    // a 2,5px si vede come una riga sfocata.
    expect(COLUMN_GAP % 2).toBe(0);
  });
});
