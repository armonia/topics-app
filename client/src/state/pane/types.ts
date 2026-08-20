import type { TerminalAgentType } from '../../../../shared/terminal-session-types';
// Pane types — the authoritative pane-type list and single source of truth.
//
// `PANE_TYPES` is the ONE runtime array; `PaneType` is DERIVED from it
// (`typeof PANE_TYPES[number]`), and the sanitizer's runtime whitelist
// `KNOWN_PANE_TYPES` (reducers/sanitizeSnapshot.ts) is a re-export of THIS same
// array — not a hand-copied mirror. So the class of bug where a type was added
// to the union but not to the whitelist, then silently dropped on every
// HYDRATE_FROM_SNAPSHOT round-trip, is now structurally impossible: adding a
// member here makes it both a valid `PaneType` AND persistable, in one edit.
// (That bug bit twice: review-round-12 B2 — `project`/`files`/`git`/`activity`/
// `agents`/`process-log`/`session-viewer` — and later `board`/`kanban`, the
// "Board generale" tab vanishing on reload. The old `satisfies readonly
// PaneType[]` guard never caught it: `satisfies` proves each element IS a
// PaneType, never that the list COVERS the union.)
//
// `client/src/types/index.ts` re-exports `PaneType` (and `PANE_TYPES`), so there
// is only one list.
export const PANE_TYPES = [
  // Used at runtime today (must include every legacy type)
  'chat',
  'file',
  'files',
  'browser',
  'git',
  'terminal',
  'plan',
  'dashboard',
  'kanban',
  'board',
  'project',
  'process-log',
  // Reserved for future panes — keep so code paths that opt in don't get
  // silently sanitized away the moment they land.
  'context',
  'editor',
  'cron',
  'profile',
  'remote-access',
  'system-status',
  'processes',
] as const;

export type PaneType = (typeof PANE_TYPES)[number];

export interface Pane {
  id: string;
  type: PaneType;
  /**
   * Stable identifier that survives PANE_ID_REMAP (draft → real topic
   * promotion). React tab list keys off this so the DOM element doesn't
   * unmount mid-flight when the pane id changes — without it the tab
   * visibly flashes as soon as the user submits the first message in a
   * draft chat. Set at pane creation and preserved by the remap reducer.
   * Falls back to `id` for legacy panes that predate this field.
   */
  stableKey?: string;
  /**
   * Display title. Optional because several legacy call sites (e.g.
   * ProjectWindow.buildDefaultGroups, hydration from openPanels) construct
   * panes without an explicit title — the consumer component falls back to
   * `pane.id` or `PANE_CONFIG[type].label`. sanitizePane (reducers/
   * sanitizeSnapshot.ts) coerces a missing title to an empty string so the
   * reducer never holds `undefined`.
   */
  title?: string;
  topicId?: string;
  projectPath?: string;
  filePath?: string;
  terminalSessionId?: string;
  /**
   * Browser pane's last-visited URL. The browser tab's restorable state — the
   * analogue of a chat pane's `topicId`. Persisted via the pane snapshot so the
   * tab reopens to its page after a window restart (instead of about:blank).
   * Updated (debounced) as the pane navigates; consumed as `initialUrl` on
   * mount. Whitelisted in sanitizePane.
   */
  url?: string;
  /**
   * Provenance of `title` for a browser pane — the browser analogue of a
   * terminal session's `name_source`. `'auto'` (or absent) = the title tracks
   * the live page title (persisted from the WKWebView poll); `'user'` = the
   * user renamed the tab, which pins the title so the poll no longer overwrites
   * it. `'agent'` sits in between: il NOME che l'agente ha prescritto alla tab
   * di un task (`open_browser_pane({url, name})`) — pinnato come `'user'` contro
   * il poll, ma sovrascrivibile da una rinomina a mano. Only set on browser
   * panes. MUST be whitelisted in sanitizePane (reducers/sanitizeSnapshot.ts)
   * or it's erased on every server round-trip.
   */
  titleSource?: 'auto' | 'agent' | 'user';
  // Legacy pane-shape fields — carried through sync so a round-trip through
  // the server doesn't silently erase tab metadata. Every field here must
  // also appear in sanitizePane's whitelist (reducers/sanitizeSnapshot.ts).
  diff?: boolean;
  diffProjectPath?: string;
  preview?: boolean;
  color?: string;
  processId?: string;
  sessionKey?: string;
  terminalType?: TerminalAgentType;
  /**
   * Spazio (workspace) membership. Absent ⟺ the default space
   * (DEFAULT_SPACE_ID) — old snapshots hydrate unchanged. SYNCED per-pane and
   * rides the UNION hydrate like every other Pane field, so it MUST be
   * whitelisted in sanitizePane (reducers/sanitizeSnapshot.ts) — a missing
   * whitelist entry silently erases membership on every server round-trip
   * (the review-round-12 B1/B2 failure class). Stamped centrally by the
   * OPEN_PANE reducer from `state.activeSpaceId`.
   */
  spaceId?: string;
  /**
   * ms-epoch of the pane's most recent closed→open transition (fresh
   * OPEN_PANE insert or UNDO_CLOSE restore; preserved across re-OPEN of an
   * already-open pane and PANE_ID_REMAP). SYNCED — it is the causal
   * counterpart of the durable `tombstones[id]` marker: on hydrate, a close
   * marker OLDER than the pane's openedAt is stale (the pane was re-opened
   * after that close, on a client whose tombstone retraction never reached
   * us) and is retracted instead of stripping the live pane. MUST be
   * whitelisted in sanitizePane (reducers/sanitizeSnapshot.ts) or every
   * server round-trip erases it and the stale marker silently wins again
   * (the stale-webapp-closes-topic-tabs bug). Absent on legacy panes → the
   * marker wins, exactly as before this field existed.
   */
  openedAt?: number;
  /**
   * Il `lastSeq` dello store nell'istante dell'apertura — cioè quanto lontano
   * questo client aveva visto lo stato condiviso quando ha aperto la pane.
   * `lastSeq` è tenuto al passo col `server_seq` del server
   * (`middleware/syncWS.ts`: `lastSeq: Math.max(currentSeq, server_seq)`),
   * quindi è una grandezza CAUSALE e non un orologio.
   *
   * È il sostituto di `openedAt` nel confronto con un marcatore di chiusura, e
   * la ragione per cui esiste sta in un guasto misurato il 2026-08-06: una pane
   * chiusa il 23/07 risultava ancora aperta su un telefono, perché il confronto
   * era fra `openedAt` (timbrato da chi APRE) e `closedAt` (timbrato da chi
   * CHIUDE), valutati su una TERZA macchina. Due orologi a muro di due
   * dispositivi diversi non ordinano niente. Peggio: la ritrattazione cancella
   * il marcatore, quindi la resurrezione si propagava all'indietro fino alla
   * macchina che aveva chiuso.
   *
   * Assente sulle pane precedenti a questo campo → il marcatore vince, che è la
   * direzione sicura (al massimo si richiude una pane davvero riaperta, e
   * l'utente la riapre; mai il contrario).
   */
  openedSeq?: number;
  // Device-local fields (never serialized to server snapshot):
  scrollOffset?: number;
}

/**
 * A Spazio (workspace): a named group of app-level tabs. The registry syncs
 * inside the pane snapshot and is merged PER-ID by `updatedAt` LWW on hydrate
 * (never wholesale-replaced — two devices creating different spaces inside the
 * debounce window must both survive). Deletion is a soft-delete tombstone IN
 * the record (`deleted: true` + newer updatedAt wins) so a cross-client delete
 * propagates without a new tombstone channel.
 */
export interface SpaceMeta {
  id: string;
  name: string;
  order: number;
  updatedAt: number;
  deleted?: true;
}

/** The implicit default space. Never stored in the registry (absent
 *  `pane.spaceId` ⟺ default) and never deletable — mirrors the
 *  `group:default` carve-out. */
export const DEFAULT_SPACE_ID = 'space:default';

/** Runaway backstop for the spaces registry (mirrors MAX_COLS_PER_ROW). */
export const SPACES_MAX = 32;

export interface Group {
  id: string;
  paneIds: string[];
  splitRatio: number; // 0..1, default 0.5
  splitAxis: 'horizontal' | 'vertical';
}

/**
 * Terminal metadata carried on a closed-tab record so `reopenClosedTab` can
 * recreate the server session. Single shared shape across the reducer's
 * ClosedPaneRecord and both adapter-level ClosedTabRecord interfaces — all
 * fields optional so records minted by different sites stay assignable.
 */
export interface ClosedTerminalMeta {
  sessionId?: string;
  cwd?: string;
  sessionType?: TerminalAgentType;
  name?: string;
  claudeSessionId?: string;
  skipPermissions?: boolean;
}

/**
 * Marcatore di chiusura durevole. Due grandezze, e servono a due cose diverse:
 *
 *   `at`  — orologio a muro della chiusura. Ordina il cap FIFO della mappa e
 *           dice all'utente «chiusa il…». **Non decide niente.**
 *   `seq` — il `lastSeq` dello store al momento della chiusura, cioè il punto
 *           della storia CONDIVISA in cui è avvenuta. È l'unica grandezza su
 *           cui si confronta, perché `lastSeq` è tenuto al passo col
 *           `server_seq` del server e quindi ordina fra dispositivi diversi.
 *           `0` = sconosciuto (marcatore legacy) → il marcatore vince.
 */
export interface TombstoneMark {
  at: number;
  seq: number;
}

/** Normalizza un marcatore letto dal filo o dal disco: la forma legacy è un
 *  numero nudo (solo l'orologio), e diventa `seq: 0` — cioè «decide il
 *  marcatore», che è la direzione sicura. */
export function toTombstoneMark(raw: unknown): TombstoneMark | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return { at: raw, seq: 0 };
  if (raw && typeof raw === 'object') {
    const o = raw as { at?: unknown; seq?: unknown };
    if (typeof o.at === 'number' && Number.isFinite(o.at)) {
      return { at: o.at, seq: typeof o.seq === 'number' && Number.isFinite(o.seq) ? o.seq : 0 };
    }
  }
  return null;
}

export interface ClosedPaneRecord {
  id: string;
  closedAt: number;
  pane: Pane;
  groupId: string;
  groupIndex: number;
  level: 'project' | 'app';
  projectPath?: string;
  terminal?: ClosedTerminalMeta;
  topicId?: string;
  filePath?: string;
  // Phase 30 new fields for PANE-03 fidelity:
  splitRatio?: number;
  splitAxis?: 'horizontal' | 'vertical';
  focusedAtClose: boolean;
  tabOrderSnapshot: string[];
  scrollOffset?: number;
  seq: number;
}

export interface PaneState {
  panes: Record<string, Pane>;
  groups: Record<string, Group>;
  closedStack: ClosedPaneRecord[]; // bounded at 50, FIFO
  /**
   * Durable close markers: paneId → closedAt (ms). SEPARATE from `closedStack`
   * on purpose. `closedStack` is the "recently closed" (⇧⌘T) UI list and is
   * FIFO-bounded at 50 — so after 50 further closes the oldest record (and its
   * tombstone) fell out, and a stale peer that still listed that durable
   * (browser/terminal/utility) pane could resurrect it on the next union
   * hydrate. Chats are immune (they carry the server-authoritative `archived`
   * flag), but durable panes had ONLY the closedStack tombstone. This map is
   * the tombstone the HYDRATE strip actually consults: unbounded-ish (capped at
   * TOMBSTONES_MAX, far above 50), merged per-id keeping the newest closedAt,
   * cleared on reopen (OPEN_PANE / UNDO_CLOSE / CLEAR_CLOSED_* / remap). SYNCED
   * inside the pane snapshot; a fresh id never carries a tombstone, so the wire
   * cost is just the ids the user actually closed.
   *
   * Il valore è un {@link TombstoneMark}, non più un numero nudo: `at` è
   * l'orologio (serve solo a ordinare il cap FIFO e a mostrare «chiusa il…»),
   * `seq` è la grandezza CAUSALE su cui si decide. Un marcatore letto in forma
   * legacy (numero) viene normalizzato con `seq: 0`, e `seq: 0` significa
   * «non so a che punto della storia condivisa è avvenuta questa chiusura» →
   * il marcatore vince. Vedi `Pane.openedSeq` per il guasto che ha portato qui.
   */
  tombstones: Record<string, TombstoneMark>;
  focusedPaneId: string | null; // DEVICE-LOCAL — never in server snapshot
  groupOrder: string[];
  /**
   * Spazi registry, keyed by space id. SYNCED inside the pane snapshot;
   * merged per-id LWW by `updatedAt` on HYDRATE (mergeSpaces in
   * reducers/spaces.ts), NEVER wholesale-replaced. The default space is
   * implicit and never appears here.
   */
  spaces: Record<string, SpaceMeta>;
  /**
   * The Spazio this window is currently showing. DEVICE-LOCAL, exactly the
   * focusedPaneId pattern: excluded from buildSnapshot outbound
   * (selectors.ts), stripped by sanitizeSnapshot inbound, persisted
   * synchronously to its own localStorage key (`pane-store-active-space`,
   * persistLocal.ts) and boot-read only — device A switching spaces must
   * never yank device B's view.
   */
  activeSpaceId: string;
  lastSeq: number;
  /**
   * Highest server-allocated LWW seq applied this session (0 = none yet).
   * SEPARATE counter from `lastSeq`: lastSeq is the LOCAL per-dispatch
   * counter and bumps on every action — including device-local ones like
   * FOCUS_PANE — so comparing it against an inbound frame's server_seq
   * silently dropped genuinely-newer remote state whenever local dispatch
   * activity outpaced server writes. The HYDRATE_FROM_SNAPSHOT LWW gate
   * compares server seq against THIS field only. Device-local; never in the
   * server-syncable snapshot (persistLocal persists it as `server_seq` for
   * the warm-boot hydrate).
   */
  lastServerSeq: number;
  /**
   * Quante volte QUESTO dispositivo ha cambiato lo stato. Terzo contatore, e
   * l'unico che risponde alla domanda del middleware di sync: «c'e' qualcosa di
   * NOSTRO da mandare?».
   *
   * PERCHE' NON BASTAVANO GLI ALTRI DUE. `lastSeq` sale anche su
   * `HYDRATE_FROM_SNAPSHOT`, perche' il reducer lo porta a
   * `max(lastSeq, clean.lastSeq)` per tenere fresche le PUT successive — e
   * `clean.lastSeq` viene da un `server_seq` che cresce con le scritture di
   * chiunque. Quindi il frame di un pari alzava il nostro contatore, il
   * middleware osservava il contatore e mezzo secondo dopo rimandava 75 KB
   * identici a quelli appena ricevuti; quel PUT alzava `server_seq`, il server
   * ritrasmetteva, e il pari faceva lo stesso. Misurato: **27 scritture in 30
   * secondi a schermo fermo**, e serve piu' di una finestra per vederlo (una
   * sola non gira, che e' il motivo per cui si e' nascosto cosi' a lungo).
   *
   * `lastServerSeq` non poteva servire: e' il numero d'ordine del SERVER, sale
   * quando qualcun altro scrive ed e' esattamente il segnale sbagliato.
   *
   * Due tentativi precedenti hanno provato a fermare l'INVIO — confrontare cio'
   * che si sta per mandare con l'ultimo stato ricevuto — e sono stati ritirati
   * entrambi: portavano il cancello a zero e rompevano la sincronizzazione
   * (`cross-window-topic-sync`, `pane-undo`). La differenza qui e' che non si
   * decide piu' COSA mandare guardando il corpo, si conta CHI ha cambiato: una
   * modifica locale alza questo numero, l'arrivo di uno stato altrui no.
   *
   * Device-local: non entra nello snapshot che va al server (e' un fatto di
   * questa finestra, non dello stato condiviso).
   */
  localSeq: number;
}

// Action discriminated union — every action the reducer accepts
export type PaneAction =
  | { type: 'OPEN_PANE'; payload: Pane & { groupId: string; insertIndex?: number } }
  | { type: 'CLOSE_PANE'; payload: { id: string; groupId: string; groupIndex: number } }
  | { type: 'UNDO_CLOSE' }
  | { type: 'FOCUS_PANE'; payload: { id: string | null } }
  | { type: 'SPLIT'; payload: { groupId: string; axis: 'horizontal' | 'vertical'; ratio: number } }
  | { type: 'RESIZE'; payload: { groupId: string; ratio: number } }
  | { type: 'REORDER_PANES'; payload: { groupId: string; paneIds: string[] } }
  | {
      type: 'HYDRATE_FROM_LEGACY';
      payload: {
        openPanels: string[];
        focusedPaneId: string | null;
        panelOrder: { order: string[]; pinned: string[] };
      };
    }
  | {
      type: 'HYDRATE_FROM_SNAPSHOT';
      payload: { snapshot: Partial<PaneState> & { seq: number; server_seq?: number } };
    }
  | { type: 'PANE_ID_REMAP'; payload: { from: string; to: string; updates?: Partial<Pane> } }
  /**
   * Merge a partial update into an existing pane (no-op if the id is unknown).
   * Used to persist a browser pane's `url` as it navigates so the tab restores
   * to its page after a restart. Bumps lastSeq via the dispatch wrapper → syncs.
   */
  | { type: 'UPDATE_PANE'; payload: { id: string; updates: Partial<Pane> } }
  | { type: 'CLEAR_CLOSED_RECORD'; payload: { id: string } }
  | { type: 'CLEAR_CLOSED_STACK' }
  /**
   * Push a caller-captured record onto the closedStack VERBATIM, without
   * requiring the pane/group to exist in this store. CLOSE_PANE can only
   * mint records for store-resident panes — project-inner panes/groups live
   * in useProjectLayout React state, so their closes must hand the reducer a
   * pre-built record or the close is silently lost (no ⌘K "recently closed",
   * dead ⌘⇧U). The reducer owns the seq assignment and the FIFO bound.
   */
  | { type: 'PUSH_CLOSED_RECORD'; payload: { record: ClosedPaneRecord } }
  /**
   * Surgically remove a pane from the store WITHOUT pushing it onto the
   * closedStack. Used by `usePanelLifecycle` Effect 7 when it detects an
   * orphan id (a topic with `project_path` set that was somehow opened as
   * a standalone pane). UNDO_CLOSE on a record like that would re-create
   * the orphan immediately and re-trigger Effect 7 → ping-pong.
   *
   * Differs from CLOSE_PANE on three points:
   *   1. No closedStack push (no undoable history for a corrupted state).
   *   2. Removes the pane id from EVERY group's paneIds (defensive — Effect 7
   *      can't always know which group hosts the orphan).
   *   3. No groupId/groupIndex required in payload (the caller usually
   *      doesn't have it for a state that was filtered out of the React view).
   *
   * Idempotent: if the id is unknown, the reducer is a no-op.
   */
  | { type: 'PURGE_ORPHAN_PANE'; payload: { id: string } }
  /**
   * Create / rename / reorder a Spazio. The reducer stamps
   * `updatedAt = Date.now()` (the per-id LWW key) — callers never set it.
   * Refuses DEFAULT_SPACE_ID (the default space is implicit, not a record).
   */
  | { type: 'SPACE_UPSERT'; payload: { space: { id: string; name?: string; order?: number } } }
  /**
   * Soft-delete a Spazio: sets `deleted: true` + a fresh updatedAt (the
   * tombstone-in-record that propagates the delete cross-client) and
   * reassigns member panes to the default space. Refuses DEFAULT_SPACE_ID.
   */
  | { type: 'SPACE_DELETE'; payload: { id: string } }
  /**
   * Switch this window's visible Spazio. DEVICE-LOCAL effect (activeSpaceId
   * never crosses the network) — a plain dispatch on the FOCUS_PANE
   * precedent: it bumps lastSeq (harmless debounced PUT whose synced content
   * is unchanged). Hands focus off to the first visible pane when the
   * currently-focused pane is not in the target space.
   */
  | { type: 'SET_ACTIVE_SPACE'; payload: { id: string } };

export const CLOSED_STACK_MAX = 50;

/**
 * Cap for the durable `tombstones` map. Far above CLOSED_STACK_MAX so a normal
 * session of closing durable tabs never evicts a still-relevant tombstone (the
 * FIFO-50 resurrection this map exists to prevent), while still bounding the
 * synced payload against an adversarial/runaway client. When exceeded we keep
 * the most-recently-closed ids (mirrors closedStack's keep-the-tail rule).
 */
export const TOMBSTONES_MAX = 500;
