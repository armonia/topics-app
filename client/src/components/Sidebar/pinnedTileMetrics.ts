/**
 * Le MISURE di una tessera fissata: altezza, contenitore misurato, slot e
 * rientro del comando in coda.
 *
 * Stanno fuori da `PinnedTile.tsx` per la stessa ragione delle altre uscite
 * recenti: un file che esporta un componente E altro spegne il fast refresh di
 * Vite per quel file — ogni modifica alla tessera diventava un ricarico pieno
 * invece di uno scambio a caldo. Ma soprattutto queste misure sono lette da
 * CHI DISEGNA IL VUOTO (il fantasma del drop, l'anteprima della riga nuova, il
 * trigger «+»), non solo dalla tessera: qui sono al loro posto, e nessuno deve
 * importare un componente per sapere quanto è alta una riga.
 */
import { ROW_GLYPH_SLOT, ROW_H } from '../../lib/selectionStyles';

/**
 * L'altezza di una tessera — che è quella di una RIGA, perché una tessera è una
 * riga: {@link ROW_H}, 44 col dito e 34 col mouse.
 *
 * Era `h-9 max-md:h-11`, cioè 36/44: d'accordo col dito e due pixel più alta
 * col mouse. Due pixel nella stessa colonna, fra card impilate una sull'altra —
 * la misura che «fa sembrare storta una colonna senza che si riesca a dire
 * perché», che è la formula con cui questo repo ha già descritto mezzo pixel di
 * glifo fuori asse.
 *
 * ── Perché era 36, e perché quel motivo non reggeva ─────────────────────────
 * Da un'invariante scritta qui sotto: «altezza = box del comando + 2 × rientro»,
 * 28 + 2×4 = 36. Faceva coincidere il rientro ORIZZONTALE del «+» con l'aria
 * sopra e sotto di lui. Bello, e senza un fratello: NESSUNA altra superficie
 * dell'app lo fa. Una riga della colonna è alta 34 con un comando da 28 a 8px
 * dal bordo — 3 di aria verticale contro 8 di orizzontale — e sono due domande
 * diverse: quanto il comando sta lontano dal BORDO (fatto orizzontale, ha già
 * il suo numero, `ROW_PX`) e quanto respira nella riga (non si sceglie, cade
 * fuori dal centraggio). Il repo lo dichiara già altrove: «il bordo è una
 * domanda orizzontale e ha già il suo numero. Il respiro verticale è un'altra
 * cosa e non si sceglie».
 *
 * Tenendo insieme le due, l'invariante decideva l'ALTEZZA della tessera a
 * partire dal rientro del suo bottone: la coda che muove il cane.
 */
export const PINNED_TILE_H = ROW_H;

/**
 * Il contenitore che la tessera MISURA per decidere se è una riga o un
 * quadrato. Va su chi le dà la larghezza — la cella della griglia — perché un
 * elemento non può interrogare se stesso: `justify-content` del bottone deve
 * poter cambiare con la soglia, e ci riesce solo se il contenitore è il suo
 * genitore. Sta qui accanto all'altezza, ed è esportato, perché le celle sono
 * TRE (quella vera, il fantasma del drop, l'anteprima della riga nuova) e una
 * dimenticata darebbe una tessera che non si adatta più — muta, senza errore.
 */
export const PINNED_TILE_CONTAINER = '@container/tile';

/**
 * LO SLOT DEL «+», cioè la larghezza che il contenuto della tessera gli lascia
 * quando la tessera è in forma RIGA.
 *
 * Il «+» non è mai stato in fila con il resto: è un fratello in `position:
 * absolute` sopra la tessera, e il nome — `flex-1 truncate` — arrivava fino a
 * 6px dal bordo. Su una tessera larga il bottone atterrava quindi SOPRA il
 * testo, e sotto la vibrancy (dove il suo fondo è un'alpha) il testo ci si
 * leggeva attraverso. Uno slot vero toglie il caso: il nome finisce prima, e
 * il bottone si appoggia su niente.
 *
 * Solo sopra la soglia della container query che decide se la
 * tessera è una riga o un quadrato: sotto, la tessera è larga quanto il
 * bottone e riservargli uno slot vorrebbe dire non lasciare niente al nome.
 *
 * È la larghezza MASSIMA, non una prenotazione: a riposo, quando il «+» non è
 * visibile, lo slot cede al nome che non ci sta e si chiude fino a zero. Il
 * come sta in `PinnedTile`, dove ci sono i fattori di contrazione.
 *
 * È la LARGHEZZA di `ROW_ACTION_BOX` (`w-9 md:w-7`), che è la misura del
 * trigger — scritta per esteso perché Tailwind legge il sorgente e una
 * composizione a runtime non genererebbe nessuna regola. Che i due numeri
 * coincidano lo difende `pinnedTileMetrics.test.ts`.
 */
export const PINNED_TILE_ACTION_SLOT = 'w-9 md:w-7';

/**
 * IL RIENTRO DEL «+» È L'ARIA CHE HA SOPRA E SOTTO — tre spazi uguali attorno a
 * un comando che FLOTTA su una card.
 *
 * Ci sono passato per tre valori, e i primi due erano sbagliati per due ragioni
 * opposte:
 *
 *  · **4**, dall'invariante che la tessera si era data da sola («altezza = box +
 *    2 × rientro»). I tre spazi coincidevano, ma il conto girava al contrario:
 *    era il rientro del bottone a decidere l'ALTEZZA della tessera, e per questo
 *    la tessera stava a 36 contro i 34 di una riga.
 *  · **8** (`ROW_ACTIONS_INSET_PX`, il rientro dei comandi in fila).
 *    Coerente con le righe, e sbagliato qui: «sui pinned il + ha più spazio a
 *    destra che sopra e sotto» (Attilio, 10/08). Vero — 8 contro 3 — e si vede
 *    perché su una tessera il bottone flotta su una superficie piccola, dove
 *    l'asimmetria si legge tutta. In una riga lunga non si legge, ed è per
 *    questo che là 8 va bene.
 *
 * Il numero giusto è quello che il repo usa già per l'altro comando che flotta:
 * il «+» della barra di chrome sta a `ROW_INSET` dal bordo e la riga gli lascia
 * `chromeRowInset(box)` sopra e sotto — 6 e 6. Stessa idea, un piano più giù:
 * qui l'aria verticale è `(altezza − box) / 2`, e il rientro destro la copia.
 *
 * Quindi **3 col mouse e 4 col dito**, e non è un ritorno alle due costanti di
 * un tempo: allora erano due numeri per far tornare un'invariante scelta a
 * mano, adesso sono lo stesso calcolo su due altezze diverse. Il verso è quello
 * giusto — l'altezza la decide la RIGA, il rientro segue.
 *
 * Letterali per la ragione di sempre (Tailwind legge il sorgente come testo), e
 * ricalcolati da `pinnedTileMetrics.test.ts` a partire da altezza e box.
 */
export const PINNED_TILE_ACTION_INSET_CLASS = 'right-[4px] md:right-[3px]';
/** Gli stessi due numeri per l'aritmetica del test — vedi {@link PINNED_TILE_PX}. */
export const PINNED_TILE_ACTION_INSET_PX = { wide: 3, compact: 4 } as const;

/**
 * I numeri dietro le classi qui sopra, in pixel — l'unica forma in cui
 * l'invariante si può VERIFICARE.
 *
 * Non generano niente e non vanno usati per disegnare: le classi restano la
 * sorgente (Tailwind legge il sorgente). Servono al test, che rilegge le classi
 * e controlla che dicano questi numeri e che il conto torni. Senza, «altezza =
 * box + 2 × rientro» è una frase in un commento, e i commenti non diventano
 * rossi.
 */
export const PINNED_TILE_PX = {
  /** Sopra i 768px: `md:h-[34px]` di `ROW_H` / `md:w-7` di `ROW_ACTION_BOX`. */
  wide: { tile: 34, action: 28 },
  /** Sotto i 768px: `h-11` di `ROW_H` / `w-9` di `ROW_ACTION_BOX`. */
  compact: { tile: 44, action: 36 },
} as const;

/**
 * THE TWO FORMS OF A PINNED TILE, and the alignment each one implies.
 *
 * Reported on 27/08/2026: the pinned tiles look pushed to the right when the
 * sidebar has spare width, and stacked tiles do not read as centred. The shape
 * was already decided in one place (the grid, from how many cells a row draws)
 * but the ALIGNMENT was not declared anywhere: it lived scattered in the class
 * lists of the tile, so nothing said out loud that a row aligns to the column
 * and a grid tile centres its identity, and nothing could go red when the two
 * drifted apart.
 *
 * So form and alignment are ONE decision, taken here and read by everybody:
 * `pinnedForm` says which form a row of N cells has, `PINNED_ALIGN` says what
 * that form does to the content. No width threshold decides a third alignment
 * (see the history in `PinnedTile.tsx`: a scale of container queries used to
 * centre the NAME inside a box that was itself left-aligned).
 */
export type PinnedForm = 'row' | 'grid';

/**
 * ONE TILE ON THE ROW = A ROW. Two or more = a grid.
 *
 * Counted on the cells being DRAWN, ghost included: while a second tile hovers
 * over a row that holds one, what you see is already a grid, and the alignment
 * must be the one of the drop, not the one of a moment ago.
 */
export function pinnedForm(cellCount: number): PinnedForm {
  return cellCount <= 1 ? 'row' : 'grid';
}

export interface PinnedAlignment {
  /** How the line of content sits inside the tile. */
  justify: string;
  /**
   * The box the leading icon sits in.
   *
   * In ROW form it is the SHARED slot of the column ({@link ROW_GLYPH_SLOT}):
   * an 18px box that centres any glyph, so a tile and a normal row start their
   * name at the same pixel. Measured before this existed: the tile's ink began
   * 2px left of the row's, because the tile sized the box on the glyph (14)
   * while the column reserves 18 for all of them.
   *
   * In GRID form the box is the icon itself: the identity is centred, and a
   * fixed box that is wider than what it holds is air on one side only.
   */
  iconSlot: string;
  /** Whether the leading accordion box is reserved even when nothing opens. */
  reservesChevron: boolean;
}

export const PINNED_ALIGN: Record<PinnedForm, PinnedAlignment> = {
  // A row is read inside a column: it starts where the column starts.
  row: { justify: 'justify-start', iconSlot: ROW_GLYPH_SLOT, reservesChevron: true },
  // A grid tile is read on its own: what identifies it takes the middle, and
  // an empty box on the leading side is exactly what pushes it off centre.
  grid: { justify: 'justify-center', iconSlot: 'flex-shrink-0 items-center justify-center', reservesChevron: false },
};
