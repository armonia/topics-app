import { useRef, useEffect, useCallback } from 'react';
import { equalizeWidths } from '../components/Layout/gridWidths';
import { MIN_PANE_FRACTION } from '../components/Layout/constants';

interface ResizeCallbacks {
  onHorizontalResize: (rowIdx: number, divIdx: number, newWidths: number[]) => void;
  onVerticalResize: (divIdx: number, newHeights: number[]) => void;
}

/** Given a divider element, return how to apply size changes directly to the DOM. */
interface DOMResolveFn {
  (divider: HTMLElement): {
    apply: (aFraction: number, bFraction: number) => void;
    cleanup?: () => void;
  } | null;
}

interface ResizeOptions {
  resolveHorizontal?: DOMResolveFn;
  resolveVertical?: DOMResolveFn;
}

export function useGridResize(
  containerRef: React.RefObject<HTMLElement | null>,
  callbacks: ResizeCallbacks,
  options?: ResizeOptions,
) {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const hResizing = useRef<{
    rowIdx: number;
    divIdx: number;
    startX: number;
    startWidths: number[];
    containerW: number;
    applyDOM: ((l: number, r: number) => void) | null;
    cleanupDOM: (() => void) | null;
  } | null>(null);

  const vResizing = useRef<{
    divIdx: number;
    startY: number;
    startHeights: number[];
    containerH: number;
    applyDOM: ((t: number, b: number) => void) | null;
    cleanupDOM: (() => void) | null;
  } | null>(null);

  const startHorizontalResize = useCallback(
    (rowIdx: number, divIdx: number, currentWidths: number[]) => (e: React.MouseEvent) => {
      e.preventDefault();
      const resolved = optionsRef.current?.resolveHorizontal?.(e.currentTarget as HTMLElement);
      hResizing.current = {
        rowIdx,
        divIdx,
        startX: e.clientX,
        startWidths: [...currentWidths],
        // Cache the container width once at drag start — it can't change mid-drag,
        // so re-reading offsetWidth on every mousemove was a needless layout read.
        containerW: containerRef.current?.offsetWidth || 1,
        applyDOM: resolved?.apply ?? null,
        cleanupDOM: resolved?.cleanup ?? null,
      };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [],
  );

  const startVerticalResize = useCallback(
    (divIdx: number, currentHeights: number[]) => (e: React.MouseEvent) => {
      e.preventDefault();
      const resolved = optionsRef.current?.resolveVertical?.(e.currentTarget as HTMLElement);
      vResizing.current = {
        divIdx,
        startY: e.clientY,
        startHeights: [...currentHeights],
        containerH: containerRef.current?.offsetHeight || 1,
        applyDOM: resolved?.apply ?? null,
        cleanupDOM: resolved?.cleanup ?? null,
      };
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
    },
    [],
  );

  // Double-click a divider → reset the whole row/column band to equal sizes
  // (1/n each). Mirrors VS Code "Even Editor Widths" / Allotment's
  // reset-on-double-click. We equalise the ENTIRE row (not just the two panes
  // around the clicked divider) because that's what "make the split even" means
  // to a user. Routed through the same resize callbacks so persistence and
  // re-render behave identically to a drag.
  const equalizeHorizontal = useCallback(
    (rowIdx: number, count: number) => () => {
      if (count <= 1) return;
      callbacksRef.current.onHorizontalResize(rowIdx, 0, equalizeWidths(count));
    },
    [],
  );

  const equalizeVertical = useCallback(
    (count: number) => () => {
      if (count <= 1) return;
      callbacksRef.current.onVerticalResize(0, equalizeWidths(count));
    },
    [],
  );

  useEffect(() => {
    const MIN = MIN_PANE_FRACTION;
    let rafId = 0;

    const onMove = (e: MouseEvent) => {
      if (hResizing.current) {
        const h = hResizing.current;
        const delta = (e.clientX - h.startX) / h.containerW;
        const a = h.startWidths[h.divIdx];
        const b = h.startWidths[h.divIdx + 1];
        const sum = a + b;
        // Clamp the divider into [MIN, sum-MIN] so it sticks to the edge instead
        // of freezing in a dead-zone past the limit. The old `if (l>=MIN && r>=MIN)`
        // gate simply skipped out-of-range moves, which froze the divider at the
        // last valid spot and added hysteresis on overshoot-then-return.
        if (sum > 2 * MIN) {
          const l = Math.min(Math.max(a + delta, MIN), sum - MIN);
          const r = sum - l;
          if (h.applyDOM) {
            // DOM-direct: zero React re-renders
            h.applyDOM(l, r);
          } else {
            // Fallback: rAF-throttled React update
            cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(() => {
              const newW = [...h.startWidths];
              newW[h.divIdx] = l;
              newW[h.divIdx + 1] = r;
              callbacksRef.current.onHorizontalResize(h.rowIdx, h.divIdx, newW);
            });
          }
        }
      }

      if (vResizing.current) {
        const v = vResizing.current;
        const delta = (e.clientY - v.startY) / v.containerH;
        const a = v.startHeights[v.divIdx];
        const b = v.startHeights[v.divIdx + 1];
        const sum = a + b;
        if (sum > 2 * MIN) {
          const t = Math.min(Math.max(a + delta, MIN), sum - MIN);
          const bottom = sum - t;
          if (v.applyDOM) {
            v.applyDOM(t, bottom);
          } else {
            cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(() => {
              const newH = [...v.startHeights];
              newH[v.divIdx] = t;
              newH[v.divIdx + 1] = bottom;
              callbacksRef.current.onVerticalResize(v.divIdx, newH);
            });
          }
        }
      }
    };

    const onUp = (e: MouseEvent) => {
      cancelAnimationFrame(rafId);

      // Restore transitions + sync final values to React state (single re-render)
      if (hResizing.current) {
        const { rowIdx, divIdx, startX, startWidths, containerW, cleanupDOM } = hResizing.current;
        cleanupDOM?.();
        const delta = (e.clientX - startX) / containerW;
        const newW = [...startWidths];
        const a = startWidths[divIdx];
        const b = startWidths[divIdx + 1];
        const sum = a + b;
        if (sum > 2 * MIN) {
          const l = Math.min(Math.max(a + delta, MIN), sum - MIN);
          newW[divIdx] = l;
          newW[divIdx + 1] = sum - l;
        }
        // A bare click (no movement) leaves widths unchanged — don't emit a
        // no-op resize that re-renders and re-persists. This also keeps a
        // double-click (two clicks → equalize) from firing two phantom writes
        // before the equalize lands.
        if (e.clientX !== startX) {
          callbacksRef.current.onHorizontalResize(rowIdx, divIdx, newW);
        }
        hResizing.current = null;
      }

      if (vResizing.current) {
        const { divIdx, startY, startHeights, containerH, cleanupDOM } = vResizing.current;
        cleanupDOM?.();
        const delta = (e.clientY - startY) / containerH;
        const newH = [...startHeights];
        const a = startHeights[divIdx];
        const b = startHeights[divIdx + 1];
        const sum = a + b;
        if (sum > 2 * MIN) {
          const t = Math.min(Math.max(a + delta, MIN), sum - MIN);
          newH[divIdx] = t;
          newH[divIdx + 1] = sum - t;
        }
        if (e.clientY !== startY) {
          callbacksRef.current.onVerticalResize(divIdx, newH);
        }
        vResizing.current = null;
      }

      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [containerRef]);

  return { startHorizontalResize, startVerticalResize, equalizeHorizontal, equalizeVertical };
}
