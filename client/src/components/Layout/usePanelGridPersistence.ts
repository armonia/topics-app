import { useEffect, useRef, useState } from 'react';
import type { PanelGridRow, PanelGridCellStack } from '../../types';

/**
 * Sanitize one row read from localStorage. Returns `null` when the input is
 * not plausibly a row. The row's optional `cellStacks` map is normalized:
 * stacks whose primary key isn't in `itemKeys` are dropped (orphan), height
 * arrays are coerced to match item count and renormalized to sum=1.
 *
 * Exported for tests so we can pin the contract precisely.
 */
export function sanitizeRow(raw: unknown): PanelGridRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<PanelGridRow>;
  if (!Array.isArray(r.itemKeys) || !Array.isArray(r.widths)) return null;
  const itemKeys = r.itemKeys.filter((k): k is string => typeof k === 'string');
  if (itemKeys.length === 0) return null;

  const widths = itemKeys.map((_, i) => {
    const w = r.widths![i];
    return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : 1 / itemKeys.length;
  });
  const wsum = widths.reduce((s, w) => s + w, 0) || 1;
  const normWidths = widths.map(w => w / wsum);

  const out: PanelGridRow = { itemKeys, widths: normWidths };

  // cellStacks is optional; absent for the simple case.
  if (r.cellStacks && typeof r.cellStacks === 'object' && !Array.isArray(r.cellStacks)) {
    const itemKeySet = new Set(itemKeys);
    const sanitized: Record<string, PanelGridCellStack> = {};
    for (const [primary, stackRaw] of Object.entries(r.cellStacks)) {
      // Drop orphan stacks (primary no longer in itemKeys) — they would
      // never render and would silently bloat localStorage.
      if (!itemKeySet.has(primary)) continue;
      if (!stackRaw || typeof stackRaw !== 'object') continue;
      const s = stackRaw as Partial<PanelGridCellStack>;
      if (!Array.isArray(s.items)) continue;
      const items = s.items.filter((k): k is string => typeof k === 'string');
      if (items.length === 0) continue;
      const rawHeights = Array.isArray(s.heights) ? s.heights : [];
      // Heights array tracks `[primary, ...items]` — length items.length + 1.
      // We require it; missing/short arrays are filled with 1s.
      const heightsLen = items.length + 1;
      const heights = Array.from({ length: heightsLen }, (_, i) => {
        const h = rawHeights[i];
        return typeof h === 'number' && Number.isFinite(h) && h > 0 ? h : 1;
      });
      const hsum = heights.reduce((sum, h) => sum + h, 0) || 1;
      sanitized[primary] = { items, heights: heights.map(h => h / hsum) };
    }
    if (Object.keys(sanitized).length > 0) {
      out.cellStacks = sanitized;
    }
  }

  return out;
}

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
      gridRows: Array.isArray(parsed.gridRows)
        ? (parsed.gridRows
            .map((r: unknown) => sanitizeRow(r))
            .filter((r: PanelGridRow | null): r is PanelGridRow => r !== null))
        : undefined,
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
