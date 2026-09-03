/**
 * Shared preview/transient tab logic.
 *
 * A "preview" tab is transient — it gets replaced when another tab opens
 * in the same container. A "pinned" tab is permanent.
 *
 * Tabs become pinned by: double-clicking, editing content, or sending a message.
 */

/**
 * One-shot "this tab was just restored (reopened)" markers.
 *
 * Reopening a closed tab (⇧⌘T / ⌘⇧U / ⌘K "recently closed") is ADDITIVE — it
 * restores a tab alongside the existing ones. It must NOT be mistaken for a
 * preview-navigation (a single tab added → replace the current transient
 * "preview" tab), otherwise reopening a tab would close whatever preview tab is
 * currently open and the user would just see a swap instead of a restore.
 *
 * The reopen path calls `markTabRestored(id)` immediately before the tab lands
 * in the open list; the ordering effect (usePaneOrdering) calls
 * `consumeTabRestored(id)` once and, when true, skips the preview replacement.
 * Module-level Set (not React state) so the marker is readable synchronously in
 * the very next render's effect, and one-shot so it can never leak into a later,
 * genuine navigation.
 */
const restoredTabIds = new Set<string>();

export function markTabRestored(id: string): void {
  restoredTabIds.add(id);
}

/** Returns true (and clears the marker) iff `id` was just restored. */
export function consumeTabRestored(id: string): boolean {
  return restoredTabIds.delete(id);
}

/**
 * Where a restored tab goes back: the slot it was closed from, clamped to the
 * list as it is NOW.
 *
 * A reopen is not a new tab, and appending it is what the user reports as "it
 * comes back at the end". The undo path already re-inserts at the recorded
 * `groupIndex` (state/pane/reducers/undo.ts); the ⇧⌘T path went through
 * `OPEN_PANE` + a `setOpenPanels` append, so the tab settled last and that
 * wrong order was then persisted, surviving the reload.
 *
 * The bar it returns to may have shrunk while the tab was closed, so the
 * recorded index can point past the end: `length` then means "last", which is
 * the only slot left that the record can still be read as. A record with no
 * usable index (a legacy/hand-built one) is appended, same rule.
 */
export function restoreSlot(recordedIndex: number | undefined, listLength: number): number {
  if (typeof recordedIndex !== 'number' || !Number.isFinite(recordedIndex)) return listLength;
  return Math.min(Math.max(0, Math.trunc(recordedIndex)), listLength);
}

/**
 * Insert `id` at its restore slot. A list that already holds the id comes back
 * BY REFERENCE, not copied: this feeds a `setOpenPanels` updater, where a fresh
 * array with identical contents is still a state change and would re-run the
 * React -> store sync for nothing.
 */
export function insertAtRestoreSlot(
  orderedIds: string[],
  id: string,
  recordedIndex: number | undefined,
): string[] {
  if (orderedIds.includes(id)) return orderedIds;
  const result = [...orderedIds];
  result.splice(restoreSlot(recordedIndex, result.length), 0, id);
  return result;
}

/**
 * Find the first preview (unpinned) ID in an ordered list.
 */
export function findPreviewInList(
  orderedIds: string[],
  pinnedIds: Set<string>,
  excludeId?: string
): string | null {
  return orderedIds.find(id => id !== excludeId && !pinnedIds.has(id)) || null;
}

/**
 * Find the first preview pane in a pane array.
 */
export function findPreviewPane<T extends { id: string; preview?: boolean }>(
  panes: T[],
  excludeId?: string
): T | null {
  return panes.find(p => p.id !== excludeId && p.preview) || null;
}

/**
 * Replace a target ID in an ordered list with a new ID.
 * Returns the new list. If target not found, appends newId.
 */
export function replaceInList(
  orderedIds: string[],
  targetId: string,
  newId: string
): string[] {
  const idx = orderedIds.indexOf(targetId);
  if (idx < 0) return [...orderedIds, newId];
  const result = [...orderedIds];
  result[idx] = newId;
  return result;
}

/**
 * Replace a preview pane in a pane ID list (e.g. group.paneIds).
 * If previewPaneId is found, swaps it with newPaneId.
 * Otherwise appends newPaneId.
 */
export function replacePaneInGroup(
  paneIds: string[],
  previewPaneId: string,
  newPaneId: string
): string[] {
  const idx = paneIds.indexOf(previewPaneId);
  if (idx < 0) return [...paneIds, newPaneId];
  return paneIds.map(id => id === previewPaneId ? newPaneId : id);
}
