/**
 * Pane-config helpers: pure id construction, type inference, and the
 * PANE_CONFIG map used by every UI consumer that renders a pane tab or
 * pane-type picker. All symbols here are pure — no side effects, no
 * reducer mutation. State mutation goes through usePaneStore dispatch.
 */
import type { Pane, PaneType } from '../../../types';
import { generateUUID } from '../../../utils/uuid';

/**
 * Where a pane type can be added from via a tab bar's `+` menu.
 * - 'standalone' = top-level chat group (no project context)
 * - 'project'    = inside a project window (any group, regardless of group.type)
 *
 * Pane types omitted from `addableScopes` (or with an empty array) are NOT
 * surfaced in any tab bar `+` menu — they get added from the sidebar, command
 * palette, or programmatically. This is the canonical list. Tab-bar code
 * MUST derive its menu from this field; do not hardcode arrays at call
 * sites (the previous version did, and they drifted apart).
 */
export type PaneScope = 'standalone' | 'project';

export interface PaneConfig {
  icon: string;
  label: string;
  color: string;
  singleton?: boolean;
  fixed?: boolean;
  /**
   * Tab-bar `+` menu scopes. `'chat'` is omitted on purpose — chat creation
   * uses the dedicated `onNewChat` affordance (top of menu), not the generic
   * `onAddPane(type)` path. See `getAddableTypesForScope` below.
   */
  addableScopes?: readonly PaneScope[];
}

// Keyed by the authoritative `PaneType` union (state/pane/types.ts), a
// superset of the types that ship with a visual configuration — reserved
// future types (`agent`, `session`, `context`, `editor`, `webhooks`, `cron`,
// `remote-access`, `system-status`, `processes`) have no entry. Use
// `getPaneConfig(type)` below for a safe lookup with a `chat` fallback.
export const PANE_CONFIG: Partial<Record<PaneType, PaneConfig>> = {
  chat:          { icon: 'MessageSquare', label: 'Chat',         color: '#0066ff' },
  file:          { icon: 'FileCode',      label: 'File',         color: '#f59e0b' },
  files:         { icon: 'FolderTree',    label: 'Files',        color: '#f59e0b', singleton: true, addableScopes: ['project'] },
  browser:       { icon: 'Globe',         label: 'Browser',      color: '#10b981', addableScopes: ['standalone', 'project'] },
  terminal:      { icon: 'Terminal',      label: 'Terminal',     color: '#8b5cf6', addableScopes: ['standalone', 'project'] },
  git:           { icon: 'GitBranch',     label: 'Git',          color: '#ef4444', singleton: true, addableScopes: ['project'] },
  activity:      { icon: 'Activity',      label: 'Activity',     color: '#06b6d4', singleton: true },
  journal:       { icon: 'BookOpen',      label: 'Journal',      color: '#f97316', singleton: true },
  agents:        { icon: 'Cpu',           label: 'Agents',       color: '#8b5cf6', singleton: true },
  dashboard:     { icon: 'BarChart3',     label: 'Dashboard',    color: '#f59e0b', singleton: true },
  kanban:        { icon: 'Kanban',        label: 'Board',        color: '#10b981', singleton: true, addableScopes: ['project'] },
  board:         { icon: 'Kanban',        label: 'Board generale', color: '#10b981', singleton: true, addableScopes: ['standalone'] },
  cron:          { icon: 'Clock',         label: 'Cron',         color: '#f59e0b', singleton: true },
  project:       { icon: 'FolderOpen',   label: 'Project',       color: '#10b981', singleton: false },
  'process-log':    { icon: 'Terminal',     label: 'Process',       color: '#8b5cf6' },
  'session-viewer': { icon: 'Eye',          label: 'Session',       color: '#8b5cf6' },
};

/**
 * Canonical list of pane types addable in a given scope, in the order they
 * should appear in the `+` menu. Excludes `chat` (handled by `onNewChat`),
 * `fixed` panes, and types the caller has marked as currently-singleton-and-
 * already-present via `excludeSingletonsPresent`.
 *
 * The order respects the iteration order of PANE_CONFIG so adding a new pane
 * type with `addableScopes` set is the only edit needed to surface it
 * everywhere — no call-site array maintenance.
 */
export function getAddableTypesForScope(
  scope: PaneScope,
  excludeSingletonsPresent: ReadonlySet<PaneType> = new Set(),
): PaneType[] {
  const out: PaneType[] = [];
  for (const [type, config] of Object.entries(PANE_CONFIG) as [PaneType, PaneConfig][]) {
    if (!config) continue;
    if (config.fixed) continue;
    if (!config.addableScopes?.includes(scope)) continue;
    if (config.singleton && excludeSingletonsPresent.has(type)) continue;
    out.push(type);
  }
  return out;
}

/**
 * Safe lookup for PANE_CONFIG — returns the chat config as a fallback for
 * reserved types that don't have their own entry. Prefer this over
 * `PANE_CONFIG[type]!` at call sites that can't bail out cleanly.
 */
export function getPaneConfig(type: PaneType): PaneConfig {
  return PANE_CONFIG[type] ?? PANE_CONFIG.chat!;
}

export function createPaneId(type: PaneType, key?: string): string {
  if (type === 'chat' && key) return `chat:${key}`;
  if (type === 'project' && key) return `project:${encodeURIComponent(key)}`;
  if (type === 'browser' && key) return `browser:${key}`;
  if (type === 'terminal' && key) return `terminal:${key}`;
  if (type === 'session-viewer' && key) return `session-viewer:${key}`;
  // Use the polyfilled helper so non-secure contexts (HTTP dev servers,
  // older webviews) still get a valid UUID — raw crypto.randomUUID is
  // unavailable there and would throw.
  return `${type}:${generateUUID()}`;
}

export function isProjectPaneId(id: string): boolean {
  return id.startsWith('project:');
}

export function isBrowserPaneId(id: string): boolean {
  return id.startsWith('browser:');
}

export function isTerminalPaneId(id: string): boolean {
  return id.startsWith('terminal:');
}

export function getBrowserContextFromPaneId(id: string): string | null {
  if (!isBrowserPaneId(id)) return null;
  return id.slice('browser:'.length);
}

export function getTerminalSessionFromPaneId(id: string): string | null {
  if (!isTerminalPaneId(id)) return null;
  return id.slice('terminal:'.length);
}

export function getProjectPathFromPaneId(id: string): string | null {
  if (!isProjectPaneId(id)) return null;
  return decodeURIComponent(id.slice('project:'.length));
}

/**
 * A TASK WORKSPACE is a dispatcher-created per-task cwd under the openclaw
 * workspace (`…/workspace/tasks/<id8>`) — see the server dispatcher's
 * `catchAllTaskDir`. It reuses the project-window machinery (a `project:` pane)
 * but is presented as the TASK's own splittable workspace, not a project: its
 * session opens standalone (never routed into a project window) and its label
 * is the task title, not the dir basename. This predicate is the single
 * source of truth that distinguishes the two.
 */
export function isTaskWorkspacePath(path: string | null | undefined): boolean {
  return !!path && /(^|\/)workspace\/tasks\/[^/]+\/?$/.test(path);
}

/**
 * Canonical sidebar-item PIN KEY for a pane, or undefined when the pane type
 * isn't pinnable (ephemeral views — file/git/activity/journal/agents/dashboard/
 * session-viewer — have no persistent sidebar row to "Fissa"). This is the
 * SINGLE source of truth for pinning across every tab type, so no surface can
 * silently omit one (the browser omission was exactly that bug). The returned
 * string is verbatim the id stored in `pinnedItems`, so callers feed it straight
 * to togglePin / isPinned:
 *   • chat     → the bare topicId (chat sidebar rows are keyed by topicId)
 *   • terminal → the pane id `terminal:<sessionId>`
 *   • browser  → the pane id `browser:<contextId>`
 *   • project  → the pane id `project:<encodedPath>`
 */
export function pinKeyForPane(pane: Pane): string | undefined {
  switch (pane.type) {
    case 'chat':
      return pane.topicId || undefined;
    case 'terminal':
      return isTerminalPaneId(pane.id) ? pane.id : undefined;
    case 'browser':
      return isBrowserPaneId(pane.id) ? pane.id : undefined;
    case 'project':
      return isProjectPaneId(pane.id) ? pane.id : undefined;
    default:
      return undefined;
  }
}

/**
 * Una tab fissata non si chiude: prima la si toglie dai Fissati.
 *
 * Decisione di prodotto (Attilio, 2026-08-03), e discende dal modello a UNO
 * stato: chiudere una tab È il ritiro della cosa che c'è dentro — la chat viene
 * archiviata, la sessione ritirata. Se chiudere è definitivo, allora fissare
 * deve poter dire «questa no». Prima le due cose convivevano nel modo peggiore:
 * la tab fissata si chiudeva e si archiviava come le altre, e restava in lista
 * solo grazie a un'eccezione nella barra laterale — cioè il fissaggio non
 * proteggeva niente, decorava.
 *
 * Vale per ogni tipo fissabile (chat, terminale, browser, progetto): il criterio
 * è `pinKeyForPane`, la stessa chiave con cui il fissaggio è stato messo.
 * Una pane non fissabile (senza chiave) è sempre chiudibile.
 */
export function isPaneClosable(pane: Pane, isPinned: (pinKey: string) => boolean): boolean {
  const key = pinKeyForPane(pane);
  if (!key) return true;
  return !isPinned(key);
}

export function isSessionViewerPaneId(id: string): boolean {
  return id.startsWith('session-viewer:');
}

export function getSessionKeyFromViewerPaneId(id: string): string | null {
  if (!isSessionViewerPaneId(id)) return null;
  return id.slice('session-viewer:'.length);
}

/**
 * La CHIAVE DI SESSIONE della chat mostrata in un pane, o `null` se quel pane
 * non è una chat.
 *
 * Serviva, e non esisteva: chi aveva in mano un paneId lo usava DIRETTAMENTE
 * come sessionKey. Per una chat non lo è mai — il pane è il TOPIC
 * (`<uuid>` in alto, `chat:<uuid>` dentro una finestra di progetto), la sessione
 * è `topic:<uuid8>`. Ogni lookup per sessionKey partito da un paneId cadeva
 * quindi a vuoto in SILENZIO: nessun errore, solo una funzione che non fa
 * niente. È così che Escape "interrompi il turno" non ha mai interrotto un bel
 * niente fuori dai pane `session-viewer:` (gli unici il cui id CONTIENE la
 * sessionKey), pur essendo scritto nel pannello delle scorciatoie.
 *
 * `topics` è la mappa per id del client: la sessionKey è un dato del topic, non
 * si ricava dall'id (`topic:` + i primi 8 caratteri è una convenzione del
 * server, non un contratto del client).
 */
export function sessionKeyForPaneId(
  paneId: string | null | undefined,
  topics: Record<string, { sessionKey?: string }>,
): string | null {
  if (!paneId) return null;
  const viewerKey = getSessionKeyFromViewerPaneId(paneId);
  if (viewerKey) return viewerKey;
  const topicId = paneId.startsWith('chat:') ? paneId.slice('chat:'.length) : paneId;
  // Terminale, browser, progetto, bozza, log: non sono chat, non hanno sessione.
  if (isKnownPanePrefix(topicId)) return null;
  return topics[topicId]?.sessionKey ?? null;
}

export function isDraftPaneId(id: string): boolean {
  return id.startsWith('draft:');
}

export function createDraftPaneId(): string {
  return `draft:${generateUUID()}`;
}

const KNOWN_PANE_PREFIXES = [
  'project:',
  'browser:',
  'terminal:',
  'draft:',
  'chat:',
  'session-viewer:',
  'process-log:',
  '__',
];

export function isKnownPanePrefix(id: string): boolean {
  return KNOWN_PANE_PREFIXES.some((prefix) => id.startsWith(prefix));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUUIDLike(id: string): boolean {
  return UUID_RE.test(id);
}

let _groupCounter = 0;

export function createGroupId(): string {
  return `group:${Date.now()}-${++_groupCounter}`;
}
