/**
 * Shared DnD MIME type constants for native HTML5 drag-and-drop.
 * Prevents typos and makes the DnD system self-documenting.
 */
export const DND_TYPES = {
  /** L'id della PANE — drag di un pannello fra finestre, e drop dalla sidebar.
   *
   *  È l'id APRIBILE, non la chiave della riga: per un progetto la riga della
   *  sidebar è chiavata sul path grezzo (`project:/Users/…`) mentre la pane usa
   *  quello codificato (`project:%2FUsers…`), e chi riceve questo tipo apre o
   *  sposta una PANE. Chi trascina una riga di progetto deve quindi convertire
   *  con `sidebarItemPaneId`, non passare l'id della riga. */
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
 * Questo drag è NOSTRO — cioè lo ha iniziato un elemento di questa app.
 *
 * Serve alla rete di sicurezza in `main.tsx`, che impedisce al browser di
 * navigare via quando ci si lascia cadere sopra un file o un link. Quella rete
 * era stesa su TUTTO: un `preventDefault` sul `dragover` del documento, per
 * ogni trascinata. Ma `preventDefault` sul `dragover` è LETTERALMENTE il modo in
 * cui una zona dice «sì, qui puoi lasciare» — stenderlo sul documento vuol dire
 * dire di sì da ogni pixel della finestra. Il cursore mostrava «sposta» anche
 * sopra i posti che il drop poi rifiutava, e una zona che si tira indietro non
 * aveva nessun modo di farsi sentire: il suo silenzio veniva coperto un livello
 * più su. Diversi commenti in giro per il codice («no preventDefault → the
 * browser shows "no drop"») descrivevano un comportamento che la rete rendeva
 * impossibile.
 *
 * Le trascinate ESTERNE — file dal Finder, link, testo — restano coperte: sono
 * quelle che possono portare la finestra su un `file://`, ed è da quelle che la
 * rete difende. Le nostre no: se ne occupano le zone, una per una, che è
 * l'unico livello che sa se quel gesto lì ha senso.
 */
const TIPI_NOSTRI: readonly string[] = [
  ...Object.values(DND_TYPES),
  // Le due famiglie con l'ambito nell'hash del NOME (vedi sopra): il prefisso è
  // la parte stabile, la coda cambia col progetto o col gruppo.
  'application/x-pane-scope-',
  'application/x-pane-solo-src-',
];

export function isInternalDrag(types: readonly string[]): boolean {
  return types.some(t => TIPI_NOSTRI.some(nostro => t.startsWith(nostro)));
}


