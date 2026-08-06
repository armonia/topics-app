import { useCallback, useRef, useState, type ReactNode } from 'react';
import type { SidebarItem } from '../../lib/buildSidebarItems';
import type { AttentionTier } from '../../types';
import { DND_TYPES } from '../../lib/dndTypes';
import { pinKeyFromPaneId } from '../../state/pane/adapters/paneConfig';
import { PinnedTile } from './PinnedTile';
import {
  insertPinnedRow,
  movePinnedTile,
  previewWidths,
  reconcilePinnedLayout,
  samePinnedLayout,
  type PinnedDropTarget,
  type PinnedRow,
} from './pinnedLayout';

/**
 * L'UNICO passo del blocco: fra due tessere della stessa riga, fra due righe, e
 * sopra la prima riga. Orizzontale e verticale sono lo stesso numero — una
 * griglia in cui le colonne respirano 6px e le righe 0 non è una griglia, è due
 * regole diverse messe vicine. È anche `ROW_INSET`, cioè lo stesso passo con cui
 * la sidebar rientra da ogni bordo.
 *
 * Prima: 1px fra la riga della board e le tessere (il solo `my-px` della card),
 * 0px fra due righe di tessere (si toccavano) e 10px prima del filo. Tre
 * distanze diverse per tre spazi che l'occhio legge come uno.
 */
const TILE_GAP = 6;

/** Quanto della sezione possono prendersi le fasce aperte. Il resto della
 *  sidebar deve restare raggiungibile: una tessera espansa non è una modale. */
const EXPANDED_MAX_HEIGHT = '62%';

export interface PinnedTileMeta {
  focused: boolean;
  attention: AttentionTier | null;
}

/**
 * Il blocco dei Fissati: una griglia di tessere, senza intestazione.
 *
 * ── Perché non c'è più un'etichetta ─────────────────────────────────────────
 * La griglia in cima È l'indicazione. Una fascia di tessere illuminate sopra la
 * lista non si confonde con la lista, e scrivere «FISSATI» sopra costava una
 * riga per dire quello che si vede già. Quello che si perde con l'intestazione
 * — collasso, conteggio, badge aggregato — si perde consapevolmente: il badge
 * aggregato esisteva perché la sezione poteva CHIUDERSI e nascondere il non
 * letto, e a tessere non si nasconde niente (ognuna porta il suo); il collasso
 * serviva a recuperare verticale, che è esattamente ciò che le tessere danno.
 *
 * ── Le righe le componi tu ──────────────────────────────────────────────────
 * Quante per riga non è un'impostazione: è quante ne hai messe. Trascinando una
 * tessera dentro una riga, le tessere di quella riga si stringono in diretta
 * alla misura che avranno — l'anteprima non è una simulazione, è il risultato
 * calcolato in anticipo dalla stessa funzione che poi lo applica.
 *
 * ── Il drag verso la griglia dei pane resta intatto ─────────────────────────
 * Niente `DndContext`: il `PointerSensor` di dnd-kit fa `preventDefault` sul
 * pointerdown e ucciderebbe il `dragstart` nativo, cioè il drag che porta un
 * fissato dentro la griglia. Qui si usa lo stesso HTML5 nativo del resto della
 * sidebar, e la tessera porta i due tipi che servono alle due destinazioni.
 */
export function PinnedTiles({
  items,
  layout,
  onLayoutChange,
  metaFor,
  onToggleItem,
  onContextMenu,
  onPinItem,
  renderExpanded,
}: {
  /** I fissati da mostrare, in ordine di pin. Il layout si riconcilia su questi. */
  items: SidebarItem[];
  layout: PinnedRow[];
  onLayoutChange: (next: PinnedRow[]) => void;
  metaFor: (item: SidebarItem) => PinnedTileMeta;
  /** Click su una tessera già espansa, o su una tessera senza contenuto da
   *  espandere: il chiamante decide (aprire la cosa, portarcisi sopra). */
  onToggleItem?: (item: SidebarItem, willExpand: boolean) => void;
  onContextMenu?: (item: SidebarItem, e: React.MouseEvent) => void;
  /** Fissa una cosa arrivata da FUORI (una riga dentro un gruppo, una tab, un
   *  progetto dell'albero). La chiave è già quella di riga: la conversione dalla
   *  pane la fa la griglia. `at` è la cella sotto il cursore quando il drop cade
   *  su una riga o fra due righe — senza, la tessera si accoda. */
  onPinItem?: (key: string, at?: PinnedDropTarget) => void;
  /** Il contenuto della fascia sotto la riga. `null` ⇒ la tessera non si espande. */
  renderExpanded: (item: SidebarItem) => ReactNode;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dragKey, setDragKey] = useState<string | null>(null);
  // `fromThisRow` si decide all'EVENTO, non al render: `dragKey` è stato, e il
  // primo `dragover` può arrivare prima che React l'abbia applicato — allora la
  // riga si crede bersaglio di un drag ESTERNO e disegna il fantasma invece di
  // riordinare. `dragKeyRef` è aggiornato in modo sincrono dal `dragstart`,
  // quindi la risposta giusta è già disponibile nel momento in cui serve.
  const [dropAt, setDropAt] = useState<
    { rowIdx: number; insertAt: number; fromThisRow: boolean; movingKey: string | null } | null
  >(null);
  const [newRowAt, setNewRowAt] = useState<number | null>(null);
  const [adopting, setAdopting] = useState(false);
  const dragKeyRef = useRef<string | null>(null);

  const byId = new Map(items.map(i => [i.id, i]));
  const rows = reconcilePinnedLayout(items.map(i => i.id), layout);

  const clearDrag = useCallback(() => {
    dragKeyRef.current = null;
    setDragKey(null);
    setDropAt(null);
    setNewRowAt(null);
    setAdopting(false);
  }, []);

  /** Un drag che possiamo servire: porta il tipo giusto E viene da QUESTA
   *  griglia. Un drag della stessa forma da un'altra finestra porterebbe il
   *  tipo ma non la chiave, e riordinare su una chiave che non abbiamo
   *  significherebbe inventarsi un movimento. */
  const isOurs = (e: React.DragEvent) =>
    dragKeyRef.current !== null && e.dataTransfer.types.includes(DND_TYPES.PINNED_TILE);

  /** Un drag che viene da FUORI e porta una pane: una riga dentro un gruppo,
   *  una tab della barra, il progetto nell'albero. Lasciarla qui vuol dire
   *  «questa la voglio sempre sotto mano», che è esattamente cosa significa
   *  fissare. */
  const isForeignPane = (e: React.DragEvent) =>
    !!onPinItem &&
    dragKeyRef.current === null &&
    (e.dataTransfer.types.includes(DND_TYPES.PANE_TAB) ||
      e.dataTransfer.types.includes(DND_TYPES.PANEL_ID));

  /** La chiave di riga della pane trascinata. Leggibile SOLO nel `drop`:
   *  durante il `dragover` il browser espone i tipi ma non i dati. */
  const foreignKey = (e: React.DragEvent): string | null => {
    const paneId = e.dataTransfer.getData(DND_TYPES.PANE_TAB)
      || e.dataTransfer.getData(DND_TYPES.PANEL_ID);
    return paneId ? pinKeyFromPaneId(paneId) : null;
  };

  /** Quante tessere della riga stanno a sinistra del cursore. */
  const insertIndexAt = (rowEl: HTMLElement, clientX: number): number => {
    const tiles = Array.from(rowEl.querySelectorAll<HTMLElement>('[data-pinned-tile]'));
    let n = 0;
    for (const t of tiles) {
      const r = t.getBoundingClientRect();
      if (clientX > r.left + r.width / 2) n++;
    }
    return n;
  };

  const commit = (next: PinnedRow[]) => {
    if (!samePinnedLayout(rows, next)) onLayoutChange(next);
    clearDrag();
  };

  const toggle = (item: SidebarItem) => {
    const willExpand = !expanded.has(item.id);
    if (renderExpanded(item) === null) {
      onToggleItem?.(item, false);
      return;
    }
    setExpanded(prev => {
      const next = new Set(prev);
      if (willExpand) next.add(item.id);
      else next.delete(item.id);
      return next;
    });
    onToggleItem?.(item, willExpand);
  };

  if (items.length === 0) return null;

  const anyExpanded = rows.some(r => r.keys.some(k => expanded.has(k)));

  /** La zona sottile fra due righe (e in fondo): ci si lascia cadere una
   *  tessera per aprire una riga nuova. A riposo è 6px di niente; sotto un drag
   *  compatibile si apre e si illumina, così il bersaglio esiste solo quando
   *  serve colpirlo. */
  const rowGap = (at: number) => {
    // L'ultimo spazio è SOLO un bersaglio, non ritmo: lo spazio sotto il blocco
    // appartiene a ciò che segue (il filo, che porta il suo margine). Dandogli
    // anche 6px a riposo i due si sommerebbero e il filo scivolerebbe via.
    const trailing = at === rows.length;
    return (
    <div
      key={`gap-${at}`}
      data-testid="pinned-new-row-zone"
      onDragOver={e => {
        const ours = isOurs(e);
        if (!ours && !isForeignPane(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = ours ? 'move' : 'copy';
        setDropAt(null);
        setNewRowAt(at);
      }}
      onDragLeave={() => setNewRowAt(cur => (cur === at ? null : cur))}
      onDrop={e => {
        const ours = isOurs(e);
        if (!ours && !isForeignPane(e)) return;
        e.preventDefault();
        // La sezione ha un `drop` suo che fissa SENZA posizione: se il gesto è
        // già stato servito qui, quello dietro accoderebbe la tessera dopo
        // averla piazzata.
        e.stopPropagation();
        if (ours) { commit(insertPinnedRow(rows, dragKeyRef.current!, at)); return; }
        const key = foreignKey(e);
        if (key) onPinItem?.(key, { kind: 'newRow', atRowIdx: at });
        clearDrag();
      }}
      className={`mx-1.5 rounded transition-all duration-100 ${
        newRowAt === at
          ? 'h-7 bg-primary/10 ring-1 ring-inset ring-primary/40'
          : dragKey || adopting
            ? 'h-2'
            : ''
      }`}
      style={newRowAt === at || dragKey || adopting ? undefined : { height: trailing ? 0 : TILE_GAP }}
    />
    );
  };

  return (
    <div
      data-testid="sidebar-pinned-section"
      // L'alone sulla SEZIONE è il ripiego: dice «cade nei Fissati» quando il
      // cursore non è ancora su nessuna cella. Appena una riga (o uno spazio fra
      // due righe) prende il drag, l'anteprima è quella — precisa — e tenere
      // acceso anche il riquadro grande direbbe due volte una cosa sola.
      className={`flex flex-col min-h-0 flex-shrink-0 rounded-lg transition-colors duration-100 ${
        adopting && !dropAt && newRowAt === null ? 'bg-primary/10 ring-1 ring-inset ring-primary/40' : ''
      }`}
      style={anyExpanded ? { maxHeight: EXPANDED_MAX_HEIGHT } : undefined}
      role="group"
      aria-label="Fissati"
      // Lasciare qui una cosa che arriva da fuori la FISSA. È il gesto inverso
      // di trascinarla via, e senza di esso l'unica strada per fissare era il
      // menu contestuale — che dentro una card di gruppo non tutte le righe hanno.
      onDragOver={e => {
        if (!isForeignPane(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (!adopting) setAdopting(true);
      }}
      onDragLeave={e => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setAdopting(false);
        setDropAt(null);
        setNewRowAt(null);
      }}
      onDrop={e => {
        if (!isForeignPane(e)) { setAdopting(false); return; }
        e.preventDefault();
        e.stopPropagation();
        const key = foreignKey(e);
        if (key) onPinItem?.(key);
        clearDrag();
      }}
    >
      {rows.map((row, rowIdx) => {
        const over = dropAt?.rowIdx === rowIdx;
        const dragFromThisRow = over ? dropAt.fromThisRow : false;
        // Da FUORI la riga guadagna una cella: si mostra il fantasma e le
        // larghezze che avrà. Da DENTRO il conteggio non cambia, e prima non si
        // mostrava niente — cioè proprio nel caso più comune (riordinare due
        // tessere vicine) trascinavi alla cieca. Ora la riga si RIORDINA in
        // diretta: quello che vedi mentre tieni premuto è come resterà.
        const adding = over && !dragFromThisRow;
        const reordering = over && dragFromThisRow;
        const widths = adding ? previewWidths(row, dropAt.insertAt) : row.widths;
        const openHere = row.keys.filter(k => expanded.has(k) && byId.has(k));

        let cells: Array<string | null> = [...row.keys];
        if (adding) {
          // Il fantasma è una cella in più: le chiavi vanno interlacciate con
          // lui per restare allineate alle larghezze.
          cells.splice(dropAt.insertAt, 0, null);
        } else if (reordering && dropAt.movingKey) {
          const moving = dropAt.movingKey;
          const from = cells.indexOf(moving);
          const rest = cells.filter(k => k !== moving);
          const at = Math.max(0, Math.min(dropAt.insertAt > from ? dropAt.insertAt - 1 : dropAt.insertAt, rest.length));
          rest.splice(at, 0, moving);
          cells = rest;
        }

        return (
          <div key={`row-${rowIdx}`} className="flex flex-col min-h-0">
            {rowGap(rowIdx)}
            <div
              data-testid="pinned-row"
              className="flex items-stretch px-1.5 flex-shrink-0"
              style={{ gap: TILE_GAP }}
              onDragOver={e => {
                const ours = isOurs(e);
                if (!ours && !isForeignPane(e)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = ours ? 'move' : 'copy';
                setNewRowAt(null);
                // Da fuori non c'è chiave da muovere: la riga GUADAGNA una
                // cella, quindi fantasma + larghezze finali — la stessa
                // anteprima del riordino, per lo stesso motivo (vedere dove
                // finisce prima di lasciare).
                const moving = ours ? dragKeyRef.current : null;
                setDropAt({
                  rowIdx,
                  insertAt: insertIndexAt(e.currentTarget, e.clientX),
                  fromThisRow: moving !== null && row.keys.includes(moving),
                  movingKey: moving,
                });
              }}
              onDragLeave={e => {
                // Solo quando si esce DAVVERO dalla riga: `dragleave` scatta
                // anche passando da una tessera all'altra dentro la stessa riga.
                if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                setDropAt(cur => (cur?.rowIdx === rowIdx ? null : cur));
              }}
              onDrop={e => {
                const ours = isOurs(e);
                if (!ours && !isForeignPane(e)) return;
                e.preventDefault();
                e.stopPropagation(); // vedi `rowGap`: la sezione fissa senza posizione
                const insertAt = insertIndexAt(e.currentTarget, e.clientX);
                if (ours) { commit(movePinnedTile(rows, dragKeyRef.current!, { rowIdx, insertAt })); return; }
                const key = foreignKey(e);
                if (key) onPinItem?.(key, { kind: 'row', rowIdx, insertAt });
                clearDrag();
              }}
            >
              {cells.map((key, i) => {
                const flex = { flex: `${widths[i] ?? 1 / cells.length} 1 0%`, minWidth: 0 };
                if (key === null) {
                  return (
                    <div
                      key="ghost"
                      data-testid="pinned-drop-ghost"
                      style={flex}
                      className="h-14 rounded-lg border border-dashed border-primary/50 bg-primary/5"
                    />
                  );
                }
                const item = byId.get(key);
                if (!item) return null;
                const meta = metaFor(item);
                return (
                  <div
                    key={key}
                    style={flex}
                    className={reordering && dropAt.movingKey === key ? 'opacity-70 transition-opacity' : undefined}
                  >
                    <PinnedTile
                      item={item}
                      expanded={expanded.has(key)}
                      focused={meta.focused}
                      attention={meta.attention}
                      dragging={dragKey === key && !reordering}
                      onToggle={() => toggle(item)}
                      onContextMenu={e => onContextMenu?.(item, e)}
                      onDragStart={() => { dragKeyRef.current = key; setDragKey(key); }}
                      onDragEnd={clearDrag}
                    />
                  </div>
                );
              })}
            </div>

            {/* Le fasce delle tessere aperte DI QUESTA RIGA, subito sotto di
                lei: è letteralmente «sotto la riga dove si trova il progetto».
                Più fasce aperte si dividono l'altezza (`flex: 1 1 0`), e ognuna
                scorre per conto suo invece di spingere fuori le altre. */}
            {openHere.map(key => {
              const item = byId.get(key)!;
              return (
                <div
                  key={`band-${key}`}
                  data-testid="pinned-expansion"
                  data-pinned-expansion={key}
                  // Stesso passo di tutto il resto sopra la fascia; sotto ci
                  // pensa lo spazio della riga seguente (o il filo, se è
                  // l'ultima): due margini che si sommano sono un ritmo rotto.
                  className="flex-1 min-h-0 overflow-y-auto sidebar-scroll mx-1.5 mt-1.5 mb-0 rounded-lg bg-black/[0.03] dark:bg-white/[0.03]"
                  onKeyDown={e => {
                    if (e.key !== 'Escape') return;
                    e.stopPropagation();
                    setExpanded(prev => {
                      const next = new Set(prev);
                      next.delete(key);
                      return next;
                    });
                  }}
                >
                  {renderExpanded(item)}
                </div>
              );
            })}
          </div>
        );
      })}
      {rowGap(rows.length)}
    </div>
  );
}
