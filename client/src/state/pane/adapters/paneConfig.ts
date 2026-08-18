/**
 * Pane-config helpers: pure id construction, type inference, and the
 * PANE_CONFIG map used by every UI consumer that renders a pane tab or
 * pane-type picker. All symbols here are pure — no side effects, no
 * reducer mutation. State mutation goes through usePaneStore dispatch.
 */
import type { Pane, PaneType } from '../../../types';
import { generateUUID } from '../../../utils/uuid';
import { TAB_PANELS, type TabTarget } from '../../../../../shared/tab-link';
import { parseUtilityPanelType } from './utilityPanelId';

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

/**
 * Una capacità dell'INSTALLAZIONE, non della finestra: qualcosa che c'è o non
 * c'è a seconda di come questo Topics è configurato. Un tipo che la richiede e
 * non la trova non viene proposto in nessun menu — aprirlo darebbe una pane
 * vuota, che è peggio di una voce assente.
 *
 * Oggi ce n'è una sola (`openclaw`, cioè GATEWAY_URL/TOKEN configurati) e il
 * suo unico cliente è `cron`. Prima il filtro stava scritto a mano nel menu
 * «Topics ▾» che apriva quelle pagine (`.filter(id => id !== 'cron' || …)`):
 * un gate su UNA superficie, che sarebbe rimasto indietro alla prima superficie
 * nuova. Qui è una proprietà del TIPO, quindi vale ovunque per costruzione.
 */
export type PaneRequirement = 'openclaw';

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
  /** Capacità dell'installazione senza la quale il tipo NON si propone. */
  requires?: PaneRequirement;
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
  plan:          { icon: 'BookOpen',      label: 'Piano',        color: '#f97316' },
  // Dashboard e Cron si aprivano SOLO dal dropdown «Topics ▾», e lì si
  // chiamavano «Statistics» e «Cron Jobs» — due nomi che nessun'altra
  // superficie usava (la tab, la sidebar e i permalink leggono di qui). Ora
  // stanno nel «+» come ogni altra pane, col nome che hanno davvero.
  dashboard:     { icon: 'BarChart3',     label: 'Dashboard',    color: '#f59e0b', singleton: true, addableScopes: ['standalone'] },
  kanban:        { icon: 'Kanban',        label: 'Board',        color: '#10b981', singleton: true, addableScopes: ['project'] },
  // 'Board' secca anche qui: il gemello di progetto (`kanban`) porta lo stesso
  // nome, ma i due non compaiono mai nello stesso menu — `addableScopes` li
  // tiene su superfici diverse (standalone vs progetto), quindi «generale»
  // distingueva da una cosa che non era mai lì accanto.
  board:         { icon: 'Kanban',        label: 'Board',        color: '#10b981', singleton: true, addableScopes: ['standalone'] },
  cron:          { icon: 'Clock',         label: 'Cron',         color: '#f59e0b', singleton: true, addableScopes: ['standalone'], requires: 'openclaw' },
  profile:       { icon: 'UserRound',     label: 'Profilo',      color: '#0066ff', singleton: true, addableScopes: ['standalone'] },
  project:       { icon: 'FolderOpen',   label: 'Project',       color: '#10b981', singleton: false },
  'process-log':    { icon: 'Terminal',     label: 'Process',       color: '#8b5cf6' },
};

/**
 * Le capacità che questa installazione HA, oggi. Insieme VUOTO all'avvio, e
 * quello è il verso giusto del dubbio: finché nessuno ha detto che OpenClaw
 * c'è, Cron non si propone. L'errore possibile è una voce che compare tardi,
 * non una che apre il vuoto.
 *
 * Vive qui, e non letta da `providersSnapshotStore`, per non trascinare
 * `lib/api` (rete, sessione, ~1300 righe) dentro un adattatore che tutta la UI
 * importa. Lo scrittore è UNO — App, accanto a `useOpenClawAvailable()` — e
 * scrive in RENDER, non in un effetto: App renderizza prima dei suoi figli,
 * quindi il menu costruito nello stesso passo vede già il valore nuovo. Da un
 * effetto arriverebbe un render in ritardo, e nessuno ne pianificherebbe un
 * altro per recuperarlo.
 */
const paneCapabilities = new Set<PaneRequirement>();

/** Dichiara se una capacità è disponibile. Idempotente (StrictMode rirenderizza
 *  due volte) e senza effetti su React: è una Set di modulo, non uno stato. */
export function setPaneCapability(cap: PaneRequirement, available: boolean): void {
  if (available) paneCapabilities.add(cap);
  else paneCapabilities.delete(cap);
}

/**
 * Canonical list of pane types addable in a given scope, in the order they
 * should appear in the `+` menu. Excludes `chat` (handled by `onNewChat`),
 * `fixed` panes, types whose `requires` capability isn't available, and types
 * the caller has marked as currently-singleton-and-already-present via
 * `excludeSingletonsPresent`.
 *
 * The order respects the iteration order of PANE_CONFIG so adding a new pane
 * type with `addableScopes` set is the only edit needed to surface it
 * everywhere — no call-site array maintenance.
 *
 * `capabilities` è esplicito nella firma (col default ambientale) perché la
 * funzione resti PURA quando la si prova: il test passa l'insieme che vuole,
 * la UI si affida al registro sopra.
 */
export function getAddableTypesForScope(
  scope: PaneScope,
  excludeSingletonsPresent: ReadonlySet<PaneType> = new Set(),
  capabilities: ReadonlySet<PaneRequirement> = paneCapabilities,
): PaneType[] {
  const out: PaneType[] = [];
  for (const [type, config] of Object.entries(PANE_CONFIG) as [PaneType, PaneConfig][]) {
    if (!config) continue;
    if (config.fixed) continue;
    if (!config.addableScopes?.includes(scope)) continue;
    if (config.requires && !capabilities.has(config.requires)) continue;
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
  // Use the polyfilled helper so non-secure contexts (HTTP dev servers,
  // older webviews) still get a valid UUID — raw crypto.randomUUID is
  // unavailable there and would throw.
  return `${type}:${generateUUID()}`;
}

/**
 * Il contesto di un browser che l'UTENTE ha appena chiesto — «+ → Browser», o
 * la voce Browser del menu della sidebar.
 *
 * Fresco a ogni chiamata, di proposito. Un gesto esplicito deve aprire un
 * browser NUOVO: senza un contesto, `browserSingletonReducer` cade nel ramo
 * «riusa il primo browser che trovi» e il secondo click non fa NIENTE — nessuna
 * tab, nessun errore, il no-op silenzioso che è il difetto più difficile da
 * vedere. Le porte automatiche (WS `browser:navigate`, evento DOM) passano il
 * PROPRIO contextId, oppure nessuno e tengono il riuso: quella è una
 * navigazione, non una richiesta di aprire una superficie in più.
 *
 * Una sola funzione perché le due porte utente non possano più divergere: la
 * sidebar mintava già un contesto nuovo (`new-<timestamp>`) mentre il «+» della
 * barra non ne passava nessuno, ed è da lì che veniva l'asimmetria.
 */
export function newBrowserContextId(): string {
  return `new-${generateUUID()}`;
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
 * isn't pinnable (ephemeral views — file/git/plan/dashboard — have no
 * persistent sidebar row to "Fissa"). This is the
 * SINGLE source of truth for pinning across every tab type, so no surface can
 * silently omit one (the browser omission was exactly that bug). The returned
 * string is verbatim the id stored in `pinnedItems`, so callers feed it straight
 * to togglePin / isPinned:
 *   • chat     → the bare topicId (chat sidebar rows are keyed by topicId)
 *   • terminal → the pane id `terminal:<sessionId>`
 *   • browser  → the pane id `browser:<contextId>`
 *   • project  → `project:<rawPath>` — the SIDEBAR-ITEM form, NOT `pane.id`
 *
 * ── Perché il progetto non porta `pane.id` ───────────────────────────────────
 * Il progetto è l'unico tipo con due forme in circolazione: la riga della
 * sidebar è chiavata sul path GREZZO (`project:/Users/…`, buildSidebarItems)
 * mentre la pane usa quello CODIFICATO (`project:%2FUsers%2F…`). Finché questa
 * funzione restituiva `pane.id`, fissare dalla TAB scriveva la forma codificata
 * e il blocco Fissati — che cerca la grezza — non trovava mai quel progetto: la
 * riga non compariva, e lo stesso progetto poteva finire DUE VOLTE in
 * `pinnedItems`, una per superficie. La forma grezza è quella canonica perché è
 * l'unica delle due che una sidebar può produrre da sé; `normalizePinKey`
 * riporta a questa forma tutto ciò che è stato salvato prima.
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
      return isProjectPaneId(pane.id) ? normalizePinKey(pane.id) : undefined;
    default:
      return undefined;
  }
}

/**
 * La chiave di pin che corrisponde a un id di PANE — l'inverso di
 * `sidebarItemPaneId`, per chi riceve un drag (che porta pane) e deve fissare
 * (che vuole righe).
 *
 * Le due forme coincidono per terminali e browser; divergono per il progetto
 * (path codificato → grezzo) e per la chat, che come pane può presentarsi
 * `chat:<topicId>` dentro una finestra di progetto ma si fissa sempre sul
 * topicId nudo.
 */
export function pinKeyFromPaneId(paneId: string): string {
  if (isProjectPaneId(paneId)) return normalizePinKey(paneId);
  if (paneId.startsWith('chat:')) return paneId.slice('chat:'.length);
  return paneId;
}

/**
 * Riporta una chiave di pin alla sua forma canonica. Solo i progetti hanno due
 * forme (vedi `pinKeyForPane`): qui la codificata torna grezza, tutto il resto
 * passa intatto. È idempotente — una chiave già canonica esce identica — quindi
 * si può applicare a ogni caricamento senza tenere il conto di chi l'ha già vista.
 *
 * Un path che contiene un `%` letterale non decodificabile farebbe lanciare
 * `decodeURIComponent`: in quel caso si tiene la chiave com'è, perché una chiave
 * strana è comunque meglio di un boom al boot.
 */
export function normalizePinKey(key: string): string {
  if (!isProjectPaneId(key)) return key;
  const raw = key.slice('project:'.length);
  try {
    return `project:${decodeURIComponent(raw)}`;
  } catch {
    return key;
  }
}

/**
 * Il TARGET DI PERMALINK di un pane (`shared/tab-link`), o `null` se quel pane
 * non è indirizzabile. Gemella di `pinKeyForPane` e con la stessa filosofia: UNA
 * funzione per tutti i tipi, così nessuna superficie può dimenticarne uno (la
 * dimenticanza del browser nel pinning è stata esattamente quel bug).
 *
 * ── Perché metà dei tipi torna `null`, e perché è la cosa giusta ─────────────
 * `file`/`kanban`/`git`/`files`/`process-log`/`draft` nascono
 * con un id `<tipo>:<uuid>` sorteggiato a ogni apertura (`createPaneId`): quel
 * numero non identifica NIENTE dopo un reload. Per il file l'identità vera è il
 * CONTENUTO (`filePath` + il progetto che lo ospita) — ed è quella che
 * emettiamo; per gli altri non esiste affatto, e un link che al reload
 * successivo aprirebbe un pane a caso è peggio di nessun link. Il `null` è
 * quindi il GATE della voce di menu «Copia link»: chi chiama non la mostra, e
 * non c'è modo di produrre un permalink morto.
 *
 * ── Perché la chat porta il topicId e non `pane.id` ──────────────────────────
 * La stessa chat ha due id di pane a seconda della superficie (`<topicId>` nudo
 * a livello App, `chat:<topicId>` dentro una finestra di progetto). Col pane id
 * il link aprirebbe una SECONDA tab della stessa chat sulla superficie
 * sbagliata; col topic la scelta della superficie resta a `openPanel`, che la fa
 * già (e disarchivia da sé).
 *
 * `ctx` porta l'OSPITE del pane, che il pane stesso non conosce: il
 * `projectPath` della finestra di progetto in cui è montato (obbligatorio per
 * file/diff, hint di proprietà per il browser) e il `taskId` del drawer che lo
 * possiede (le tab browser di un task, `taskBrowserLayout`). Nessun campo nuovo
 * sul `Pane`: uno fuori dalla whitelist di `sanitizeSnapshot` sparirebbe a ogni
 * round-trip col server.
 */
export function tabTargetForPane(
  pane: Pane,
  ctx?: { projectPath?: string; taskId?: string },
): TabTarget | null {
  if (!pane?.id) return null;

  switch (pane.type) {
    case 'chat': {
      // Le bozze (`draft:<uuid>`) non hanno ancora un topic: niente da linkare.
      const topicId = pane.topicId;
      return topicId ? { kind: 'chat', key: topicId } : null;
    }
    case 'terminal': {
      // L'id contiene la sessione (`terminal:<sessionId>`); il campo è il
      // ripiego per i pane legacy costruiti senza passare da createPaneId.
      const sessionId = getTerminalSessionFromPaneId(pane.id) ?? pane.terminalSessionId;
      return sessionId ? { kind: 'terminal', key: sessionId } : null;
    }
    case 'browser': {
      const contextId = getBrowserContextFromPaneId(pane.id);
      if (!contextId) return null;
      const target: TabTarget = { kind: 'browser', key: contextId };
      // Hint di PROPRIETÀ, non parte dell'identità: il contextId basta a
      // risolvere la pane, questi dicono solo dove ri-crearla se la finestra che
      // la ospitava è chiusa.
      if (ctx?.projectPath) target.projectPath = ctx.projectPath;
      if (ctx?.taskId) target.taskId = ctx.taskId;
      return target;
    }
    case 'project': {
      const projectPath = getProjectPathFromPaneId(pane.id) ?? pane.projectPath;
      return projectPath ? { kind: 'project', key: projectPath } : null;
    }
    case 'file': {
      // `diffProjectPath` è l'unico progetto che un pane file porta con sé (solo
      // in vista diff), e per un DIFF è l'AUTORITÀ — viene prima dell'ospite.
      // Non è teoria: `open-file-diff` è un evento globale senza lo scoping di
      // progetto che `open-file` ha (shouldHandleOpenFile), quindi un diff
      // aperto dal Git del progetto B compare anche nella finestra di A. Con
      // l'ordine invertito, «Copia link» da lì produceva
      // `{key:'/B/src/x.ts', projectPath:'/A'}`: riaprendolo, il path relativo
      // non trova il prefisso, `handleOpenDiff` ricompone `/A//B/src/x.ts` e il
      // pane nasce su un file che non esiste (lato server, `resolveFile`
      // rispondeva `closed` su un diff vivo). Per un file NORMALE
      // `diffProjectPath` è assente, quindi l'ospite resta l'unica fonte.
      const projectPath = pane.diffProjectPath ?? ctx?.projectPath;
      if (!pane.filePath || !projectPath) return null;
      return { kind: pane.diff ? 'diff' : 'file', key: pane.filePath, projectPath };
    }
    default: {
      // Utility singleton (`__board__`, `__dashboard__`, …). Fuori da
      // TAB_PANELS `handleOpenAsPage` non sa aprire niente, quindi il link non
      // aprirebbe niente — meglio nessuna voce.
      const utility = parseUtilityPanelType(pane.id);
      if (utility && (TAB_PANELS as readonly string[]).includes(utility)) {
        return { kind: 'panel', key: utility };
      }
      return null;
    }
  }
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
 * niente, pur essendo scritto nel pannello delle scorciatoie.
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
