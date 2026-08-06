/**
 * Disposizione delle tessere fissate: quali stanno su quale riga, in che ordine,
 * e con quale larghezza.
 *
 * ── Perché righe di chiavi e non coordinate per elemento ─────────────────────
 * Un `{ [key]: { row, col } }` terrebbe DUE verità sullo stesso fatto — l'ordine
 * dentro la riga e quante ce ne sono — e le lascerebbe divergere al primo drop
 * interrotto. Con le righe l'invariante è strutturale: una tessera sta in
 * esattamente una riga, e quante ce ne sono per riga si conta, non si dichiara.
 *
 * ── Chi comanda ─────────────────────────────────────────────────────────────
 * Il layout NON è autorevole su COSA è fissato: lo è `pinnedItems`. Qui si
 * riconcilia sempre contro quella lista, così un payload assente, vecchio o
 * arrivato da un altro device non può mai far sparire un fissato né lasciare in
 * giro una cella che non si risolve.
 *
 * Le larghezze sono pesi relativi normalizzati a 1, esattamente come le colonne
 * della griglia: la matematica è quella, e infatti si riusa `gridWidths` invece
 * di riscriverla — è il modulo che ha già risolto «trascinare mi resetta il
 * layout» preservando le proporzioni delle colonne non toccate.
 */

import {
  appendColumnWidths,
  equalizeWidths,
  keepColumnWidths,
} from '../Layout/gridWidths';

/** Una riga di tessere: le chiavi in ordine, e i pesi delle larghezze (somma 1). */
export interface PinnedRow {
  keys: string[];
  widths: number[];
}

/** Quante tessere mettere per riga quando la disposizione va inventata da zero. */
export const PINNED_ROW_DEFAULT = 4;

/** Tetto per riga quando si accoda in automatico. Trascinando si può superare:
 *  è una scelta esplicita dell'utente, e la riga si stringe di conseguenza. */
export const PINNED_ROW_SOFT_MAX = 6;

/** Sotto questa larghezza una tessera non è più una tessera. La riga va a capo
 *  da sola (soft-wrap in resa) SENZA riscrivere il layout salvato: una sidebar
 *  stretta non deve poter distruggere la disposizione fatta su una larga. */
export const PINNED_TILE_MIN = 40;

const isRow = (r: unknown): r is PinnedRow =>
  !!r && typeof r === 'object' &&
  Array.isArray((r as PinnedRow).keys) &&
  Array.isArray((r as PinnedRow).widths);

/**
 * Disposizione derivata dal solo ordine di pin — il punto di partenza quando non
 * c'è niente di salvato.
 */
export function deriveFromPinOrder(
  pinnedItems: readonly string[],
  perRow: number = PINNED_ROW_DEFAULT,
): PinnedRow[] {
  const size = Math.max(1, Math.floor(perRow));
  const rows: PinnedRow[] = [];
  for (let i = 0; i < pinnedItems.length; i += size) {
    const keys = pinnedItems.slice(i, i + size);
    rows.push({ keys, widths: equalizeWidths(keys.length) });
  }
  return rows;
}

/**
 * Allinea la disposizione all'insieme dei fissati. Idempotente.
 *
 * 1. via le chiavi che non sono più fissate (le superstiti tengono le loro
 *    proporzioni: `keepColumnWidths`, non un reset a 1/n);
 * 2. via i doppioni, tenendo la prima occorrenza;
 * 3. via le righe rimaste vuote;
 * 4. i fissati che il layout non conosce si accodano — all'ultima riga se c'è
 *    posto, altrimenti su una riga nuova.
 */
export function reconcilePinnedLayout(
  pinnedItems: readonly string[],
  layout: readonly PinnedRow[] | undefined | null,
): PinnedRow[] {
  const pinned = new Set(pinnedItems);
  const seen = new Set<string>();
  const rows: PinnedRow[] = [];

  for (const row of Array.isArray(layout) ? layout : []) {
    if (!isRow(row)) continue;
    const keepIdx: number[] = [];
    const keys: string[] = [];
    row.keys.forEach((key, i) => {
      if (typeof key !== 'string' || !pinned.has(key) || seen.has(key)) return;
      seen.add(key);
      keepIdx.push(i);
      keys.push(key);
    });
    if (keys.length === 0) continue;
    const widths = row.widths.length === row.keys.length
      ? keepColumnWidths(row.widths, keepIdx)
      : equalizeWidths(keys.length);
    rows.push({ keys, widths });
  }

  // I fissati che il layout non ha ancora visto (pin appena messo, oppure un
  // device che sincronizza il pin prima della disposizione).
  const missing = pinnedItems.filter(key => !seen.has(key));
  for (const key of missing) {
    const last = rows[rows.length - 1];
    if (last && last.keys.length < PINNED_ROW_SOFT_MAX) {
      last.keys.push(key);
      last.widths = appendColumnWidths(last.widths, 1);
    } else {
      rows.push({ keys: [key], widths: [1] });
    }
  }

  return rows;
}

/** Toglie una chiave dalla sua riga, potando la riga se resta vuota. */
function pluck(layout: readonly PinnedRow[], key: string): PinnedRow[] {
  const out: PinnedRow[] = [];
  for (const row of layout) {
    const idx = row.keys.indexOf(key);
    if (idx === -1) {
      out.push({ keys: [...row.keys], widths: [...row.widths] });
      continue;
    }
    const keepIdx = row.keys.map((_, i) => i).filter(i => i !== idx);
    if (keepIdx.length === 0) continue; // riga svuotata: sparisce
    out.push({
      keys: keepIdx.map(i => row.keys[i]),
      widths: keepColumnWidths(row.widths, keepIdx),
    });
  }
  return out;
}

/**
 * Sposta una tessera su `rowIdx`, in posizione `insertAt`.
 *
 * `rowIdx` è l'indice nel layout PRIMA della rimozione: se togliere la tessera
 * dalla sua riga svuota quella riga e questa sta sopra la destinazione, la
 * destinazione scala di uno. Si compensa qui, non nel chiamante, perché è
 * esattamente il passo che un chiamante dimentica.
 */
export function movePinnedTile(
  layout: readonly PinnedRow[],
  key: string,
  target: { rowIdx: number; insertAt: number },
): PinnedRow[] {
  const fromRow = layout.findIndex(r => r.keys.includes(key));
  if (fromRow === -1) return layout.map(r => ({ keys: [...r.keys], widths: [...r.widths] }));

  const vanishes = layout[fromRow].keys.length === 1;
  const next = pluck(layout, key);
  let rowIdx = target.rowIdx;
  if (vanishes && fromRow < rowIdx) rowIdx -= 1;
  rowIdx = Math.max(0, Math.min(rowIdx, next.length - 1));

  const row = next[rowIdx];
  if (!row) {
    next.push({ keys: [key], widths: [1] });
    return next;
  }
  const insertAt = Math.max(0, Math.min(target.insertAt, row.keys.length));
  row.keys.splice(insertAt, 0, key);
  row.widths = appendColumnWidths(row.widths, 1);
  // `appendColumnWidths` mette il nuovo peso in coda: rimettilo dove sta la chiave.
  const added = row.widths.pop() as number;
  row.widths.splice(insertAt, 0, added);
  return next;
}

/** Sposta una tessera su una riga NUOVA, inserita a `atRowIdx`. */
export function insertPinnedRow(
  layout: readonly PinnedRow[],
  key: string,
  atRowIdx: number,
): PinnedRow[] {
  const fromRow = layout.findIndex(r => r.keys.includes(key));
  const vanishes = fromRow !== -1 && layout[fromRow].keys.length === 1;
  // Spostare l'unica tessera di una riga su una riga nuova subito sopra o sotto
  // è un no-op: la riga di partenza sparirebbe e ne nascerebbe una identica.
  if (vanishes && (atRowIdx === fromRow || atRowIdx === fromRow + 1)) {
    return layout.map(r => ({ keys: [...r.keys], widths: [...r.widths] }));
  }
  const next = pluck(layout, key);
  let at = atRowIdx;
  if (vanishes && fromRow < atRowIdx) at -= 1;
  at = Math.max(0, Math.min(at, next.length));
  next.splice(at, 0, { keys: [key], widths: [1] });
  return next;
}

/**
 * Le larghezze che la riga AVRÀ se una tessera viene inserita in `insertAt` —
 * cioè quello che si dipinge mentre il drag è sospeso sopra la riga. È la stessa
 * `appendColumnWidths` del drop, quindi l'anteprima non può divergere dal
 * risultato: è il risultato, calcolato in anticipo.
 */
export function previewWidths(row: PinnedRow, insertAt: number): number[] {
  const widths = appendColumnWidths(row.widths, 1);
  const added = widths.pop() as number;
  const at = Math.max(0, Math.min(insertAt, widths.length));
  widths.splice(at, 0, added);
  return widths;
}

/**
 * Quante tessere di una riga stanno davvero in `available` px prima di scendere
 * sotto `PINNED_TILE_MIN`. Serve al soft-wrap in resa: la riga si spezza in
 * blocchi da N senza che il layout salvato venga toccato.
 */
export function tilesPerVisualRow(available: number, gap: number, count: number): number {
  if (count <= 1) return Math.max(1, count);
  const fits = Math.floor((available + gap) / (PINNED_TILE_MIN + gap));
  return Math.max(1, Math.min(count, fits));
}

/** Uguaglianza strutturale — per non riscrivere lo stato quando nulla è cambiato. */
export function samePinnedLayout(a: readonly PinnedRow[], b: readonly PinnedRow[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].keys.length !== b[i].keys.length) return false;
    for (let j = 0; j < a[i].keys.length; j++) {
      if (a[i].keys[j] !== b[i].keys[j]) return false;
      if (Math.abs((a[i].widths[j] ?? 0) - (b[i].widths[j] ?? 0)) > 1e-9) return false;
    }
  }
  return true;
}

/** Tutte le chiavi del layout, in ordine di lettura. */
export function flattenPinnedLayout(layout: readonly PinnedRow[]): string[] {
  return layout.flatMap(r => r.keys);
}
