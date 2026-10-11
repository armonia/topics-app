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

/**
 * Stessa regola per `open-file-diff`, che il suo scoping non ce l'aveva: con due
 * finestre di progetto affiancate, un click su un file nel pannello Git di B
 * faceva comparire la tab diff ANCHE in A. Non è un bug nuovo (GitChanges
 * dispatcha quell'evento da sempre), ma il permalink lo rende raggiungibile da
 * fuori: un `/tab/diff/<progetto>/<file>` incollato in chat apriva il diff
 * ovunque.
 *
 * L'evento porta un `projectPath` invece del `topicId` di `open-file`, quindi il
 * bersaglio si costruisce da lì. La regola resta una sola — cambia solo da dove
 * si legge il progetto di destinazione.
 *
 * Un `projectPath` mancante ricade sulla finestra a fuoco, come `open-file`: è
 * la stessa scelta, non una nuova.
 *
 * @param detail          `{ projectPath }` dell'evento
 * @param wrapperPaneId   il pane id di QUESTA finestra di progetto
 * @param focusedPanelId  il pannello a fuoco (bersaglio di ripiego)
 * @param toPaneId        `createPaneId('project', …)`, iniettata per tenere
 *                        questo modulo puro e indipendente da come si compone
 *                        un pane id
 */
export function shouldHandleOpenDiff(
  detail: { projectPath?: string | null },
  wrapperPaneId: string,
  focusedPanelId: string | null,
  toPaneId: (projectPath: string) => string,
): boolean {
  const target = detail.projectPath ? toPaneId(detail.projectPath) : focusedPanelId;
  return target === wrapperPaneId;
}
