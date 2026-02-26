/**
 * Shared preview/transient tab logic.
 *
 * A "preview" tab is transient — it gets replaced when another tab opens
 * in the same container. A "pinned" tab is permanent.
 *
 * Tabs become pinned by: double-clicking, editing content, or sending a message.
 */

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
