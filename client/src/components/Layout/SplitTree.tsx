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
 * (`pxToWeightDelta` + `resizeAt`). On gesture start/end it fires the existing
 * `topics:pane-resize-start` / `-end` events so the per-region vibrancy freezes
 * and snaps exactly like it does for the legacy engines.
 *
 * ADDITIVE / behind the P2 flag — not wired into any surface yet. Integration
 * (swapping PanelGrid/GroupLayout to render via this) is the user-verified step.
 */
import React, { useRef, useState, useEffect } from 'react';
import { type LayoutNode, type SplitDir, isLeaf } from '../../state/layout/layoutTree';

export interface SplitTreeProps {
  node: LayoutNode;
  /** Render a leaf's content by its opaque id (pane key / group id). */
  renderLeaf: (id: string) => React.ReactNode;
  /** Px strip between siblings where the divider lives (and, for native browser
   *  panes, where the webview bounds are inset so the divider is hittable). */
  gutter?: number;
  /** Drag on the divider after child `dividerIdx` of the split at `path`, by
   *  `deltaPx` along the split axis, within a band of `bandPx` total px. The host
   *  maps this onto `resizeAt` via `pxToWeightDelta(bandPx, deltaPx)`. */
  onResize?: (path: number[], dividerIdx: number, deltaPx: number, bandPx: number) => void;
  /** Double-click the divider after child `dividerIdx` → even out the band at
   *  `path` (host maps to `equalizeAt`). Double-click-a-divider semantics. */
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
        // A host-supplied divider takes precedence; it returns null to defer to
        // the built-in one. The host gets (path, dividerIdx=i-1, dir) so it can
        // map the gap back to its own model (e.g. legacy rowIdx/colIdx).
        const custom = i > 0 && renderDivider ? renderDivider({ path, dividerIdx: i - 1, dir: node.dir }) : null;
        return (
          <React.Fragment key={keyFor(child.node, i)}>
            {i > 0 && (custom ?? (
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
  onResize: (deltaPx: number, bandPx: number) => void;
  /** Double-click → even out the band (1/n). */
  onEqualize?: () => void;
}

/** Px the pointer must travel before the first resize commits — kills the
 *  phantom sub-pixel resize a jittery click would otherwise produce (and leaves
 *  room for the double-click→equalize gesture). */
const DRAG_SLOP_PX = 3;

/** The resize handle between two siblings. A `row` split (children side-by-side)
 *  gets a VERTICAL divider dragged along X; a `col` split a horizontal one along
 *  Y. Pointer moves are coalesced through one rAF per frame (so a 120Hz trackpad
 *  doesn't fire two state commits per frame), and the gesture self-balances its
 *  `pane-resize-start`/`-end` even if the divider unmounts mid-drag. */
function Divider({ dir, gutter, onResize, onEqualize }: DividerProps): React.ReactElement {
  const horizontal = dir === 'row';
  const lastRef = useRef<number | null>(null);   // last pointer coord; null = idle
  const startRef = useRef<number>(0);            // pointer coord at gesture start (slop)
  const bandRef = useRef<number>(0);
  const pendingRef = useRef<number>(0);          // accumulated px delta awaiting flush
  const rafRef = useRef<number | null>(null);
  const passedSlopRef = useRef<boolean>(false);
  const [hover, setHover] = useState(false);

  const flush = (): void => {
    rafRef.current = null;
    const d = pendingRef.current;
    pendingRef.current = 0;
    if (d !== 0) onResize(d, bandRef.current);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const pos = horizontal ? e.clientX : e.clientY;
    lastRef.current = pos;
    startRef.current = pos;
    passedSlopRef.current = false;
    pendingRef.current = 0;
    // The band is the flex container this divider sits in — its size along the
    // split axis is what a pixel drag is a fraction OF.
    const parent = e.currentTarget.parentElement?.getBoundingClientRect();
    bandRef.current = parent ? (horizontal ? parent.width : parent.height) : 0;
    window.dispatchEvent(new CustomEvent('topics:pane-resize-start'));
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (lastRef.current == null) return;
    const cur = horizontal ? e.clientX : e.clientY;
    if (!passedSlopRef.current) {
      if (Math.abs(cur - startRef.current) < DRAG_SLOP_PX) return;
      passedSlopRef.current = true;
      lastRef.current = startRef.current; // count the delta from the true start, no jump
    }
    const delta = cur - lastRef.current;
    if (delta === 0) return;
    lastRef.current = cur;
    pendingRef.current += delta;
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(flush);
  };
  const end = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (lastRef.current == null) return;
    lastRef.current = null;
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (pendingRef.current !== 0) { onResize(pendingRef.current, bandRef.current); pendingRef.current = 0; }
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be gone */
    }
    window.dispatchEvent(new CustomEvent('topics:pane-resize-end'));
  };

  // If the divider unmounts mid-drag (a concurrent column close re-keys the row),
  // pointerup never reaches us — balance the start with an end so the per-region
  // vibrancy / native browser panes don't stay frozen for the rest of the session.
  useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    if (lastRef.current != null) window.dispatchEvent(new CustomEvent('topics:pane-resize-end'));
  }, []);

  // The visible strip is `gutter` wide; an absolutely-positioned wider band
  // (±5px past the gutter on the drag axis) makes a thin gutter easy to grab,
  // without consuming layout space. z-50 keeps it above adjacent pane content.
  // A 1px hairline (brighter on hover) gives the otherwise-invisible grab strip
  // a visible seam, matching the legacy dividers.
  return (
    <div
      role="separator"
      aria-orientation={horizontal ? 'vertical' : 'horizontal'}
      data-split-divider={dir}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={onEqualize ? (e) => { e.preventDefault(); e.stopPropagation(); onEqualize(); } : undefined}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      style={{
        flex: `0 0 ${gutter}px`,
        position: 'relative',
        zIndex: 50,
        cursor: horizontal ? 'col-resize' : 'row-resize',
        touchAction: 'none',
      }}
    >
      {/* widened invisible grab band (no layout cost) */}
      <div
        style={{
          position: 'absolute',
          ...(horizontal
            ? { top: 0, bottom: 0, left: -5, right: -5 }
            : { left: 0, right: 0, top: -5, bottom: -5 }),
        }}
      />
      {/* visible 1px hairline, centered on the gutter */}
      <div
        style={{
          position: 'absolute',
          background: 'var(--border, rgba(128,128,128,0.25))',
          transition: 'background 120ms, box-shadow 120ms',
          ...(horizontal
            ? { top: 0, bottom: 0, left: '50%', width: 1, transform: 'translateX(-0.5px)' }
            : { left: 0, right: 0, top: '50%', height: 1, transform: 'translateY(-0.5px)' }),
          ...(hover ? { background: 'var(--primary)', boxShadow: '0 0 0 0.5px var(--primary)' } : {}),
        }}
      />
    </div>
  );
}
