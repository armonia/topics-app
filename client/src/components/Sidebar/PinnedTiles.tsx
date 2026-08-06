import { useCallback, useRef, useState, type ReactNode } from 'react';
import type { SidebarItem } from '../../lib/buildSidebarItems';
import type { AttentionTier } from '../../types';
import { DND_TYPES } from '../../lib/dndTypes';
import { PinnedTile } from './PinnedTile';
import {
  insertPinnedRow,
  movePinnedTile,
  previewWidths,
  reconcilePinnedLayout,
  samePinnedLayout,
  type PinnedRow,
} from './pinnedLayout';

/** Spazio fra le tessere, in px. Anche il gap che le righe usano fra loro. */
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
  /** Il contenuto della fascia sotto la riga. `null` ⇒ la tessera non si espande. */
  renderExpanded: (item: SidebarItem) => ReactNode;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ rowIdx: number; insertAt: number } | null>(null);
  const [newRowAt, setNewRowAt] = useState<number | null>(null);
  const dragKeyRef = useRef<string | null>(null);

  const byId = new Map(items.map(i => [i.id, i]));
  const rows = reconcilePinnedLayout(items.map(i => i.id), layout);

  const clearDrag = useCallback(() => {
    dragKeyRef.current = null;
    setDragKey(null);
    setDropAt(null);
    setNewRowAt(null);
  }, []);

  /** Un drag che possiamo servire: porta il tipo giusto E viene da QUESTA
   *  griglia. Un drag della stessa forma da un'altra finestra porterebbe il
   *  tipo ma non la chiave, e riordinare su una chiave che non abbiamo
   *  significherebbe inventarsi un movimento. */
  const isOurs = (e: React.DragEvent) =>
    dragKeyRef.current !== null && e.dataTransfer.types.includes(DND_TYPES.PINNED_TILE);

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
  const rowGap = (at: number) => (
    <div
      key={`gap-${at}`}
      data-testid="pinned-new-row-zone"
      onDragOver={e => {
        if (!isOurs(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDropAt(null);
        setNewRowAt(at);
      }}
      onDragLeave={() => setNewRowAt(cur => (cur === at ? null : cur))}
      onDrop={e => {
        if (!isOurs(e)) return;
        e.preventDefault();
        commit(insertPinnedRow(rows, dragKeyRef.current!, at));
      }}
      className={`mx-1.5 rounded transition-all duration-100 ${
        newRowAt === at
          ? 'h-7 bg-primary/10 ring-1 ring-inset ring-primary/40'
          : dragKey
            ? 'h-2'
            : 'h-0'
      }`}
    />
  );

  return (
    <div
      data-testid="sidebar-pinned-section"
      className="flex flex-col min-h-0 flex-shrink-0"
      style={anyExpanded ? { maxHeight: EXPANDED_MAX_HEIGHT } : undefined}
      role="group"
      aria-label="Fissati"
    >
      {rows.map((row, rowIdx) => {
        const dragFromThisRow = dragKey !== null && row.keys.includes(dragKey);
        const targeting = dropAt?.rowIdx === rowIdx && !dragFromThisRow;
        // Le misure in diretta: se la tessera atterra qui, la riga avrà queste
        // larghezze — le stesse che il drop poi scrive.
        const widths = targeting ? previewWidths(row, dropAt.insertAt) : row.widths;
        const openHere = row.keys.filter(k => expanded.has(k) && byId.has(k));

        // Con il fantasma la riga ha una cella in più: le chiavi vanno
        // interlacciate con lui per restare allineate alle larghezze.
        const cells: Array<string | null> = [...row.keys];
        if (targeting) cells.splice(dropAt.insertAt, 0, null);

        return (
          <div key={`row-${rowIdx}`} className="flex flex-col min-h-0">
            {rowGap(rowIdx)}
            <div
              className="flex items-stretch px-1.5 flex-shrink-0"
              style={{ gap: TILE_GAP }}
              onDragOver={e => {
                if (!isOurs(e)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setNewRowAt(null);
                setDropAt({ rowIdx, insertAt: insertIndexAt(e.currentTarget, e.clientX) });
              }}
              onDragLeave={e => {
                // Solo quando si esce DAVVERO dalla riga: `dragleave` scatta
                // anche passando da una tessera all'altra dentro la stessa riga.
                if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                setDropAt(cur => (cur?.rowIdx === rowIdx ? null : cur));
              }}
              onDrop={e => {
                if (!isOurs(e)) return;
                e.preventDefault();
                const insertAt = insertIndexAt(e.currentTarget, e.clientX);
                commit(movePinnedTile(rows, dragKeyRef.current!, { rowIdx, insertAt }));
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
                  <div key={key} style={flex}>
                    <PinnedTile
                      item={item}
                      expanded={expanded.has(key)}
                      focused={meta.focused}
                      attention={meta.attention}
                      dragging={dragKey === key}
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
                  className="flex-1 min-h-0 overflow-y-auto sidebar-scroll mx-1.5 mt-1 mb-0.5 rounded-lg bg-black/[0.03] dark:bg-white/[0.03]"
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
