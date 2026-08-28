/**
 * SplitTree — the single recursive renderer for the new split engine (P2).
 *
 * Draws a `LayoutNode` as nested flex containers: a `row` split lays its children
 * side-by-side, a `col` split stacks them, each child sized by the SAME
 * `flex: <weight> 1 0%` invariant the current two engines use (so geometry is
 * unchanged) — but at arbitrary depth, from ONE component instead of PanelGrid's
 * row/col render plus GroupLayout's row/cellStacks render. Leaf content is
 * supplied by the host via `renderLeaf(id)`, so this stays presentational and
 * decoupled from the pane components.
 *
 * Dividers live BETWEEN siblings in a dedicated strip (the `gutter`), lifted to
 * z-50 so adjacent pane content can't steal the grab (the divider-hover lesson),
 * and report a pixel delta on drag; the host hook converts that to a weight delta
 * (`pxToWeightDelta`, then applies it to its own row model). On gesture start/end it fires the existing
 * `topics:pane-resize-start` / `-end` events so the per-region vibrancy freezes
 * and snaps exactly like it does for the legacy engines.
 *
 * LIVE: this is the sole split renderer for BOTH surfaces — PanelGrid (standalone
 * grid) and GroupLayout (project window) each build a shallow LayoutNode from
 * their rows and render it through this component. It is NOT dead / behind a flag;
 * deleting it breaks all tiling.
 */
import React, { useRef, useState, useEffect, useCallback } from 'react';
import { type LayoutNode, type SplitDir, isLeaf } from '../../state/layout/layoutTree';
import { gapHasDivider } from './splitDivider';

export interface SplitTreeProps {
  node: LayoutNode;
  /** Render a leaf's content by its opaque id (pane key / group id). */
  renderLeaf: (id: string) => React.ReactNode;
  /** Px strip between siblings where the divider lives (and, for native browser
   *  panes, where the webview bounds are inset so the divider is hittable). */
  gutter?: number;
  /** Drag on the divider after child `dividerIdx` of the split at `path`, by
   *  `deltaPx` along the split axis, within a band of `bandPx` total px. The host
   *  converts px→weight via `pxToWeightDelta(bandPx, deltaPx)` and applies it to
   *  its own row model (`splitController.resizeWeights`). */
  onResize?: (path: number[], dividerIdx: number, deltaPx: number, bandPx: number) => void;
  /** Double-click the divider after child `dividerIdx` → even out the band at
   *  `path` (host evens the corresponding row/column). Double-click-a-divider semantics. */
  onEqualize?: (path: number[], dividerIdx: number) => void;
  /** Optional: render the divider strip between siblings yourself instead of the
   *  built-in <Divider>. Lets a host inject a richer handle (e.g. the legacy
   *  Column/RowInsertDivider that also does double-click-equalize and accepts
   *  drag-drop insert-between) while SplitTree still owns the flex structure.
   *  Receives the split's `path`, the index of the gap (`dividerIdx`, i.e. the
   *  divider sits AFTER child `dividerIdx`), and the split axis `dir`. Return
   *  `null` to fall back to the built-in divider for that gap. */
  renderDivider?: (info: { path: number[]; dividerIdx: number; dir: SplitDir }) => React.ReactNode;
  /** Internal: child-index path from the root (don't pass at the top level). */
  path?: number[];
}

export function SplitTree({ node, renderLeaf, gutter = 0, onResize, onEqualize, renderDivider, path = [] }: SplitTreeProps): React.ReactElement {
  if (isLeaf(node)) {
    return (
      <div data-split-leaf={node.id} style={{ width: '100%', height: '100%', minWidth: 0, minHeight: 0 }}>
        {renderLeaf(node.id)}
      </div>
    );
  }

  const horizontal = node.dir === 'row';
  return (
    <div
      // The SHAPE of the tiling, published so a test can assert the tree a
      // gesture produced instead of a screenshot of it: leaves already carry
      // `data-split-leaf`, this is the split above them and the axis it runs on.
      // Reading `[data-split-node]` / `[data-split-leaf]` nesting under
      // `[data-split-surface]` reconstructs the whole layout.
      data-split-node={node.dir}
      data-split-arity={node.children.length}
      style={{
        display: 'flex',
        flexDirection: horizontal ? 'row' : 'column',
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
      }}
    >
      {node.children.map((child, i) => {
        // Only a gap BETWEEN two visible (weight > 0) siblings carries a
        // divider. A dedup'd/placeholder cell collapses to weight 0 (see
        // buildShallowGridTree's `__skip:` leaves): rendering a divider next to
        // a zero-width cell puts a dead, zero-width grab strip ON TOP of the
        // adjacent real divider's band — the real resizer then reads as "lost"
        // (unhittable). `dividerIdx` stays `i - 1` so it still maps onto the
        // host's full weight band (which includes the zero entry).
        const showGap = gapHasDivider(node.children, i);
        // A host-supplied divider takes precedence; it returns null to defer to
        // the built-in one. The host gets (path, dividerIdx=i-1, dir) so it can
        // map the gap back to its own model (e.g. legacy rowIdx/colIdx).
        const custom = showGap && renderDivider ? renderDivider({ path, dividerIdx: i - 1, dir: node.dir }) : null;
        return (
          <React.Fragment key={keyFor(child.node, i)}>
            {showGap && (custom ?? (
              <Divider
                dir={node.dir}
                gutter={gutter}
                onResize={(deltaPx, bandPx) => onResize?.(path, i - 1, deltaPx, bandPx)}
                onEqualize={onEqualize ? () => onEqualize(path, i - 1) : undefined}
              />
            ))}
            <div style={{ flex: `${child.weight} 1 0%`, minWidth: 0, minHeight: 0, position: 'relative' }}>
              <SplitTree
                node={child.node}
                renderLeaf={renderLeaf}
                gutter={gutter}
                onResize={onResize}
                onEqualize={onEqualize}
                renderDivider={renderDivider}
                path={[...path, i]}
              />
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

/** A stable React key for a child slot. Leaves key on their opaque id (so a leaf
 *  that moves keeps its identity / DOM subtree). A split keys on its sibling
 *  INDEX alone — NOT its first-leaf id: in a 1:1-with-gridRows tree, closing the
 *  first column of a row would otherwise re-key that row (split:0:A → split:0:B)
 *  and remount every untouched sibling subtree (terminal PTY reset, native
 *  browser reload, lost chat draft). Index matches the legacy `key={rowIdx}`. */
function keyFor(node: LayoutNode, index: number): string {
  return isLeaf(node) ? `leaf:${node.id}` : `split:${index}`;
}

interface DividerProps {
  dir: SplitDir;
  gutter: number;
  /** Commit the resize ONCE on release: the TOTAL signed px the divider moved
   *  along the split axis, within the parent band of `bandPx`. The host maps it
   *  via `pxToWeightDelta` + `resizeWeights`. */
  onResize: (deltaPx: number, bandPx: number) => void;
  /** Double-click → even out the band (1/n). */
  onEqualize?: () => void;
}

/** Px the pointer must travel before the resize engages — kills the phantom
 *  sub-pixel resize a jittery click would produce, and leaves the double-click →
 *  equalize gesture room to fire. */
const DRAG_SLOP_PX = 3;
/** Floor a child can't shrink past during a drag — matches MIN_PANE_FRACTION so
 *  the live DOM resize and the committed `resizeWeights` agree exactly. */
const MIN_CHILD_FRACTION = 0.1;

/**
 * The resize handle between two siblings. A `row` split (children side-by-side)
 * gets a VERTICAL divider dragged along X; a `col` split a horizontal one along Y.
 *
 * DOM-DIRECT, mirroring the legacy useGridResize / CellSubStack path: during the
 * drag we mutate the two flanking flex children's `flex-grow` INLINE (zero React
 * re-renders — the pane bodies don't reconcile per mousemove, so a divider drags
 * 1:1 with the cursor with no jank), and commit the final size to React state
 * ONCE on release. A lazily-raised full-viewport overlay keeps the pointer from
 * being swallowed by an iframe / native browser pane, and pairs the
 * `topics:pane-resize-start` / `-end` so those panes hide for the drag's duration.
 * The start/end pair is always balanced — even if the divider unmounts mid-drag.
 */
function Divider({ dir, gutter, onResize, onEqualize }: DividerProps): React.ReactElement {
  const horizontal = dir === 'row';
  const [active, setActive] = useState(false);
  // Teardown for the in-flight drag so an unmount-mid-drag finishes it cleanly.
  const cleanupRef = useRef<(() => void) | null>(null);

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    const dividerEl = e.currentTarget;
    const container = dividerEl.parentElement;
    const prevSib = dividerEl.previousElementSibling as HTMLElement | null;
    const nextSib = dividerEl.nextElementSibling as HTMLElement | null;
    if (!container || !prevSib || !nextSib) return;
    // Narrowed non-null for the closures below (a hoisted `finish` wouldn't keep
    // the early-return narrowing on the nullable bindings otherwise).
    const prevEl: HTMLElement = prevSib;
    const nextEl: HTMLElement = nextSib;
    const rect = container.getBoundingClientRect();
    const bandPx = horizontal ? rect.width : rect.height;
    if (bandPx <= 0) return;

    const startPos = horizontal ? e.clientX : e.clientY;
    // The flanking children carry their weight as `flex-grow` (SplitTree sets
    // `flex: <weight> 1 0%`); read it so the new split stays in the SAME scale as
    // the untouched siblings (3+-column rows resize correctly, not just 2).
    const startPrev = parseFloat(getComputedStyle(prevEl).flexGrow) || 0;
    const startNext = parseFloat(getComputedStyle(nextEl).flexGrow) || 0;
    const combined = startPrev + startNext;
    const floor = Math.min(MIN_CHILD_FRACTION, combined / 2); // never invert a tiny band
    const prevTransPrev = prevEl.style.transition;
    const prevTransNext = nextEl.style.transition;
    prevEl.style.transition = 'none';
    nextEl.style.transition = 'none';

    let overlay: HTMLDivElement | null = null;
    const raiseChrome = (): void => {
      if (overlay) return;
      overlay = document.createElement('div');
      overlay.style.cssText = `position:fixed;inset:0;z-index:2147483647;cursor:${horizontal ? 'col-resize' : 'row-resize'}`;
      document.body.appendChild(overlay);
      setActive(true);
      window.dispatchEvent(new Event('topics:pane-resize-start'));
    };

    let latestDelta = 0;
    const onMove = (ev: MouseEvent): void => {
      // Lost-mouseup recovery: released over another app / native view.
      if ((ev.buttons & 1) === 0) { finish(); return; }
      const cur = horizontal ? ev.clientX : ev.clientY;
      const rawDelta = cur - startPos;
      if (!overlay && Math.abs(rawDelta) <= DRAG_SLOP_PX) return; // sub-slop = still a click
      raiseChrome();
      const deltaFrac = rawDelta / bandPx;
      let nextPrev = startPrev + deltaFrac;
      if (nextPrev < floor) nextPrev = floor;
      else if (nextPrev > combined - floor) nextPrev = combined - floor;
      const nextNext = combined - nextPrev;
      prevEl.style.flex = `${nextPrev} 1 0%`;
      nextEl.style.flex = `${nextNext} 1 0%`;
      latestDelta = rawDelta;
    };
    let finished = false;
    function finish(): void {
      if (finished) return;
      finished = true;
      cleanupRef.current = null;
      setActive(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', finish);
      prevEl.style.transition = prevTransPrev;
      nextEl.style.transition = prevTransNext;
      if (overlay) {
        overlay.remove();
        overlay = null;
        window.dispatchEvent(new Event('topics:pane-resize-end'));
      }
      // Commit ONCE — and only for a real drag. A bare click leaves latestDelta 0
      // (no phantom resize) so the double-click → equalize handler isn't pre-empted.
      if (latestDelta !== 0) onResize(latestDelta, bandPx);
    }
    cleanupRef.current = finish;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', finish);
  }, [horizontal, onResize]);

  // Unmount mid-drag (a concurrent column close re-keys the row): finish so the
  // listeners, overlay and the resize start/end count stay balanced.
  useEffect(() => () => { cleanupRef.current?.(); }, []);

  // The divider reuses the shared `.cursor-col-resize` / `.cursor-row-resize`
  // component class (index.css): it owns the z-50 lift, the ±10px ::before grab
  // band, and the ::after primary bar that fades in on hover. The element's own
  // `bg-app-border` paints the 1px resting line — which the floating-splits rules
  // null at rest over a vibrancy gap (and restore for dividers nested in a card),
  // because those rules key on that background. `is-resizing` keeps the bar lit
  // while a drag continues even if the pointer leaves the gutter. This matches the
  // legacy GroupLayout/PanelGrid dividers exactly, so floating-splits composes
  // again (the inline reimplementation had dropped the class and painted a resting
  // seam the floating rules couldn't reach).
  return (
    <div
      role="separator"
      aria-orientation={horizontal ? 'vertical' : 'horizontal'}
      data-split-divider={dir}
      // L'ASSE CHE QUESTO DIVISORE RIDIMENSIONA, e NON è un doppione di
      // `data-split-divider` qui sopra: quello porta la direzione dello SPLIT
      // (`row` = figli affiancati), questo l'asse del TRASCINAMENTO — e i due
      // sono invertiti, perché uno split `row` si ridimensiona in colonna.
      // Due vocabolari sotto lo stesso nome sarebbero il prossimo near-miss.
      //
      // Serve perché `cursor-col-resize` è un SUGGERIMENTO DI CURSORE, e lo
      // portano anche cose che divisori non sono — il ridimensionatore della
      // barra di progetto, per dirne una. Contare la classe vuol dire contare
      // quelli: è così che GRID-09 è rimasto rosso per giorni su una griglia
      // che il reset aveva ripulito davvero, perché sopravviveva un
      // `project-sidebar-resizer` largo 0×0 dentro una pane tenuta viva e
      // nascosta. Il rosso era vero e il difetto non c'era.
      data-resize-axis={horizontal ? 'col' : 'row'}
      className={`bg-app-border ${horizontal ? 'cursor-col-resize' : 'cursor-row-resize'}${active ? ' is-resizing' : ''}`}
      onMouseDown={onMouseDown}
      onDoubleClick={onEqualize ? (e) => { e.preventDefault(); e.stopPropagation(); onEqualize(); } : undefined}
      style={{
        flex: `0 0 ${gutter}px`,
        position: 'relative',
        touchAction: 'none',
      }}
    />
  );
}
