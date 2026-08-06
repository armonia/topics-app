/**
 * Shared DnD MIME type constants for native HTML5 drag-and-drop.
 * Prevents typos and makes the DnD system self-documenting.
 */
export const DND_TYPES = {
  /** Panel/topic ID — cross-window panel drag, sidebar-to-grid drops */
  PANEL_ID: 'application/x-panel-id',
  /** Sidebar topic reordering */
  SIDEBAR_REORDER: 'application/x-sidebar-reorder',
  /** Pane tab reordering within a group */
  PANE_TAB: 'application/x-pane-tab',
  /** Source group ID for cross-group tab drags */
  PANE_TAB_GROUP: 'application/x-pane-tab-group',
  /** Unified grid item reordering (utility, project, standalone) */
  GRID_ITEM: 'application/x-grid-item',
  /** Row reordering within GroupLayout */
  LAYOUT_ROW: 'application/x-layout-row',
  /** Row reordering within PanelGrid */
  GRID_ROW: 'application/x-grid-row',
  /** Source scope (window/project) of a tab drag — value carrier, read on drop */
  PANE_TAB_SCOPE: 'application/x-pane-tab-scope',
  /** Riordino di una tessera dentro la griglia dei Fissati.
   *
   *  Una tessera porta QUESTO tipo *e* `PANEL_ID` sullo stesso dataTransfer: la
   *  griglia dei fissati legge il primo per riordinare, la griglia dei pane legge
   *  il secondo per aprire. Chi riceve prende il tipo che capisce, e il drag
   *  «trascina un fissato dentro la griglia» continua a funzionare come prima. */
  PINNED_TILE: 'application/x-pinned-tile',
  /** L'id della PANE di una tessera fissata, che per un progetto NON coincide
   *  con la sua chiave di riga: la riga è chiavata sul path grezzo
   *  (`project:/Users/…`), la pane su quello codificato (`project:%2FUsers…`).
   *
   *  Serve perché i due consumatori vogliono cose diverse dallo stesso drag: la
   *  griglia dei pane vuole l'id APRIBILE (`PANEL_ID`), la card di un gruppo
   *  vuole l'id della pane da spostare. Senza questo, trascinare un progetto
   *  fissato dentro un gruppo non faceva niente — nessun errore, solo un drop
   *  che cadeva su una pane inesistente. */
  PINNED_PANE_ID: 'application/x-pinned-pane-id',
} as const;

/** The DnD scope of the top-level standalone window (its chat group + solo split
 *  cells). Every project window uses its projectPath as scope instead. The
 *  standalone grid must only react to tab drags of THIS scope — a project's
 *  internal tab drag is owned entirely by that project. Shared so producers and
 *  consumers can't drift on the literal. */
export const STANDALONE_SCOPE = 'main';

/**
 * Per-window/project DnD scope for tab drags. Tabs may only be reordered or
 * moved *within the same scope*: the top-level window is one scope ("main",
 * covering the standalone group and any solo split cells) and every project is
 * its own scope (its projectPath). A drag from one scope must not show drop
 * indicators on — or land in — a tab bar of another scope.
 *
 * The scope is encoded into a dataTransfer TYPE name (not a value) because the
 * HTML5 DnD spec blocks `getData()` during `dragover`/`dragenter` — only
 * `types` is readable then. A hash keeps the marker a safe, opaque ASCII token
 * regardless of what characters a projectPath contains.
 */
export function paneTabScopeType(scope: string): string {
  // djb2-xor → base36. Types are compared case-insensitively by the browser;
  // base36 of an unsigned int is already lowercase, so comparisons are stable.
  let h = 5381;
  for (let i = 0; i < scope.length; i++) h = (((h << 5) + h) ^ scope.charCodeAt(i)) >>> 0;
  return `application/x-pane-scope-${h.toString(36)}`;
}

/**
 * True when a dragover's `types` carry our scope marker — i.e. the drag
 * originated in the same window/project. Returns true when `scope` is undefined
 * so legacy callers that don't pass a scope keep the old unrestricted behavior.
 */
export function dragMatchesScope(types: readonly string[], scope: string | undefined): boolean {
  if (!scope) return true;
  return types.includes(paneTabScopeType(scope));
}

/**
 * Marks a tab drag whose SOURCE group holds a single pane (a "solo" group),
 * encoded per-group as a dataTransfer TYPE — same hashed-type trick as
 * `paneTabScopeType`, because `getData()` is blocked during dragover. A drop
 * target whose group id matches can then SUPPRESS the self-split preview the
 * drop handler would refuse anyway (splitting a solo group into itself is a
 * no-op): without this, the user saw a full edge-split preview on their own
 * solo pane, released, and nothing happened.
 */
export function paneTabSoloSrcType(groupId: string): string {
  let h = 5381;
  for (let i = 0; i < groupId.length; i++) h = (((h << 5) + h) ^ groupId.charCodeAt(i)) >>> 0;
  return `application/x-pane-solo-src-${h.toString(36)}`;
}
