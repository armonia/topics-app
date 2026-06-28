/**
 * useSplitController — the stateful glue for the new split engine (P2).
 *
 * Owns the live `LayoutNode` and turns user gestures into pure tree ops:
 *   - divider drag  → `pxToWeightDelta` + `resizeAt`
 *   - tab drop      → `dropZone` (edge → `moveLeaf` / center → host tab-into)
 *   - split/close/equalize/maximize → the matching `layoutTree` reducers
 *
 * `<SplitTree onResize={ctl.onResize} .../>` wires the divider drags straight in.
 * Everything is a pure reducer underneath, so the controller is a thin
 * useState + useCallback shell — the testable logic lives in layoutTree /
 * splitController. ADDITIVE / behind the P2 flag; the host swaps PanelGrid /
 * GroupLayout to drive this at the (user-verified) integration step.
 */
import { useCallback, useRef, useState } from 'react';
import {
  type LayoutNode,
  type DropEdge,
  type Rect,
  resizeAt,
  equalizeAt,
  equalizeAll as equalizeAllOp,
  splitLeaf,
  closeLeaf,
  moveLeaf,
} from '../state/layout/layoutTree';
import { dropZone, pxToWeightDelta } from '../state/layout/splitController';

export interface SplitController {
  tree: LayoutNode;
  /** Replace the whole tree (hydrate / external sync). */
  setTree: (next: LayoutNode) => void;
  /** Wire to `<SplitTree onResize={...}>`. */
  onResize: (path: number[], dividerIdx: number, deltaPx: number, bandPx: number) => void;
  /** Split `targetId` on `edge`, inserting `newId`. */
  split: (targetId: string, edge: DropEdge, newId: string, ratio?: number) => void;
  /** Remove `targetId`. Returns false (and leaves the tree unchanged) when it's
   *  the last leaf — the host decides what an empty layout means. */
  close: (targetId: string) => boolean;
  /** Relocate `sourceId` to `edge` of `targetId`. */
  move: (sourceId: string, targetId: string, edge: DropEdge, ratio?: number) => void;
  /** Drop `sourceId` onto `targetId`'s rect at (px,py): edge → split-move,
   *  center → 'center' (host adds it as a tab), same/absent → 'noop'. */
  dropOnLeaf: (sourceId: string, targetId: string, rect: Rect, px: number, py: number) => 'moved' | 'center' | 'noop';
  /** Even out the band at `path` (1/n). `[]` = the root. */
  equalize: (path: number[]) => void;
  /** Even out every split in the tree. */
  equalizeAll: () => void;
}

export function useSplitController(initial: LayoutNode): SplitController {
  const [tree, setTree] = useState<LayoutNode>(initial);
  // Mirror the committed tree in a ref. `close` must decide its boolean return from the
  // CURRENT tree synchronously; reading a `[tree]`-dep closure made its identity churn on
  // every resize AND risked a stale value if called twice before a re-render. The ref is
  // kept current on every render and advanced eagerly by `close`, so the callback can be
  // `[]`-stable like every other op.
  const treeRef = useRef(tree);
  treeRef.current = tree;

  const onResize = useCallback(
    (path: number[], dividerIdx: number, deltaPx: number, bandPx: number) => {
      const wd = pxToWeightDelta(bandPx, deltaPx);
      if (wd === 0) return;
      setTree((t) => resizeAt(t, path, dividerIdx, wd));
    },
    [],
  );

  const split = useCallback((targetId: string, edge: DropEdge, newId: string, ratio?: number) => {
    setTree((t) => splitLeaf(t, targetId, edge, newId, ratio));
  }, []);

  const close = useCallback(
    (targetId: string): boolean => {
      const next = closeLeaf(treeRef.current, targetId);
      if (next == null) return false; // last leaf — host decides what an empty layout means
      treeRef.current = next; // advance the ref ahead of the async state commit
      setTree(next);
      return true;
    },
    [],
  );

  const move = useCallback((sourceId: string, targetId: string, edge: DropEdge, ratio?: number) => {
    setTree((t) => moveLeaf(t, sourceId, targetId, edge, ratio));
  }, []);

  const dropOnLeaf = useCallback(
    (sourceId: string, targetId: string, rect: Rect, px: number, py: number): 'moved' | 'center' | 'noop' => {
      if (sourceId === targetId) return 'noop';
      const zone = dropZone(rect, px, py);
      if (zone === 'center') return 'center';
      setTree((t) => moveLeaf(t, sourceId, targetId, zone));
      return 'moved';
    },
    [],
  );

  const equalize = useCallback((path: number[]) => {
    setTree((t) => equalizeAt(t, path));
  }, []);

  const equalizeAll = useCallback(() => {
    setTree((t) => equalizeAllOp(t));
  }, []);

  return { tree, setTree, onResize, split, close, move, dropOnLeaf, equalize, equalizeAll };
}
