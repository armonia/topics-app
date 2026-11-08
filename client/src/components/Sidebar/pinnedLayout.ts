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

import { equalizeWidths } from '../Layout/gridWidths';

/** Una riga di tessere: le chiavi in ordine, e i pesi delle larghezze (somma 1). */
export interface PinnedRow {
  keys: string[];
  widths: number[];
}

/**
 * Quante tessere ci stanno in una riga, punto.
 *
 * Era `PINNED_ROW_SOFT_MAX`, «soft» perché trascinando si poteva superare — e
 * questo è quel che succedeva davvero: nessuno lo impediva, e una riga da dodici
 * tessere larghe 15px non è una scelta dell'utente, è una riga rotta che nessun
 * gesto sa più disfare (le tessere diventano più strette del cursore che deve
 * prenderle). Il tetto è duro, e vale SOLO quando la riga CRESCE: riordinare
 * dentro una riga piena resta sempre possibile, perché il conteggio non cambia.
 *
 * Un rifiuto qui non è un vicolo cieco: gli spazi fra le righe restano bersagli
 * aperti, quindi il gesto viene naturalmente guidato a una riga nuova.
 */
export const PINNED_ROW_MAX = 6;

/** Dove una cosa trascinata da FUORI viene posata dentro la griglia: dentro una
 *  riga (a una certa posizione) oppure su una riga nuova aperta fra due. */
export type PinnedDropTarget =
  | { kind: 'row'; rowIdx: number; insertAt: number }
  | { kind: 'newRow'; atRowIdx: number };

const isRow = (r: unknown): r is PinnedRow =>
  !!r && typeof r === 'object' &&
  Array.isArray((r as PinnedRow).keys) &&
  Array.isArray((r as PinnedRow).widths);

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
  // I doppioni si tolgono QUI, non solo dalle righe: se `pinnedItems` ne porta
  // uno (merge fra due device, payload vecchio), il ramo dei «mancanti» in fondo
  // lo accoda DUE volte — e solo la riconciliazione successiva lo raddrizza,
  // cioè la funzione dichiarata idempotente non lo era per un giro.
  const unici = [...new Set(pinnedItems)];
  const pinned = new Set(unici);
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
    rows.push({ keys, widths: widthsFor(keys.length) });
  }

  // I fissati che il layout non ha ancora visto (pin appena messo, oppure un
  // device che sincronizza il pin prima della disposizione).
  const missing = unici.filter(key => !seen.has(key));
  for (const key of missing) {
    const last = rows[rows.length - 1];
    if (last && last.keys.length < PINNED_ROW_MAX) {
      last.keys.push(key);
      last.widths = widthsFor(last.keys.length);
    } else {
      rows.push({ keys: [key], widths: [1] });
    }
  }

  return rows;
}


/**
 * Le larghezze di una riga di `count` tessere.
 *
 * È anche l'anteprima: chi disegna la riga mentre il drag è sospeso sopra di lei
 * chiede le larghezze del conteggio che AVRÀ (una in più se una tessera entra,
 * una in meno se se ne va), quindi l'anteprima non è una simulazione — è il
 * risultato, calcolato in anticipo dalla stessa funzione che poi lo applica.
 * C'era una `previewWidths(row)` che faceva esattamente `widthsFor(n + 1)` e in
 * più prendeva un `insertAt` che ignorava: due nomi per una funzione, e uno dei
 * due prometteva una dipendenza dalla posizione che non esiste (le celle di una
 * riga sono tutte uguali, DOVE entra non cambia quanto sono larghe).
 *
 * ── Perché sono sempre uguali, oggi ─────────────────────────────────────────
 * Non esiste (ancora) un gesto per ridimensionare una tessera: nessuno può
 * VOLERE una riga sbilanciata, quindi una riga sbilanciata è rumore. E ne
 * arrivava: `appendColumnWidths` è nato per PRESERVARE proporzioni scelte a
 * mano — dà alla nuova colonna `1/n` e rinormalizza — così fissare la terza
 * tessera su una riga da due produceva `[0.375, 0.375, 0.25]`: la nuova più
 * stretta delle altre senza che nessuno l'avesse chiesto. E finiva SALVATO,
 * quindi non basta smettere di produrlo — va raddrizzato anche in lettura.
 *
 * Quando arriverà un gesto di resize, è QUI che andrà insegnata la differenza
 * fra una larghezza decisa e una accumulata, non nei chiamanti.
 */
export function pinnedRowWidths(count: number): number[] {
  return equalizeWidths(count);
}

/** Alias interno, per leggere le righe qui sotto come frasi. */
const widthsFor = pinnedRowWidths;

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
      widths: widthsFor(keepIdx.length),
    });
  }
  return out;
}

/**
 * L'ordine che una riga AVRÀ spostando `key` in posizione `insertAt`.
 *
 * `insertAt` è contato sulla riga **così com'è** — con `key` ancora dentro —
 * perché è l'unica cosa che il cursore possa misurare: quando tieni premuto, la
 * tessera in volo occupa ancora il suo posto. La conversione all'indice della
 * riga SENZA di lei (`insertAt > from ? insertAt - 1 : insertAt`) sta qui, in un
 * posto solo, ed è il motivo per cui questa funzione esiste: la stessa formula
 * viveva in DUE copie — una nell'anteprima del componente e una implicita nel
 * `pluck`+`splice` del drop — e le due divergevano su ogni spostamento verso
 * destra. Vedevi [b, a, c] mentre tenevi premuto e ti restava [b, c, a].
 */
export function reorderWithinRow(
  keys: readonly string[],
  key: string,
  insertAt: number,
): string[] {
  const from = keys.indexOf(key);
  if (from === -1) return [...keys];
  const rest = keys.filter(k => k !== key);
  const at = Math.max(0, Math.min(insertAt > from ? insertAt - 1 : insertAt, rest.length));
  rest.splice(at, 0, key);
  return rest;
}

/**
 * Sposta una tessera su `rowIdx`, in posizione `insertAt`.
 *
 * `rowIdx` è l'indice nel layout PRIMA della rimozione: se togliere la tessera
 * dalla sua riga svuota quella riga e questa sta sopra la destinazione, la
 * destinazione scala di uno. Si compensa qui, non nel chiamante, perché è
 * esattamente il passo che un chiamante dimentica.
 *
 * Restare nella PROPRIA riga è un caso a sé, non un caso particolare del
 * generale: lì `insertAt` è contato su una riga che contiene ancora la tessera,
 * e passare per `pluck` la sposterebbe di un posto troppo a destra. Peggio: per
 * una tessera SOLA nella sua riga, `pluck` cancella la riga e `rowIdx` finisce a
 * puntare quella dopo — rimettere la tessera dov'era FONDEVA due righe in una,
 * in modo persistente e senza undo.
 */
export function movePinnedTile(
  layout: readonly PinnedRow[],
  key: string,
  target: { rowIdx: number; insertAt: number },
): PinnedRow[] {
  const fromRow = layout.findIndex(r => r.keys.includes(key));
  if (fromRow === -1) return layout.map(r => ({ keys: [...r.keys], widths: [...r.widths] }));

  if (fromRow === target.rowIdx) {
    return layout.map((r, i) =>
      i === fromRow
        ? { keys: reorderWithinRow(r.keys, key, target.insertAt), widths: widthsFor(r.keys.length) }
        : { keys: [...r.keys], widths: [...r.widths] },
    );
  }

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
  row.widths = widthsFor(row.keys.length);
  return next;
}

/**
 * Piazza una chiave APPENA fissata dove il drop l'ha lasciata.
 *
 * L'ordine dei due passi è il punto: `movePinnedTile` su una chiave che il
 * layout non conosce è un no-op silenzioso, quindi prima la cella deve
 * ESISTERE — la crea `reconcilePinnedLayout` accodandola — e solo dopo la si
 * sposta. Farlo al contrario (spostare, poi riconciliare) produce esattamente
 * il bug che si vedeva: la tessera compare in fondo, mai sotto il cursore.
 *
 * `pinnedItems` deve già contenere `key`: è la lista di CHI è fissato, e questa
 * funzione non decide quello — decide solo dove sta.
 */
export function placePinnedTile(
  pinnedItems: readonly string[],
  layout: readonly PinnedRow[] | undefined | null,
  key: string,
  target: PinnedDropTarget,
): PinnedRow[] {
  const base = reconcilePinnedLayout(pinnedItems, layout);
  return target.kind === 'row'
    ? movePinnedTile(base, key, { rowIdx: target.rowIdx, insertAt: target.insertAt })
    : insertPinnedRow(base, key, target.atRowIdx);
}

/**
 * Sposta una tessera su una riga NUOVA, inserita a `atRowIdx`.
 *
 * Su una chiave che il layout non conosce non si inventa niente: è la gemella di
 * `movePinnedTile`, e le due devono rispondere allo stesso modo alla stessa
 * domanda. Chi vuole PIAZZARE una chiave nuova passa da `placePinnedTile`, che
 * prima la fa esistere (`reconcilePinnedLayout`) e poi la sposta — è lì che sta
 * la garanzia «è il pin a decidere chi c'è, il layout solo dove sta».
 */
export function insertPinnedRow(
  layout: readonly PinnedRow[],
  key: string,
  atRowIdx: number,
): PinnedRow[] {
  const fromRow = layout.findIndex(r => r.keys.includes(key));
  const clone = () => layout.map(r => ({ keys: [...r.keys], widths: [...r.widths] }));
  if (fromRow === -1) return clone();
  const vanishes = layout[fromRow].keys.length === 1;
  // Spostare l'unica tessera di una riga su una riga nuova subito sopra o sotto
  // è un no-op: la riga di partenza sparirebbe e ne nascerebbe una identica.
  if (vanishes && (atRowIdx === fromRow || atRowIdx === fromRow + 1)) return clone();
  const next = pluck(layout, key);
  let at = atRowIdx;
  if (vanishes && fromRow < atRowIdx) at -= 1;
  at = Math.max(0, Math.min(at, next.length));
  next.splice(at, 0, { keys: [key], widths: [1] });
  return next;
}

/**
 * Questo bersaglio di drop ha senso offrirlo?
 *
 * Una sola domanda, un solo posto. Prima la regola viveva SOLO dentro
 * `insertPinnedRow`, che si rifiutava di eseguire il gesto — ma la griglia
 * continuava ad aprire lo spazio, accenderlo e disegnarci dentro l'anteprima
 * della tessera: il bersaglio prometteva uno spostamento che il modello poi
 * rifiutava in silenzio. Un'affordance che mente è peggio di una che manca.
 *
 * Due motivi per dire di no:
 *  - **non cambierebbe niente** — spostare l'unica tessera di una riga su una
 *    riga nuova subito sopra o sotto (la riga di partenza sparirebbe e ne
 *    nascerebbe una identica), oppure riordinare dentro una riga dove quella
 *    tessera è l'unica che c'è: con una sola tessera fissata ogni bersaglio
 *    della griglia è un no-op, e prima si accendevano TUTTI;
 *  - **la riga è piena** — `PINNED_ROW_MAX`. Vale solo se la riga CRESCE:
 *    riordinare dentro una riga piena non cambia il conteggio, quindi si può.
 */
export function pinnedDropAllowed(
  layout: readonly PinnedRow[],
  key: string | null,
  target: PinnedDropTarget,
): boolean {
  const fromRow = key === null ? -1 : layout.findIndex(r => r.keys.includes(key));
  if (target.kind === 'row') {
    const row = layout[target.rowIdx];
    if (!row) return false;
    if (fromRow === target.rowIdx) return row.keys.length > 1;
    return row.keys.length < PINNED_ROW_MAX;
  }
  if (fromRow === -1) return true; // arriva da fuori: una riga nuova è sempre nuova
  return !samePinnedLayout(layout, insertPinnedRow(layout, key!, target.atRowIdx));
}

/**
 * Rimette in `next` i fissati che `next` non nomina, dov'erano in `prev`.
 *
 * La griglia in resa lavora su un SOTTOINSIEME dei fissati: la ricerca della
 * sidebar filtra le tessere, e una chat fissata poi archiviata sparisce da sola
 * con `showArchived: false`. Il componente allora riconcilia e committa una
 * disposizione che parla solo di quelle VISIBILI — e chi la riceve la trattava
 * come la verità su tutte: le assenti risultavano «mancanti» e venivano
 * riaccodate all'ultima riga. Cioè bastava riordinare due tessere con una
 * ricerca attiva per appiattire su una riga sola una disposizione fatta a mano,
 * in modo persistente e senza undo.
 *
 * Ogni chiave nascosta torna accanto al vicino con cui stava — il primo a
 * sinistra che è ancora collocato, altrimenti il primo a destra. Se tutta la sua
 * riga era nascosta, la riga rinasce dopo l'ultima che ha lasciato una traccia.
 */
export function mergePinnedLayout(
  prev: readonly PinnedRow[],
  next: readonly PinnedRow[],
): PinnedRow[] {
  const out = next.map(r => ({ keys: [...r.keys], widths: [...r.widths] }));
  const mostrate = new Set(flattenPinnedLayout(next));
  if (prev.every(r => r.keys.every(k => mostrate.has(k)))) return out;

  const dove = (k: string): { riga: number; col: number } | null => {
    for (let i = 0; i < out.length; i++) {
      const j = out[i].keys.indexOf(k);
      if (j !== -1) return { riga: i, col: j };
    }
    return null;
  };

  for (let ri = 0; ri < prev.length; ri++) {
    const riga = prev[ri].keys;
    for (let ci = 0; ci < riga.length; ci++) {
      const key = riga[ci];
      if (dove(key)) continue;

      let posto: { riga: number; col: number } | null = null;
      for (let j = ci - 1; j >= 0 && !posto; j--) {
        const p = dove(riga[j]);
        if (p) posto = { riga: p.riga, col: p.col + 1 };
      }
      for (let j = ci + 1; j < riga.length && !posto; j++) {
        const p = dove(riga[j]);
        if (p) posto = { riga: p.riga, col: p.col };
      }

      if (posto) {
        out[posto.riga].keys.splice(posto.col, 0, key);
        out[posto.riga].widths = widthsFor(out[posto.riga].keys.length);
        continue;
      }

      // Nessun vicino superstite: tutta la riga era nascosta. Rinasce subito
      // dopo l'ultima riga di `prev` che ha ancora una chiave in griglia.
      let at = 0;
      for (let k = 0; k < ri; k++) {
        for (const x of prev[k].keys) {
          const p = dove(x);
          if (p) at = Math.max(at, p.riga + 1);
        }
      }
      out.splice(Math.min(at, out.length), 0, { keys: [key], widths: [1] });
    }
  }
  return out;
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
