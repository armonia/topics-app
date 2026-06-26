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
import React, { useRef } from 'react';
import { type LayoutNode, type SplitDir, isLeaf } from '../../state/layout/layoutTree';

export interface SplitTreeProps {
  node: LayoutNode;
  /** Render a leaf's content by its opaque id (pane key / group id). */
  renderLeaf: (id: string) => React.ReactNode;
  /** Px strip between siblings where the divider lives (and, for native browser
   *  panes, where the webview bounds are inset so the divider is hittable). */
  gutter?: number;
  /** Drag on the divider after child `dividerIdx` of the split at `path`, by
   *  `deltaPx` along the split axis. The host maps this onto `resizeAt`. */
  onResize?: (path: number[], dividerIdx: number, deltaPx: number) => void;
  /** Internal: child-index path from the root (don't pass at the top level). */
  path?: number[];
}

export function SplitTree({ node, renderLeaf, gutter = 0, onResize, path = [] }: SplitTreeProps): React.ReactElement {
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
      {node.children.map((child, i) => (
        <React.Fragment key={keyFor(child.node, i)}>
          {i > 0 && (
            <Divider
              dir={node.dir}
              gutter={gutter}
              onResize={(deltaPx) => onResize?.(path, i - 1, deltaPx)}
            />
          )}
          <div style={{ flex: `${child.weight} 1 0%`, minWidth: 0, minHeight: 0, position: 'relative' }}>
            <SplitTree
              node={child.node}
              renderLeaf={renderLeaf}
              gutter={gutter}
              onResize={onResize}
              path={[...path, i]}
            />
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}

/** A stable-ish React key: leaves key on their id; splits on index + first leaf. */
function keyFor(node: LayoutNode, index: number): string {
  if (isLeaf(node)) return `leaf:${node.id}`;
  // cheap first-leaf probe without importing leafIds (avoid a full walk per render)
  let n: LayoutNode = node;
  while (!isLeaf(n)) n = n.children[0].node;
  return `split:${index}:${n.id}`;
}

interface DividerProps {
  dir: SplitDir;
  gutter: number;
  onResize: (deltaPx: number) => void;
}

/** The resize handle between two siblings. A `row` split (children side-by-side)
 *  gets a VERTICAL divider dragged along X; a `col` split a horizontal one along
 *  Y. Reports an incremental pixel delta per move. */
function Divider({ dir, gutter, onResize }: DividerProps): React.ReactElement {
  const horizontal = dir === 'row';
  const lastRef = useRef<number | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    lastRef.current = horizontal ? e.clientX : e.clientY;
    window.dispatchEvent(new CustomEvent('topics:pane-resize-start'));
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (lastRef.current == null) return;
    const cur = horizontal ? e.clientX : e.clientY;
    const delta = cur - lastRef.current;
    if (delta !== 0) {
      lastRef.current = cur;
      onResize(delta);
    }
  };
  const end = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (lastRef.current == null) return;
    lastRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be gone */
    }
    window.dispatchEvent(new CustomEvent('topics:pane-resize-end'));
  };

  // The visible strip is `gutter` wide; an absolutely-positioned wider band
  // (±5px past the gutter on the drag axis) makes a thin gutter easy to grab,
  // without consuming layout space. z-50 keeps it above adjacent pane content.
  return (
    <div
      role="separator"
      aria-orientation={horizontal ? 'vertical' : 'horizontal'}
      data-split-divider={dir}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      style={{
        flex: `0 0 ${gutter}px`,
        position: 'relative',
        zIndex: 50,
        cursor: horizontal ? 'col-resize' : 'row-resize',
        touchAction: 'none',
      }}
    >
      <div
        style={{
          position: 'absolute',
          ...(horizontal
            ? { top: 0, bottom: 0, left: -5, right: -5 }
            : { left: 0, right: 0, top: -5, bottom: -5 }),
        }}
      />
    </div>
  );
}
