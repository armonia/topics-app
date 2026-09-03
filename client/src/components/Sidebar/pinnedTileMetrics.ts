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
  /**
   * Whether the tile carries the split schematic (see `RowSplitMap`).
   *
   * IN ROW FORM YES, because there the tile IS a row: it is read in the column
   * next to chat, terminal, browser and board rows, all of which say where
   * their pane sits in the split, and a pinned pane is the one you look for
   * first. A pinned row was the only place in the sidebar where that answer
   * disappeared as a side effect of pinning.
   *
   * IN GRID FORM NO, and it is the same rule that already sends the badge out
   * of the flow and drops the timestamp, the subline and the project name: a
   * grid tile shows IDENTITY and nothing else, on 40 to 100px of width. A
   * 16px schematic there is not a position cue, it is a second glyph competing
   * with the one that says what the tile is.
   */
  splitMap: boolean;
}

export const PINNED_ALIGN: Record<PinnedForm, PinnedAlignment> = {
  // A row is read inside a column: it starts where the column starts.
  row: { justify: 'justify-start', iconSlot: ROW_GLYPH_SLOT, splitMap: true },
  // A grid tile is read on its own: what identifies it takes the middle, and
  // an empty box on the leading side is exactly what pushes it off centre.
  grid: { justify: 'justify-center', iconSlot: 'flex-shrink-0 items-center justify-center', splitMap: false },
};

/**
 * THE GRID TILE, IN PIXELS, so that "does the name fit" can be answered
 * without a browser.
 *
 * Reported on 03/09 (card 058ea722), with a screenshot of three tiles reading
 * "to...", "ar...", "ed...": a grid tile kept its name as long as the tile was
 * wider than a fixed threshold (104px), and truncated it from there on. Two
 * letters and an ellipsis are not a name; the owner's rule is the one written
 * in `pinnedLabelShown`: if the whole name does not fit, hide it and show the
 * icon alone (when there is one). A threshold in CSS cannot know how wide a
 * name is, so the question moved to a measurement (the tile's width and the
 * name's full width, both read from the DOM by `PinnedTile`) and to this
 * function, which is the part that can be tested.
 *
 * The numbers are the classes the tile is drawn with, restated: `ROW_PX` per
 * side, `ROW_CHEVRON` in its slot, `ROW_GAP` between the pieces, the 18px
 * glyph box. `pinnedTileMetrics.test.ts` ties them to the constants.
 */
export const PINNED_GRID_PX = {
  /** Horizontal padding of the tile, ONE side (`ROW_PX`, `px-2`). */
  inset: 8,
  /** The accordion glyph and its slot (`ROW_CHEVRON`). */
  chevron: 12,
  /** The air between two pieces of the line (`ROW_GAP`, `gap-2`). */
  gap: 8,
  /** The box the leading icon sits in (a favicon fills it, a glyph centres). */
  icon: 18,
  /** Under this width the accordion hint is not drawn at all: 8 + 12 + 8 of
   *  chevron zone on each side plus the 18 of the icon is 74, and below it the
   *  centred icon would land on the chevron. Written out in the tile's classes
   *  (`@min-[76px]/tile`), because Tailwind reads the source. */
  chevronMin: 76,
  /** The least a name can be to exist at all: one character at 11px. */
  glyphMin: 14,
} as const;

export interface PinnedLabelInput {
  /** The tile's width, as laid out. */
  tileWidth: number;
  /** The FULL width of the name, untruncated, in the tile's font. */
  labelWidth: number;
  /** A favicon or a type glyph is drawn next to the name. */
  hasIcon: boolean;
  /** The tile opens (a project with tabs): the accordion hint is drawn. */
  expandable: boolean;
}

/**
 * How many pixels are left for the name on a grid tile.
 *
 * The accordion, when drawn, is OUT OF THE FLOW at the left edge (see
 * `PINNED_GRID_CHEVRON_CLASS`), so it does not weigh on the centre; but the
 * identity stays centred only if the same zone is kept free on BOTH sides,
 * or the name would run under the chevron on the left. Hence twice
 * `chevron + gap`, and only above `chevronMin`, where the hint is drawn.
 */
export function pinnedLabelRoom({ tileWidth, hasIcon, expandable }: Omit<PinnedLabelInput, 'labelWidth'>): number {
  const { inset, chevron, gap, icon, chevronMin } = PINNED_GRID_PX;
  let room = tileWidth - inset * 2;
  if (expandable && tileWidth >= chevronMin) room -= (chevron + gap) * 2;
  if (hasIcon) room -= icon + gap;
  return room;
}

/**
 * WHETHER THE NAME IS DRAWN ON A GRID TILE.
 *
 * With an icon the name leaves as soon as it does not fit WHOLE: a truncated
 * name next to an icon is ink without information, and the icon already says
 * what the tile is. Without an icon the name is the only identity the tile
 * has, so it stays at any width where at least one character exists, truncated
 * if it must be (a project without a favicon: only a real icon or nothing,
 * never a monogram in its place).
 */
export function pinnedLabelShown(input: PinnedLabelInput): boolean {
  const room = pinnedLabelRoom(input);
  if (input.hasIcon) return input.labelWidth <= room;
  return room >= PINNED_GRID_PX.glyphMin;
}

/**
 * WHERE THE ACCORDION SITS ON A GRID TILE: at the left edge, out of the flow,
 * exactly where it would be if nothing were centred.
 *
 * Reported on 03/09 with the rest of card 058ea722: "when the icon is centred
 * the accordion must stay on the left, in the position it would have if it
 * were not centred". It used to sit IN the flow next to the icon, mirrored by
 * an empty 12px box on the other side so that the pair weighed nothing on the
 * centre: correct as arithmetic, wrong as a picture, because the chevron then
 * travelled with the icon to the middle of the tile instead of marking the
 * row's edge like every other accordion of the column.
 *
 * `left-2` is `ROW_PX` (8px): the chevron ink starts at the row inset, which
 * is the same x a row-form tile and a tree row put it at. `inset-y-0` gives it
 * the tile's height, so it is hit-testable like the slot it replaces.
 */
export const PINNED_GRID_CHEVRON_CLASS = 'absolute inset-y-0 left-2';

/**
 * WHAT THE IDENTITY KEEPS CLEAR OF THE EDGE, on a grid tile that opens.
 *
 * Out of the flow the chevron reserves nothing, so a name that is the only
 * identity of the tile (no favicon: drawn at any width, truncated) would run
 * under it from the padding edge. The tile's padding grows to the chevron
 * zone on BOTH sides while the chevron is drawn (from `chevronMin` up):
 * inset 8 + chevron 12 + gap 8 = 28 (`px-7`), symmetric so the centre does
 * not move, and equal to what `pinnedLabelRoom` already charges. The chevron
 * itself is positioned from the padding box's edge (`left-2`), so the
 * padding does not move it.
 */
export const PINNED_GRID_CLEAR_CLASS = '@min-[76px]/tile:px-7';
