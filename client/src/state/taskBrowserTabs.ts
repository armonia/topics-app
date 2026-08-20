/**
 * taskBrowserTabs — a task-owned, multi-tab browser group.
 *
 * A Kanban task can host several browser tabs shown INSIDE its drawer, scoped
 * to the task and invisible to the global layout. Deliberately kept OUT of the
 * pane store (`pane-store-v2`): everything in that store is a candidate for the
 * global tab bar / browserSingletonReducer / PURGE_ORPHAN_PANE / tombstones /
 * LWW eviction. Staying out means "hidden from the global layout" is free AND
 * the contextId-divergence bug class (browserSpawner / resolveTerminalBrowser…)
 * simply cannot occur for task tabs — nothing routes them through the layout.
 *
 * Persistence mirrors `boardDrafts` (lib/board.ts): the generic `ui-state`
 * store, one key PER TASK (`task-browser-tabs:<taskId>`), debounced writes,
 * LWW, survives reload + follows the user across clients. Per-task keys keep
 * edits on different tasks from clobbering each other.
 *
 * The contextId is CANONICAL: minted once at open (`task-<id8>-<seq>`), recorded
 * here, and used verbatim for navigate/close/focus/list — routing + inventory
 * are opaque-string-keyed, so one identity works end to end.
 */

import { useSyncExternalStore, useEffect } from 'react';
import { getTabId } from './pane/middleware/syncCrossTab';

/**
 * Chi ha deciso l'etichetta di una tab, in ordine di autorità crescente:
 *
 *  - `auto`  — il titolo della pagina, riletto a ogni navigazione;
 *  - `agent` — il NOME prescritto dall'agente (`open_browser_pane({url, name})`):
 *              è il manifesto della consegna, quindi la pagina non lo sovrascrive;
 *  - `user`  — la rinomina fatta a mano, che vince su tutto.
 *
 * La regola è una sola e vale per ogni scrittore: una patch cambia il titolo
 * SOLO se la sua autorità è ≥ di quella già registrata (vedi `titleRank`).
 */
export type TaskTabTitleSource = 'auto' | 'agent' | 'user';

/** Autorità di una fonte di titolo. Assente ⟺ `auto` (il titolo della pagina). */
export function titleRank(source: TaskTabTitleSource | undefined): number {
  return source === 'user' ? 2 : source === 'agent' ? 1 : 0;
}

/** Etichetta decisa da qualcuno (agente o umano): il poll del titolo non la tocca. */
export function isPinnedTitle(source: TaskTabTitleSource | undefined): boolean {
  return titleRank(source) > 0;
}

export interface TaskBrowserTab {
  /** Canonical browser contextId: `task-<id8>-<seq>`. */
  contextId: string;
  url: string;
  title: string;
  /** Monotonic within a task; also the `<seq>` in the contextId. */
  seq: number;
  /**
   * Soft-close marker. A parked tab is NOT in the live layout but is kept as a
   * clickable preview under the task description, so closing a tab doesn't
   * destroy it — the user (or agent) can reopen it (`unparkTab`) to its last
   * url. `removeTab` is the explicit hard-delete (the preview's trash). Absent
   * ⟺ live. A pinned `titleSource` (agent/user) holds the label against the
   * live-title poll.
   */
  parked?: boolean;
  titleSource?: TaskTabTitleSource;
  /**
   * Handle di login salvato dall'agente su QUESTA tab (`browser_save_state`).
   * Chi monta la tab lo inietta una volta (`browser_load_state`) e il reviewer
   * atterra già dentro, invece di trovare il muro del login. Scritto dal server
   * (`task-tab-persist`), qui è di sola lettura.
   */
  loginHandle?: string;
}

export interface TaskBrowserTabsState {
  tabs: TaskBrowserTab[];
  activeContextId: string | null;
  /** Next seq to mint. Kept ahead of every tab's seq so ids never collide. */
  nextSeq: number;
}

export const EMPTY_TASK_TABS: TaskBrowserTabsState = { tabs: [], activeContextId: null, nextSeq: 0 };

// ── canonical contextId ──────────────────────────────────────────────────────

/** Mint a task-scoped browser contextId. `id8` matches the sessionKey /
 *  `workspace/tasks/<id8>` truncation convention; `seq` disambiguates tabs. */
export function mintTaskContextId(taskId: string, seq: number): string {
  return `task-${taskId.slice(0, 8)}-${seq}`;
}

// Le altre due forme di contextId — quella coniata dal server per il manifesto
// (`task-<id8>-n<slug>`) e il gemello nel workspace (`<ctx>_ws`) — stanno in
// `shared/task-tab-context.ts`, che è la sola definizione condivisa con il
// server. Qui si ri-esportano perché il client le nomina da questo modulo.
export { isTaskContextId, workspaceTwinContextId } from '../../../shared/task-tab-context';

// ── pure reducer ops (unit-tested; no I/O) ───────────────────────────────────

/** Append a new tab with a freshly-minted ctx; it becomes active. */
export function addTab(state: TaskBrowserTabsState, taskId: string, url: string, title = ''): TaskBrowserTabsState {
  const seq = state.nextSeq;
  const contextId = mintTaskContextId(taskId, seq);
  return {
    tabs: [...state.tabs, { contextId, url, title, seq }],
    activeContextId: contextId,
    nextSeq: seq + 1,
  };
}

/** Append/reuse a tab under a contextId minted ELSEWHERE (agent/server open).
 *  Idempotent: an existing ctx is refreshed (url/title), UN-PARKED (a re-open
 *  of a soft-closed tab brings it back live) + activated, never duplicated.
 *  `nextSeq` is advanced past any embedded seq so a later client mint can't
 *  collide. `titleSource` porta l'autorità dell'etichetta: un nome prescritto
 *  dall'agente entra come `agent` e non viene più sovrascritto dal titolo della
 *  pagina — ma una rinomina a mano lo batte comunque. */
export function upsertTab(
  state: TaskBrowserTabsState,
  contextId: string,
  url: string,
  title = '',
  titleSource: TaskTabTitleSource = 'auto',
): TaskBrowserTabsState {
  const existing = state.tabs.find((t) => t.contextId === contextId);
  if (existing) {
    const accepts = !!title && titleRank(titleSource) >= titleRank(existing.titleSource);
    return {
      ...state,
      tabs: state.tabs.map((t) => (t.contextId === contextId
        ? {
            ...t,
            url: url || t.url,
            ...(accepts ? { title, titleSource } : {}),
            parked: false,
          }
        : t)),
      activeContextId: contextId,
    };
  }
  const seq = state.nextSeq;
  return {
    tabs: [...state.tabs, { contextId, url, title, seq, ...(title && titleSource !== 'auto' ? { titleSource } : {}) }],
    activeContextId: contextId,
    nextSeq: seq + 1,
  };
}

/** Live (non-parked) tabs — the ones that render in the layout. Parked tabs
 *  stay in `tabs` as previews under the description. */
export function liveTabs(state: TaskBrowserTabsState): TaskBrowserTab[] {
  return state.tabs.filter((t) => !t.parked);
}

/** Pick the active ctx after `contextId` leaves the live set: the live neighbour
 *  that slides into its slot, or null when none remain live. */
function neighbourActive(state: TaskBrowserTabsState, contextId: string): string | null {
  const live = liveTabs(state);
  const idx = live.findIndex((t) => t.contextId === contextId);
  const rest = live.filter((t) => t.contextId !== contextId);
  if (!rest.length) return null;
  return rest[Math.min(Math.max(idx, 0), rest.length - 1)].contextId;
}

/** Soft-close: PARK a tab (kept as a preview) instead of destroying it; if it
 *  was active, focus the live neighbour that slides into its slot. Idempotent. */
export function closeTab(state: TaskBrowserTabsState, contextId: string): TaskBrowserTabsState {
  const tab = state.tabs.find((t) => t.contextId === contextId);
  if (!tab || tab.parked) return state;
  const activeContextId = state.activeContextId === contextId ? neighbourActive(state, contextId) : state.activeContextId;
  return {
    ...state,
    tabs: state.tabs.map((t) => (t.contextId === contextId ? { ...t, parked: true } : t)),
    activeContextId,
  };
}

/** Reopen a parked tab (from the preview strip): un-park + activate. No-op for
 *  an unknown or already-live ctx. */
export function unparkTab(state: TaskBrowserTabsState, contextId: string): TaskBrowserTabsState {
  const tab = state.tabs.find((t) => t.contextId === contextId);
  if (!tab || !tab.parked) return state;
  return {
    ...state,
    tabs: state.tabs.map((t) => (t.contextId === contextId ? { ...t, parked: false } : t)),
    activeContextId: contextId,
  };
}

/** Hard-remove a tab entirely (the preview's trash). If it was the live active,
 *  focus the live neighbour. */
export function removeTab(state: TaskBrowserTabsState, contextId: string): TaskBrowserTabsState {
  const idx = state.tabs.findIndex((t) => t.contextId === contextId);
  if (idx < 0) return state;
  const activeContextId = state.activeContextId === contextId ? neighbourActive(state, contextId) : state.activeContextId;
  return { ...state, tabs: state.tabs.filter((t) => t.contextId !== contextId), activeContextId };
}

/** Set the active tab (no-op if the ctx isn't a LIVE tab of the group — a
 *  parked tab is reopened via `unparkTab`, never activated in place). */
export function setActiveTab(state: TaskBrowserTabsState, contextId: string | null): TaskBrowserTabsState {
  if (contextId !== null && !state.tabs.some((t) => t.contextId === contextId && !t.parked)) return state;
  if (contextId === state.activeContextId) return state;
  return { ...state, activeContextId: contextId };
}

/** Move the tab at `from` to index `to` (both clamped). */
export function reorderTabs(state: TaskBrowserTabsState, from: number, to: number): TaskBrowserTabsState {
  const n = state.tabs.length;
  if (from < 0 || from >= n) return state;
  const dst = Math.max(0, Math.min(to, n - 1));
  if (dst === from) return state;
  const tabs = [...state.tabs];
  const [moved] = tabs.splice(from, 1);
  tabs.splice(dst, 0, moved);
  return { ...state, tabs };
}

/** Merge a partial (url/title/titleSource) into a tab, e.g. after in-pane
 *  navigation, or a user rename (`titleSource:'user'` pins the label so the
 *  live page-title poll stops overwriting it — same contract as a pane's
 *  browser title). */
export function updateTab(state: TaskBrowserTabsState, contextId: string, patch: { url?: string; title?: string; titleSource?: TaskTabTitleSource }): TaskBrowserTabsState {
  const t = state.tabs.find((x) => x.contextId === contextId);
  if (!t) return state;
  // Un'etichetta decisa (agente o umano) non viene sovrascritta da una fonte di
  // autorità minore — il poll del titolo di pagina è `auto`, l'ultimo di tutti.
  const titleLocked = titleRank(patch.titleSource) < titleRank(t.titleSource);
  const nextTitle = patch.title !== undefined && !titleLocked ? patch.title : t.title;
  const nextSource = patch.titleSource ?? t.titleSource;
  const nextUrl = patch.url ?? t.url;
  if (nextUrl === t.url && nextTitle === t.title && nextSource === t.titleSource) return state;
  return {
    ...state,
    tabs: state.tabs.map((x) => (x.contextId === contextId
      ? { ...x, url: nextUrl, title: nextTitle, titleSource: nextSource }
      : x)),
  };
}

/** Coerce an untrusted ui-state payload into a valid state (or null). */
export function sanitizeTaskTabs(v: unknown): TaskBrowserTabsState | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.tabs)) return null;
  const tabs: TaskBrowserTab[] = [];
  for (const raw of o.tabs) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.contextId !== 'string' || !r.contextId) continue;
    tabs.push({
      contextId: r.contextId,
      url: typeof r.url === 'string' ? r.url : '',
      title: typeof r.title === 'string' ? r.title : '',
      seq: typeof r.seq === 'number' ? r.seq : 0,
      ...(r.parked === true ? { parked: true } : {}),
      ...(r.titleSource === 'user' || r.titleSource === 'agent' ? { titleSource: r.titleSource } : {}),
      ...(typeof r.loginHandle === 'string' && r.loginHandle ? { loginHandle: r.loginHandle } : {}),
    });
  }
  // The active ctx must reference a LIVE (non-parked) tab; fall back to the
  // first live tab so a persisted state where the active tab was parked
  // rehydrates onto something the layout can show.
  const liveList = tabs.filter((t) => !t.parked);
  const activeContextId = typeof o.activeContextId === 'string' && liveList.some((t) => t.contextId === o.activeContextId)
    ? o.activeContextId
    : (liveList[0]?.contextId ?? null);
  const maxSeq = tabs.reduce((m, t) => Math.max(m, t.seq), -1);
  const nextSeq = typeof o.nextSeq === 'number' && o.nextSeq > maxSeq ? o.nextSeq : maxSeq + 1;
  return { tabs, activeContextId, nextSeq };
}

// ── persistence (ui-state, per-task key) — mirrors lib/board.ts boardDrafts ───

async function uiGet<T>(key: string): Promise<T | null> {
  try {
    const r = await fetch(`/api/ui-state/${key}`); // PANE-01-ALLOWED: task-browser-tabs keys, not pane state
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    return (d?.value ?? null) as T | null;
  } catch { return null; }
}

/** Best-effort teardown of the server-side browser context behind a task tab.
 *  DELETE /api/browsers/:id closes the Playwright context + persists its state.
 *  Fire-and-forget: a task tab going away must not block on the network, and a
 *  missing context (never server-created, native-only) 404s harmlessly. */
function releaseBrowserContext(contextId: string): void {
  if (!contextId) return;
  void fetch(`/api/browsers/${encodeURIComponent(contextId)}`, { method: 'DELETE' }).catch(() => {});
}

const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
function uiPutDebounced(key: string, value: unknown, ms = 800): void {
  const t = writeTimers.get(key);
  if (t) clearTimeout(t);
  writeTimers.set(key, setTimeout(() => {
    writeTimers.delete(key);
    fetch(`/api/ui-state/${key}`, { // PANE-01-ALLOWED: task-browser-tabs keys, not pane state
      method: 'PUT',
      // X-Client-Id lets the server stamp the broadcast's `sourceClientId` so the
      // WS bridge can drop THIS client's own echo (else applyRemote would re-apply
      // our own write, or worse revert a newer local edit).
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': getTabId() },
      body: JSON.stringify(value),
    }).catch(() => {});
  }, ms));
}

const KEY_PREFIX = 'task-browser-tabs:';
const keyFor = (taskId: string) => `${KEY_PREFIX}${taskId}`;

/** Extract the taskId from a `task-browser-tabs:<taskId>` ui-state key (or null
 *  when the key isn't a task-tabs key). Lets the WS bridge route broadcasts. */
export function taskIdFromKey(key: string): string | null {
  return typeof key === 'string' && key.startsWith(KEY_PREFIX) ? key.slice(KEY_PREFIX.length) : null;
}

// ── in-memory cache + subscription (React) ───────────────────────────────────

const cache = new Map<string, TaskBrowserTabsState>();
const loaded = new Set<string>();
const loading = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) { try { l(); } catch { /* ignore */ } }
}

/** Lazily hydrate a task's tabs from ui-state (once). Safe to call repeatedly. */
export async function ensureTaskTabsLoaded(taskId: string): Promise<void> {
  if (!taskId || loaded.has(taskId) || loading.has(taskId)) return;
  loading.add(taskId);
  const v = await uiGet<unknown>(keyFor(taskId));
  loading.delete(taskId);
  loaded.add(taskId);
  // Don't clobber writes that landed while the GET was in flight.
  if (!cache.has(taskId)) {
    const sanitized = sanitizeTaskTabs(v);
    if (sanitized) { cache.set(taskId, sanitized); notify(); }
  }
}

export function getTaskTabs(taskId: string): TaskBrowserTabsState {
  return cache.get(taskId) ?? EMPTY_TASK_TABS;
}

/**
 * Quante tab di task sono in memoria adesso, per l'inventario del peso
 * (`lib/featureWeight.ts`).
 *
 * Le PARCHEGGIATE si contano a parte e non spariscono nel totale: una tab
 * parcheggiata è proprio il caso in cui qualcosa resta trattenuto senza essere
 * visibile da nessuna parte, cioè il motivo per cui questo inventario esiste.
 */
export function taskTabsCount(): { entries: number; items: number; parked: number } {
  let items = 0;
  let parked = 0;
  let entries = 0;
  for (const st of cache.values()) {
    if (st.tabs.length === 0) continue; // un task idratato e vuoto non è una voce
    entries++;
    items += st.tabs.length;
    parked += st.tabs.filter((t) => t.parked).length;
  }
  return { entries, items, parked };
}

function commit(taskId: string, next: TaskBrowserTabsState): void {
  const cur = cache.get(taskId) ?? EMPTY_TASK_TABS;
  if (next === cur) return;
  cache.set(taskId, next);
  loaded.add(taskId);
  uiPutDebounced(keyFor(taskId), next, next.tabs.length ? 800 : 0);
  notify();
}

/** Apply a server-pushed value for ONE task WITHOUT persisting it (no PUT echo).
 *  Returns true when the cache changed. A task with a PENDING local write is left
 *  untouched: the un-flushed edit is newer than any inbound frame and is about to
 *  be persisted + re-broadcast, so applying a remote value would clobber it. Marks
 *  the task loaded — the frame carries the full per-task record, so it supersedes
 *  a still-in-flight initial GET. */
function applyRemote(taskId: string, value: unknown): boolean {
  if (!taskId || writeTimers.has(keyFor(taskId))) return false;
  const sanitized = sanitizeTaskTabs(value);
  if (!sanitized) return false;
  loaded.add(taskId);
  const cur = cache.get(taskId);
  if (cur && JSON.stringify(cur) === JSON.stringify(sanitized)) return false;
  cache.set(taskId, sanitized);
  return true;
}

/**
 * Test seam: dimentica TUTTI i task.
 *
 * PERCHE' SERVE. `cache`, `loaded` e i timer di scrittura sono singleton di
 * modulo, e sotto `bun test` tutti i file girano nello STESSO processo: un file
 * che aggiunge tab lascia il suo residuo a chi viene dopo. Chi asserisce su una
 * SOMMA (`taskTabsCount`) diventa quindi verde da solo e rosso in suite — o,
 * peggio, il contrario, con l'ordine dei file a decidere l'esito.
 *
 * `forgetTaskTabs` da solo non basta: pulisce un task per volta, e per pulire
 * bisognerebbe sapere quali task ha creato qualcun altro.
 */
export function __resetTaskTabs(): void {
  for (const t of writeTimers.values()) clearTimeout(t);
  writeTimers.clear();
  cache.clear();
  loaded.clear();
  loading.clear();
}

/** Forget everything this client remembers about a task's tabs — called when the
 *  task is archived (`task:deleted`), because the server has just DELETED its
 *  ui-state row.
 *
 *  The pending write timer goes first: that debounced PUT is the only thing that
 *  can resurrect the key, and it fires up to 800 ms after the last edit — well
 *  past the archive. Dropping the cache is just memory (and stops a stale drawer
 *  from rendering tabs whose browser contexts the server has already destroyed).
 *
 *  An initial GET still in flight can repopulate the cache with the pre-archive
 *  value; it 404s once the row is gone, and either way it never PUTs, so the
 *  server stays clean — and the boot sweep re-purges anything that slips. */
export function forgetTaskTabs(taskId: string): void {
  if (!taskId) return;
  const key = keyFor(taskId);
  const t = writeTimers.get(key);
  if (t) { clearTimeout(t); writeTimers.delete(key); }
  loaded.delete(taskId);
  if (cache.delete(taskId)) notify();
}

/** Live-apply a single remote `ui-state:updated` for a task-browser-tabs key. The
 *  WS bridge drops this client's own echo (by sourceClientId) before calling, so a
 *  park/close/reorder/rename/remove on ANOTHER device updates this one in real time
 *  — the missing inbound path that left the store write-only. */
export function applyRemoteTaskTabs(taskId: string, value: unknown): void {
  if (applyRemote(taskId, value)) notify();
}

/** Live-apply the bulk `ui-state:init` snapshot on (re)connect: every
 *  task-browser-tabs key in `data`, coalesced into one notify. Resyncs closes the
 *  client missed while it was disconnected.
 *
 *  Un server aggiornato queste chiavi nello snapshot NON le manda più (erano il
 *  30% del payload di ogni riconnessione e nessuno le leggeva da lì): resta per i
 *  server vecchi, ed è il primo passo di `resyncTaskTabsFromServer`, che copre il
 *  resto con dei GET mirati. Restituisce gli id già riallineati da qui. */
export function applyRemoteTaskTabsInit(data: Record<string, unknown>): Set<string> {
  const applied = new Set<string>();
  let changed = false;
  for (const [key, value] of Object.entries(data)) {
    const taskId = taskIdFromKey(key);
    if (!taskId) continue;
    applied.add(taskId);
    if (applyRemote(taskId, value)) changed = true;
  }
  if (changed) notify();
  return applied;
}

/** RESYNC DI RICONNESSIONE, mirato.
 *
 *  Prima lo snapshot `ui-state:init` faceva anche da resync: portava OGNI chiave
 *  `task-browser-tabs:*` del db, così un client che era offline mentre un altro
 *  device chiudeva una tab si riallineava alla riconnessione. Costava il 30% del
 *  payload di ogni `ui-state:init` (91 righe / 31 KB su 172 / 101 KB, misurato
 *  l'11/08) per riallineare, quasi sempre, ZERO task: un client tiene in cache
 *  solo i task di cui ha davvero aperto il drawer.
 *
 *  Quindi il server non le manda più (`UI_STATE_INIT_EXCLUDED_PREFIXES`) e il
 *  riallineamento lo chiede il client, per i soli task che ha in cache — uno o
 *  due GET invece di novanta record. Un task MAI aperto non ha niente da
 *  riallineare: la sua prima lettura è il GET pigro di `ensureTaskTabsLoaded`.
 *
 *  Le chiavi con una scrittura in coda restano fuori (`applyRemote` le protegge
 *  già: l'edit locale non ancora flushato è più recente di qualsiasi valore
 *  remoto). Una chiave sparita dal server (task archiviato mentre eravamo
 *  offline) legge `null` e non cambia niente — identico a prima, quando la
 *  chiave semplicemente mancava dallo snapshot; a cancellarla è il `task:deleted`
 *  → `forgetTaskTabs`. */
export async function resyncTaskTabsFromServer(snapshot?: Record<string, unknown>): Promise<void> {
  const alreadyApplied = snapshot ? applyRemoteTaskTabsInit(snapshot) : new Set<string>();
  const ids = [...loaded].filter((id) => !alreadyApplied.has(id) && !writeTimers.has(keyFor(id)));
  if (!ids.length) return;
  const values = await Promise.all(ids.map((id) => uiGet<unknown>(keyFor(id))));
  let changed = false;
  ids.forEach((id, i) => { if (values[i] != null && applyRemote(id, values[i])) changed = true; });
  if (changed) notify();
}

/** Task-bound mutators. Each applies a pure reducer op and persists. */
export const taskBrowserTabs = {
  ensureLoaded: ensureTaskTabsLoaded,
  get: getTaskTabs,
  /** Append a new tab; returns the minted contextId so the caller can select it. */
  addTab: (taskId: string, url: string, title?: string): string => {
    const next = addTab(getTaskTabs(taskId), taskId, url, title);
    commit(taskId, next);
    return next.activeContextId!;
  },
  upsertTab: (taskId: string, contextId: string, url: string, title?: string, titleSource?: TaskTabTitleSource) => commit(taskId, upsertTab(getTaskTabs(taskId), contextId, url, title, titleSource)),
  /** Soft-close (park as preview). */
  closeTab: (taskId: string, contextId: string) => commit(taskId, closeTab(getTaskTabs(taskId), contextId)),
  /** Reopen a parked tab from the preview strip. */
  unparkTab: (taskId: string, contextId: string) => commit(taskId, unparkTab(getTaskTabs(taskId), contextId)),
  /** Hard-remove a tab (preview trash). Also RELEASES the server-side browser
   *  context: a hard-remove is a definitive "gone", so the Playwright/agent
   *  context that backed this task tab must be torn down — otherwise it leaked
   *  forever (removeTab only dropped the local record; even trashing never freed
   *  it). Soft-close/park deliberately does NOT do this (the tab is reopenable). */
  removeTab: (taskId: string, contextId: string) => {
    commit(taskId, removeTab(getTaskTabs(taskId), contextId));
    releaseBrowserContext(contextId);
  },
  setActive: (taskId: string, contextId: string | null) => commit(taskId, setActiveTab(getTaskTabs(taskId), contextId)),
  reorder: (taskId: string, from: number, to: number) => commit(taskId, reorderTabs(getTaskTabs(taskId), from, to)),
  updateTab: (taskId: string, contextId: string, patch: { url?: string; title?: string; titleSource?: TaskTabTitleSource }) => commit(taskId, updateTab(getTaskTabs(taskId), contextId, patch)),
};

export function subscribeTaskTabs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** React hook: the tabs for a task, hydrated lazily, re-rendering on change. */
export function useTaskBrowserTabs(taskId: string | null): TaskBrowserTabsState {
  useEffect(() => { if (taskId) void ensureTaskTabsLoaded(taskId); }, [taskId]);
  return useSyncExternalStore(
    subscribeTaskTabs,
    () => (taskId ? getTaskTabs(taskId) : EMPTY_TASK_TABS),
    () => EMPTY_TASK_TABS,
  );
}
