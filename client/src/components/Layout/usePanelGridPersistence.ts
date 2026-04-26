import { useEffect, useRef, useState } from 'react';
import type { PanelGridRow } from '../../types';

/**
 * Isolates the per-device localStorage side of <PanelGrid/> (review I2).
 *
 * PanelGrid owns a non-legacy, device-local row/column overlay that survives
 * reload but does NOT cross devices — that's the pane-store's job via
 * syncServer middleware. This hook owns the three fields stored under
 * `topics-panel-grid-layout` so the component file stays focused on layout
 * math and DnD, not JSON serialization.
 *
 * Initial state is read once per mount via each useState initializer; the
 * single persist `useEffect` writes all three keys together so they stay
 * consistent in storage.
 */

const STORAGE_KEY = 'topics-panel-grid-layout';

interface PanelGridPersistedData {
  gridRows?: PanelGridRow[];
  gridRowHeights?: number[];
  soloTopicIds?: string[];
}

function readPersisted(): PanelGridPersistedData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return {
      gridRows: Array.isArray(parsed.gridRows) ? (parsed.gridRows as PanelGridRow[]) : undefined,
      gridRowHeights: Array.isArray(parsed.gridRowHeights)
        ? (parsed.gridRowHeights as number[])
        : undefined,
      soloTopicIds: Array.isArray(parsed.soloTopicIds)
        ? (parsed.soloTopicIds as string[])
        : undefined,
    };
  } catch {
    return {};
  }
}

export interface PanelGridPersistence {
  gridRows: PanelGridRow[];
  setGridRows: React.Dispatch<React.SetStateAction<PanelGridRow[]>>;
  gridRowHeights: number[];
  setGridRowHeights: React.Dispatch<React.SetStateAction<number[]>>;
  soloTopicIdsRaw: string[];
  setSoloTopicIds: React.Dispatch<React.SetStateAction<string[]>>;
}

/**
 * Optional hook arguments. `persistEnabled` gates the localStorage write so
 * we don't overwrite a saved layout with the transient empty state during
 * the boot window (before the pane store has hydrated from server). Reads
 * are unaffected — the initial useState values still come from localStorage,
 * so the saved layout shows immediately on mount.
 */
export interface UsePanelGridPersistenceOptions {
  persistEnabled?: boolean;
}

export function usePanelGridPersistence(
  options: UsePanelGridPersistenceOptions = {},
): PanelGridPersistence {
  const { persistEnabled = true } = options;

  // Read localStorage once per mount instead of three times (one per useState
  // initializer). JSON.parse on a non-trivial payload isn't free, and the
  // three reads are always consistent anyway — they write together.
  const initial = useRef<PanelGridPersistedData>(readPersisted()).current;
  const [gridRows, setGridRows] = useState<PanelGridRow[]>(
    () => initial.gridRows ?? [],
  );
  const [gridRowHeights, setGridRowHeights] = useState<number[]>(
    () => initial.gridRowHeights ?? [],
  );
  const [soloTopicIdsRaw, setSoloTopicIds] = useState<string[]>(
    () => initial.soloTopicIds ?? [],
  );

  useEffect(() => {
    if (!persistEnabled) return;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          gridRows,
          gridRowHeights,
          soloTopicIds: soloTopicIdsRaw,
        }),
      );
    } catch {
      /* quota exceeded / private mode — silent */
    }
  }, [gridRows, gridRowHeights, soloTopicIdsRaw, persistEnabled]);

  return {
    gridRows,
    setGridRows,
    gridRowHeights,
    setGridRowHeights,
    soloTopicIdsRaw,
    setSoloTopicIds,
  };
}

export const PANEL_GRID_STORAGE_KEY = STORAGE_KEY;
