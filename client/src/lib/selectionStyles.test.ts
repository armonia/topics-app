/**
 * @covers CHROME-METRIC-01
 */
import { describe, expect, test } from 'bun:test';
import {
  CHROME_ROW_ACTION_INSET,
  CHROME_ROW_ACTION_INSET_LEFT,
  CHROME_ROW_ACTION_RESERVE,
  CHROME_ROW_ACTION_RESERVE_LEFT,
  CHROME_BAR_SUB,
  CHROME_ROW_CONTENT_H,
  CHROME_ROW_SUB_H,
  COLUMN_GAP,
  CARD_H,
  ROW_ACTION_BOX,
  ROW_ACTION_BOX_PX,
  ROW_ACTIONS_INSET_PX,
  ROW_GAP,
  ROW_H,
  ROW_INSET,
  ROW_PX,
  SECTION_CARD,
  SECTION_H,
  TAB_GAP_CLASS,
  TAB_LABEL,
  TAB_LABEL_TYPE,
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
    // QUI C'ERA UNA COPIA A MANO (`const TAB_H = 'h-9 md:h-7'`), col suo prezzo
    // dichiarato in un commento: «se qualcuno cambia l'altezza della tab senza
    // toccare qui, questo test resta verde su una bugia». Non serve più pagarlo:
    // l'altezza della card compatta è {@link CARD_H}, e la tab la importa invece
    // di riscriverla. Il test legge ora la STESSA stringa che la tab monta.
    expect(risolvi(CARD_H, 'h')).toEqual(risolvi(ROW_ACTION_BOX, 'h'));
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

  test('gli incassi orizzontali cadono su pixel INTERI', () => {
    // MEZZO PIXEL NON È UNA POSIZIONE, È UN LANCIO DI MONETA.
    //
    // L'08/08 il comando in testa alla riga stava a `md:left-[5.5px]`
    // (cbd00427, poi rientrato a 6 il 09/08 con ab8d7514). Il bordo sinistro
    // della sua scatola cadeva quindi a metà del pixel 5 — e `reopen-closed-tab`
    // clicca il punto (5, 5) della barra per spostare il fuoco: l'hit-test di
    // Chromium arrotonda DENTRO la scatola, il click finiva sul comando invece
    // che sulla barra, e il test moriva a 30 s. Misurato in entrambe le
    // direzioni: a 5.5 `elementFromPoint(bar.x+5)` risponde il comando, a 6
    // risponde la barra (tests/e2e/reduced-motion-chrome-controls.spec.ts).
    //
    // Il verticale non è in questa lista di proposito: lì il mezzo pixel non ha
    // un bersaglio contro cui sbattere — nessuno mira il bordo alto della riga.
    const frazionari = Object.entries({
      'incasso in coda': risolvi(CHROME_ROW_ACTION_INSET, 'right'),
      'incasso in testa': risolvi(CHROME_ROW_ACTION_INSET_LEFT, 'left'),
      'riserva in coda': risolvi(CHROME_ROW_ACTION_RESERVE, 'pr'),
      'riserva in testa': risolvi(CHROME_ROW_ACTION_RESERVE_LEFT, 'pl'),
    }).flatMap(([nome, { wide, compact }]) =>
      [
        ['col mouse', wide],
        ['col dito', compact],
      ].filter(([, px]) => !Number.isInteger(px as number))
       .map(([dove, px]) => `${nome} ${dove}: ${px}px`),
    );
    expect(frazionari).toEqual([]);
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

  test('la riga subordinata è box + un solo incasso, e i due li dice la stessa fonte', () => {
    // 34 = 28 + 6. Scritto come aritmetica e non come numero: se il box o
    // l'incasso si muovono, la riga figlia li segue o si separa QUI.
    expect(CHROME_ROW_SUB_H).toBe(ROW_ACTION_BOX_PX.desktop + ROW_INSET);
    // E la riga piena è la stessa cosa con l'incasso DUE volte: è tutta la
    // faccenda in una riga: la figlia non paga l'aria in cima perché quella
    // sopra l'ha già messa.
    expect(CHROME_ROW_SUB_H + ROW_INSET).toBe(CHROME_ROW_CONTENT_H);
    // La classe deve dire lo stesso numero della costante: sono due scritture
    // dello stesso valore, e Tailwind legge solo la prima.
    expect(risolvi(CHROME_BAR_SUB, 'h')).toEqual({ wide: CHROME_ROW_SUB_H, compact: CHROME_ROW_CONTENT_H });
    // `md:pb-[…]` esiste SOLO sopra i 768: `risolvi` pretende un valore per
    // entrambe le larghezze, quindi qui si legge il ramo `md:` da solo — ed è
    // giusto così, sotto quel breakpoint l'incasso in coda non c'è perché la
    // riga non si è stretta.
    const pb = /(?:^|\s)md:pb-\[(\d+)px\]/.exec(CHROME_BAR_SUB);
    expect(pb, 'CHROME_BAR_SUB senza incasso in coda').not.toBeNull();
    expect(Number(pb![1])).toBe(ROW_INSET);
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

describe('il binario dei comandi in coda', () => {
  test("l'incasso dell'overlay è ROW_PX, e il CSS lo scrive a mano", () => {
    // `.row-actions { right: 8px }` sta in `index.css`: nessuna media query può
    // leggere una costante TS, quindi il numero è per forza un letterale là.
    // Qui si ricalcola dal padding della riga — che è ciò che quel numero
    // PROMETTE di valere: il comando deve finire dove finiscono i segnali che
    // copre. Se `ROW_PX` cambia, questo test indica il CSS invece di lasciare
    // separare i due in silenzio.
    const px = risolvi(ROW_PX, 'px');
    expect(px.wide).toBe(ROW_ACTIONS_INSET_PX);
    expect(px.compact).toBe(ROW_ACTIONS_INSET_PX);
  });

  test('il box del comando ha la stessa misura ovunque, sui due rami', () => {
    // Il binario contiene sempre e solo box `ROW_ACTION_BOX`. Il test è qui e
    // non nei chiamanti perché il difetto era proprio la varietà: quattro
    // misure diverse nello stesso binario (28, 24, 24+mr-1, 24).
    expect(risolvi(ROW_ACTION_BOX, 'w')).toEqual({
      wide: ROW_ACTION_BOX_PX.desktop,
      compact: ROW_ACTION_BOX_PX.touch,
    });
  });
});

describe('le due famiglie di altezza, e le tre misure interne', () => {
  test('ROW_H e CARD_H sono due, e non si sovrappongono', () => {
    // Due famiglie legittime — la riga porta una subline, la card compatta no —
    // ma DEVONO restare due: sei altezze diverse era lo stato di partenza.
    const riga = risolvi(ROW_H, 'h');
    const card = risolvi(CARD_H, 'h');
    expect(riga.compact).toBeGreaterThan(card.compact);
    expect(riga.wide).toBeGreaterThan(card.wide);
    // La riga regge il minimo di tap target di iOS sotto i 768px; la card
    // compatta no, e non deve fingere di sì (là il bersaglio lo allarga
    // `tap-expand-y`).
    expect(riga.compact).toBe(44);
  });

  test("l'aria DENTRO una riga è una sola, e SECTION_CARD la usa", () => {
    // `SECTION_CARD` stava a `gap-1.5` mentre otto superfici su quattordici
    // usavano `gap-2`: la costante era in minoranza rispetto ai suoi clienti.
    expect(risolvi(ROW_GAP, 'gap')).toEqual({ wide: 8, compact: 8 });
    expect(SECTION_CARD).toContain(ROW_GAP);
    expect(SECTION_CARD).toContain(SECTION_H);
    expect(SECTION_CARD).toContain(ROW_PX);
  });

  test("l'intestazione di sezione prende un numero da ciascuna famiglia", () => {
    // E i due vengono da due VINCOLI diversi, non da due gusti (vedi SECTION_H):
    //  · col mouse è una card a una riga sola → la misura di CARD_H;
    //  · col dito è un bersaglio in una colonna → la misura di ROW_H, cioè i
    //    44px del minimo iOS. `SECTION_CARD` stava a 36: otto sotto la soglia,
    //    ed era l'unica cosa premibile in quella colonna a esserlo.
    const sezione = risolvi(SECTION_H, 'h');
    expect(sezione.wide).toBe(risolvi(CARD_H, 'h').wide);
    expect(sezione.compact).toBe(risolvi(ROW_H, 'h').compact);
    expect(sezione.compact).toBe(44);
  });

  test('la tab resta 36 col dito, e il soffitto lo dice il conto', () => {
    // Perché CARD_H non sale a 44 come l'intestazione: la tab vive DENTRO la
    // riga di chrome, e una tab più alta della riga che la contiene verrebbe
    // tagliata. Non è prudenza, è aritmetica — se un giorno la riga cresce,
    // questo test smette di giustificare il 36 e lo dice.
    const tab = risolvi(CARD_H, 'h');
    expect(tab.compact).toBeLessThanOrEqual(CHROME_ROW_CONTENT_H);
    expect(chromeRowInset(tab.compact)).toBeGreaterThanOrEqual(0);
  });

  test("l'aria DENTRO non è quella FRA: due domande, due numeri", () => {
    // Non è pignoleria: sono due assi diversi (dentro una card / fra due card) e
    // il difetto era che ognuno aveva TRE valori. Averli distinti — e diversi —
    // è il modo di accorgersi se qualcuno li fonde per sbaglio.
    expect(risolvi(ROW_GAP, 'gap').wide).toBe(8);
    expect(risolvi(TAB_GAP_CLASS, 'gap').wide).toBe(COLUMN_GAP);
    expect(risolvi(ROW_GAP, 'gap').wide).not.toBe(COLUMN_GAP);
  });

  test('TAB_LABEL è TAB_LABEL_TYPE più il colore, e non una seconda scala', () => {
    // I due assi vanno separati (chi calcola il proprio tono prende solo il
    // tipo), ma la scala deve restare UNA: `TAB_LABEL` che diverge da
    // `TAB_LABEL_TYPE` sarebbe esattamente la copia da cui veniamo.
    expect(TAB_LABEL.startsWith(TAB_LABEL_TYPE)).toBe(true);
    expect(TAB_LABEL_TYPE).not.toContain('text-app-text');
  });
});
