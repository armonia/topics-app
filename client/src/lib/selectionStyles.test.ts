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

  test("l'incasso a destra è quello che il comando ha sopra e sotto", () => {
    const dx = risolvi(CHROME_ROW_ACTION_INSET, 'right');
    expect(dx.wide).toBe(chromeRowInset(ROW_ACTION_BOX_PX.desktop));
    expect(dx.compact).toBe(chromeRowInset(ROW_ACTION_BOX_PX.touch));
    // E lo spazio verticale, che è ciò a cui deve essere UGUALE: la riga meno
    // il box, diviso due. Scritto qui per esteso perché è l'invariante, non un
    // passaggio intermedio.
    expect(dx.wide).toBe((CHROME_ROW_CONTENT_H - ROW_ACTION_BOX_PX.desktop) / 2);
    expect(dx.compact).toBe((CHROME_ROW_CONTENT_H - ROW_ACTION_BOX_PX.touch) / 2);
  });

  test('il comando in testa alla riga ha lo stesso incasso di quello in coda', () => {
    // Il tasto che riapre la sidebar e il «+» sono le due estremità della
    // stessa riga: se i due incassi divergono, uno dei due galleggia.
    expect(risolvi(CHROME_ROW_ACTION_INSET_LEFT, 'left')).toEqual(
      risolvi(CHROME_ROW_ACTION_INSET, 'right'),
    );
  });

  test('la riserva della strip è il box più il suo incasso', () => {
    const pr = risolvi(CHROME_ROW_ACTION_RESERVE, 'pr');
    expect(pr.wide).toBe(ROW_ACTION_BOX_PX.desktop + chromeRowInset(ROW_ACTION_BOX_PX.desktop));
    expect(pr.compact).toBe(ROW_ACTION_BOX_PX.touch + chromeRowInset(ROW_ACTION_BOX_PX.touch));
  });

  test('la riserva a SINISTRA è la stessa, specchiata', () => {
    // Era un `paddingLeft: 30` in linea: fisso sui due breakpoint, quindi
    // sbagliato su almeno uno dei due (34 col mouse, 38 col dito). I due capi
    // della strip ospitano bottoni gemelli e devono riservare lo stesso spazio.
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

  test('mezzo passo è un numero intero di pixel', () => {
    // Un COLUMN_GAP dispari darebbe mezzi pixel su entrambe le metà, e un bordo
    // a 2,5px si vede come una riga sfocata.
    expect(COLUMN_GAP % 2).toBe(0);
  });
});
