import { useLayoutEffect, useState } from 'react';
import type { PanelGridRow, PanelGridCellStack } from '../../types';
import { DEFAULT_SPACE_ID } from '../../state/pane/types';
import { soloCellsFromFlat, flattenSoloCells } from './soloCells';

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
  // Dedupe while filtering (first occurrence wins, keeping ITS width):
  // duplicate itemKeys in persisted data survive the pruning sync pass
  // untouched and render duplicate React keys.
  const seenKeys = new Set<string>();
  const keptIdx: number[] = [];
  r.itemKeys.forEach((k, i) => {
    if (typeof k !== 'string' || seenKeys.has(k)) return;
    seenKeys.add(k);
    keptIdx.push(i);
  });
  const itemKeys = keptIdx.map(i => r.itemKeys![i] as string);
  if (itemKeys.length === 0) return null;

  const widths = keptIdx.map(i => {
    const w = r.widths![i];
    return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : 1 / itemKeys.length;
  });
  const wsum = widths.reduce((s, w) => s + w, 0) || 1;
  const normWidths = widths.map(w => w / wsum);

  const out: PanelGridRow = { itemKeys, widths: normWidths };

  // cellStacks is optional; absent for the simple case.
  if (r.cellStacks && typeof r.cellStacks === 'object' && !Array.isArray(r.cellStacks)) {
    const itemKeySet = new Set(itemKeys);
    // Stack items must be unique ACROSS stacks and must not shadow a
    // top-level itemKey (other than their own primary) — either overlap
    // renders the same pane twice.
    const usedStackItems = new Set<string>();
    const sanitized: Record<string, PanelGridCellStack> = {};
    for (const [primary, stackRaw] of Object.entries(r.cellStacks)) {
      // Drop orphan stacks (primary no longer in itemKeys) — they would
      // never render and would silently bloat localStorage.
      if (!itemKeySet.has(primary)) continue;
      if (!stackRaw || typeof stackRaw !== 'object') continue;
      const s = stackRaw as Partial<PanelGridCellStack>;
      if (!Array.isArray(s.items)) continue;
      const items: string[] = [];
      for (const k of s.items) {
        if (typeof k !== 'string' || itemKeySet.has(k) || usedStackItems.has(k)) continue;
        usedStackItems.add(k);
        items.push(k);
      }
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
 * `topics-panel-grid-layout:<spaceId>` so the component file stays focused on
 * layout math and DnD, not JSON serialization.
 *
 * Spazi: the layout is PER-SPACE — PanelGrid prunes soloCells/gridRows against
 * its (visible) openPanels prop, so a shared key would be destroyed on every
 * space switch by the pruning pass of whichever space is mounted. Each space
 * writes its own suffixed key and PanelGrid remounts via key={activeSpaceId},
 * so the initializers re-read on switch. The DEFAULT space falls back to the
 * legacy unsuffixed key on first read (zero-loss migration) and keeps
 * MIRRORING it on write so a rollback to pre-Spazi code still finds the
 * layout (same precedent as the flat `soloTopicIds` mirror below).
 *
 * Initial state is read once per mount via each useState initializer; the
 * single persist `useEffect` writes all three fields together so they stay
 * consistent in storage.
 */

const STORAGE_KEY_BASE = 'topics-panel-grid-layout';

/** Per-space storage key. The legacy unsuffixed key remains the default
 *  space's read-fallback + write-mirror. */
export function panelGridStorageKey(spaceId: string): string {
  return `${STORAGE_KEY_BASE}:${spaceId}`;
}

interface PanelGridPersistedData {
  gridRows?: PanelGridRow[];
  gridRowHeights?: number[];
  /** Multi-tab split cells (each inner array = one cell, primary first). */
  soloCells?: string[][];
}

/** Validate a `soloCells` payload: array of non-empty string arrays. A topic
 *  id may appear in ONE cell only (first occurrence wins) — duplicates across
 *  or within cells would render the same pane twice. */
function sanitizeSoloCells(raw: unknown): string[][] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[][] = [];
  const seen = new Set<string>();
  for (const cell of raw) {
    if (!Array.isArray(cell)) continue;
    const ids: string[] = [];
    for (const id of cell) {
      if (typeof id !== 'string' || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    if (ids.length > 0) out.push(ids);
  }
  return out;
}

/** Validate persisted `gridRowHeights`: every entry must be a positive finite
 *  number (corrupt entries get an equal share), renormalized to sum=1. The
 *  raw cast let NaN/0/negatives/strings straight into `flex:` styles, where
 *  the `?? fallback` at render only guards holes, not garbage. */
function sanitizeRowHeights(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  if (raw.length === 0) return [];
  const fallback = 1 / raw.length;
  const heights = raw.map(h =>
    typeof h === 'number' && Number.isFinite(h) && h > 0 ? h : fallback,
  );
  const sum = heights.reduce((s, h) => s + h, 0) || 1;
  return heights.map(h => h / sum);
}

function readPersisted(spaceId: string): PanelGridPersistedData {
  try {
    // Per-space key first; the DEFAULT space additionally falls back to the
    // legacy unsuffixed key (pre-Spazi layouts migrate losslessly on first
    // load — the next write lands on the suffixed key).
    const raw =
      localStorage.getItem(panelGridStorageKey(spaceId)) ??
      (spaceId === DEFAULT_SPACE_ID ? localStorage.getItem(STORAGE_KEY_BASE) : null);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    // Prefer the new `soloCells`; migrate a legacy flat `soloTopicIds` (each
    // topic → its own single-tab cell, which renders identically — no re-keying).
    const soloCells =
      sanitizeSoloCells(parsed.soloCells) ??
      (Array.isArray(parsed.soloTopicIds)
        ? soloCellsFromFlat((parsed.soloTopicIds as unknown[]).filter((x): x is string => typeof x === 'string'))
        : undefined);
    return {
      gridRows: Array.isArray(parsed.gridRows)
        ? (parsed.gridRows
            .map((r: unknown) => sanitizeRow(r))
            .filter((r: PanelGridRow | null): r is PanelGridRow => r !== null))
        : undefined,
      gridRowHeights: sanitizeRowHeights(parsed.gridRowHeights),
      soloCells,
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
  soloCellsRaw: string[][];
  setSoloCells: React.Dispatch<React.SetStateAction<string[][]>>;
}

export function usePanelGridPersistence(spaceId: string): PanelGridPersistence {
  // Read localStorage once per mount instead of three times (one per useState
  // initializer). JSON.parse on a non-trivial payload isn't free, and the
  // three reads are always consistent anyway — they write together. Holding it
  // in lazy `useState` (not a ref) keeps the read out of render on re-renders
  // while staying readable inside the sibling state initializers.
  // `spaceId` is mount-stable by contract: PanelGrid remounts via
  // key={activeSpaceId}, so the lazy initializers re-read on a space switch.
  const [initial] = useState<PanelGridPersistedData>(() => readPersisted(spaceId));
  const [gridRows, setGridRows] = useState<PanelGridRow[]>(
    () => initial.gridRows ?? [],
  );
  const [gridRowHeights, setGridRowHeights] = useState<number[]>(
    () => initial.gridRowHeights ?? [],
  );
  const [soloCellsRaw, setSoloCells] = useState<string[][]>(
    () => initial.soloCells ?? [],
  );

  // Persist on every state change. We use `useLayoutEffect` rather than
  // `useEffect` so the localStorage write flushes synchronously after the
  // commit, BEFORE the browser repaints — narrowing the race window where
  // an external reload (e.g. Electron's prod asset auto-reload) could fire
  // between commit and write and leave localStorage stale.
  //
  // We deliberately do NOT gate this on `serverHydrated`. The original gate
  // (PR #6) was added because the `naturalGridItems` sync effect in
  // `PanelGrid.tsx` could prune the saved layout during the boot window
  // when `openPanels` was still empty. That root cause is fixed by gating
  // *the sync effect itself* on `useServerHydrated()`. Gating the persist
  // write too was redundantly defensive AND actively harmful: if the user
  // split a pane before hydrate (or Electron auto-reloaded mid-boot), the
  // split write was silently dropped — the symptom users reported as
  // "split layout doesn't survive reload".
  useLayoutEffect(() => {
    try {
      const payload = JSON.stringify({
        gridRows,
        gridRowHeights,
        soloCells: soloCellsRaw,
        // Keep a flat mirror so a rollback to pre-multi-tab code still finds
        // the user's split topics (it ignores `soloCells`).
        soloTopicIds: flattenSoloCells(soloCellsRaw),
      });
      localStorage.setItem(panelGridStorageKey(spaceId), payload);
      // Rollback mirror: pre-Spazi builds read only the unsuffixed key. The
      // default space keeps it in lockstep (same rationale as soloTopicIds).
      if (spaceId === DEFAULT_SPACE_ID) localStorage.setItem(STORAGE_KEY_BASE, payload);
    } catch {
      /* quota exceeded / private mode — silent */
    }
  }, [gridRows, gridRowHeights, soloCellsRaw, spaceId]);

  return {
    gridRows,
    setGridRows,
    gridRowHeights,
    setGridRowHeights,
    soloCellsRaw,
    setSoloCells,
  };
}
