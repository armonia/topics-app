/**
 * Scoping for the global `open-file` window event.
 *
 * `open-file` is dispatched on `window`, and EVERY mounted project window's
 * `useProjectLayout` subscribes to it. Without scoping, a single dispatch opens
 * the file in every project window currently in split view — the "file opens on
 * all splits" bug.
 *
 * The dispatcher tags the event with the intended target project window's pane
 * id (`topicId` = `createPaneId('project', projectPath)`): the command palette
 * and the file-search modal target the project being searched; a file pane's
 * breadcrumb targets its own owning project. Dispatches that omit a target fall
 * back to whichever project window currently holds focus. A project window
 * handles the event iff it is that target.
 *
 * Pure so the routing rule is unit-tested independently of React/DOM.
 */
export interface OpenFileScopeDetail {
  topicId?: string | null;
}

/**
 * @param detail          the event's `detail` (its optional `topicId` target)
 * @param wrapperPaneId   this project window's pane id (`createPaneId('project', projectPath)`)
 * @param focusedPanelId  the currently-focused top-level panel id (fallback target)
 * @returns true iff THIS project window should open the file
 */
export function shouldHandleOpenFile(
  detail: OpenFileScopeDetail,
  wrapperPaneId: string,
  focusedPanelId: string | null,
): boolean {
  const target = detail.topicId ?? focusedPanelId;
  return target === wrapperPaneId;
}
