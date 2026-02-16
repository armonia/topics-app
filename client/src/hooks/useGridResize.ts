import { useRef, useEffect, useCallback } from 'react';

interface ResizeCallbacks {
  onHorizontalResize: (rowIdx: number, divIdx: number, newWidths: number[]) => void;
  onVerticalResize: (divIdx: number, newHeights: number[]) => void;
}

export function useGridResize(containerRef: React.RefObject<HTMLElement | null>, callbacks: ResizeCallbacks) {
  const hResizing = useRef<{
    rowIdx: number;
    divIdx: number;
    startX: number;
    startWidths: number[];
  } | null>(null);

  const vResizing = useRef<{
    divIdx: number;
    startY: number;
    startHeights: number[];
  } | null>(null);

  const startHorizontalResize = useCallback(
    (rowIdx: number, divIdx: number, currentWidths: number[]) => (e: React.MouseEvent) => {
      e.preventDefault();
      hResizing.current = {
        rowIdx,
        divIdx,
        startX: e.clientX,
        startWidths: [...currentWidths],
      };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [],
  );

  const startVerticalResize = useCallback(
    (divIdx: number, currentHeights: number[]) => (e: React.MouseEvent) => {
      e.preventDefault();
      vResizing.current = {
        divIdx,
        startY: e.clientY,
        startHeights: [...currentHeights],
      };
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
    },
    [],
  );

  useEffect(() => {
    const MIN = 0.1;

    const onMove = (e: MouseEvent) => {
      if (hResizing.current) {
        const { rowIdx, divIdx, startX, startWidths } = hResizing.current;
        const cw = containerRef.current?.offsetWidth || 1;
        const delta = (e.clientX - startX) / cw;
        const newW = [...startWidths];
        const l = newW[divIdx] + delta;
        const r = newW[divIdx + 1] - delta;
        if (l >= MIN && r >= MIN) {
          newW[divIdx] = l;
          newW[divIdx + 1] = r;
          callbacks.onHorizontalResize(rowIdx, divIdx, newW);
        }
      }

      if (vResizing.current) {
        const { divIdx, startY, startHeights } = vResizing.current;
        const ch = containerRef.current?.offsetHeight || 1;
        const delta = (e.clientY - startY) / ch;
        const newH = [...startHeights];
        const t = newH[divIdx] + delta;
        const b = newH[divIdx + 1] - delta;
        if (t >= MIN && b >= MIN) {
          newH[divIdx] = t;
          newH[divIdx + 1] = b;
          callbacks.onVerticalResize(divIdx, newH);
        }
      }
    };

    const onUp = () => {
      hResizing.current = null;
      vResizing.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [containerRef, callbacks]);

  return { startHorizontalResize, startVerticalResize };
}
