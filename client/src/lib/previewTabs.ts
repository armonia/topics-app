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
