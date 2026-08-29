/**
 * signals — the single source of truth for per-tab "loading" and "attention"
 * across every pane kind, plus the project rollup.
 *
 * This replaces the scatter of one-off stores (paneActivity, agentActivity,
 * streamingHydration, claudeAttention) and the ProjectWindow report-up. App
 * feeds the raw inputs in one place; consumers read derived state through the
 * facade hooks below. Every indicator (tab bar, sidebar row, project tab,
 * project row) reads the SAME facade, so they can't drift.
 *
 * Two concerns, one model:
 *   - loading   — "this pane is producing output / working right now"
 *   - attention — "this pane needs you" (notification count)
 *
 * Project rollup is computed CENTRALLY from the raw inputs + the global
 * topic/terminal maps (a topic belongs to a project via topic.projectPath; a
 * terminal via cwd prefix). It does NOT depend on the project window being
 * mounted — a background project still rolls up.
 *
 * Key derivation: pane identity fields (topicId / terminalSessionId /
 * projectPath) are derived from the pane id when the field is absent, so an
 * indicator is never silently gated by an unset field (the bug class that
 * plagued the per-type call sites).
 */
import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { isWindowAwake } from './windowAwake';
import type { Topic, TerminalSessionInfo, ClaudeSessionPhase, ClaudeSessionState, AttentionTier } from '../types';
import { useTopics, useTerminalSessions } from '../contexts/TopicsContext';

/** Claude phases that mean "Claude needs you" — worth a notification badge.
 *  Loading-ish phases (running / tool-running) surface as spinners instead.
 *
 *  `paused` is included: the reaper demotes awaiting-approval→paused after a
 *  10-minute timeout but DELIBERATELY keeps `pendingApproval` "so the UI can
 *  still display what was being asked" (claude-session-state.ts:301-307). If
 *  paused weren't notable, that un-answered question would silently vanish
 *  from the badge/dot the moment it timed out — the opposite of the intent. */
export const NOTABLE_CLAUDE_PHASES: ReadonlySet<ClaudeSessionPhase> = new Set<ClaudeSessionPhase>([
  'awaiting-approval',
  'awaiting-user',
  'paused',
  'error',
]);

/** Phases that mean "Claude STOPPED and is waiting for YOU" — the subset of
 *  NOTABLE that warrants a blue "awaiting feedback" tab/row highlight.
 *
 *  It is NOTABLE minus `error`: an errored session is a failure, not a chat
 *  parked for your input, so it keeps the (red-ish) badge but never goes blue.
 *  `paused` stays in (a timed-out approval whose question is still on screen —
 *  see NOTABLE_CLAUDE_PHASES). Loading phases (running / tool-running) are the
 *  opposite axis and, being mutually exclusive with these in time, never show a
 *  blue fill and a spinner at once. */
export const AWAITING_FEEDBACK_PHASES: ReadonlySet<ClaudeSessionPhase> = new Set<ClaudeSessionPhase>([
  'awaiting-user',
  'awaiting-approval',
  'paused',
]);

/** The LOUD subset of AWAITING_FEEDBACK_PHASES: Claude is blocked on a permission
 *  and needs an answer NOW (the amber "act now" tier). Strictly `awaiting-approval`
 *  — a mid-task gate — as opposed to `awaiting-user`/`paused`, which mean the turn
 *  simply finished (the calm blue "done, look when ready" tier). Splitting the two
 *  is the fix for "one blue does two jobs → everything looks equally urgent". */
export const AWAITING_INPUT_PHASES: ReadonlySet<ClaudeSessionPhase> = new Set<ClaudeSessionPhase>([
  'awaiting-approval',
]);

/** Map a phase to its attention TIER, or null if it isn't a "needs you" phase.
 *  `awaiting-approval` → 'input' (loud amber); `awaiting-user`/`paused` → 'done'
 *  (calm blue). The ONE definition every surface reads, so the tier→colour choice
 *  can never drift between the tab bar, the sidebar and the project rollup. */
export function attentionTierForPhase(phase: ClaudeSessionPhase): AttentionTier | null {
  if (AWAITING_INPUT_PHASES.has(phase)) return 'input';
  if (AWAITING_FEEDBACK_PHASES.has(phase)) return 'done';
  return null;
}

// ─── "Visto": la soglia fra SELEZIONARE e GUARDARE ────────────────────────────
//
// `sidebarRowCard` ha sempre applicato FOCUS WINS — la riga che stai guardando
// torna neutra e non lampeggia — e la ragione è giusta: non vuoi che ti pulsi in
// faccia ciò che stai già leggendo. Il problema era la definizione di "stai
// guardando": bastava che la riga fosse selezionata, per un istante. Un clic di
// passaggio per cercare un'altra cosa spegneva il fill di una chat che non era
// stata letta, e lo stesso istante azzerava l'unread (useWebSocket, ramo 'focus').
//
// Qui "visto" vuol dire: la tab è stata DAVANTI, con la finestra sveglia, per
// SEEN_DWELL_MS continui. La finestra sveglia conta perché una tab selezionata in
// una finestra che nessuno guarda non è stata vista — è lo stesso predicato di
// `isWindowAwake()`, tenuto in passo di proposito.

/**
 * Quanto una tab deve restare davanti perché conti come vista.
 *
 * 1200 ms: sopra il tempo di un clic di passaggio (un utente che cerca un'altra
 * tab ci resta 200-400 ms) e sotto la soglia in cui l'attesa si nota come
 * ritardo. Non è una costante da girare a piacere: abbassarla sotto ~600 ms
 * riporta il comportamento di prima, alzarla oltre ~2 s fa sembrare che il fill
 * non cada mai.
 */
export const SEEN_DWELL_MS = 1200;

/**
 * Politica pura: una tab è "vista" solo se è stata davanti per almeno `dwellMs`
 * CONTINUI. `focusedSince` è l'istante in cui è diventata davanti-e-sveglia, o
 * `null` se in questo momento non lo è (blur, finestra addormentata, altra tab).
 */
export function isSeen(focusedSince: number | null, now: number, dwellMs = SEEN_DWELL_MS): boolean {
  if (focusedSince === null) return false;
  return now - focusedSince >= dwellMs;
}

/**
 * Politica pura: il "visto" si ANNULLA quando arriva un nuovo "tocca a te".
 *
 * Senza questo, una tab vista una volta non tornerebbe mai più blu: il turno
 * successivo finirebbe in silenzio. La regola è sul FRONTE di salita — un id che
 * entra ora nell'insieme awaiting perde il suo "visto" — e non sulla presenza,
 * perché un id che RESTA awaiting mentre lo stai leggendo deve restare visto.
 *
 * Torna lo STESSO riferimento quando non cambia niente: è il contratto
 * anti-render che tutto questo store rispetta (vedi `setsEqual`/`withToggled`).
 */
export function resetSeenOnNewAttention(
  prevSeen: ReadonlySet<string>,
  prevAwaiting: ReadonlySet<string>,
  nextAwaiting: ReadonlySet<string>,
): ReadonlySet<string> {
  let next: Set<string> | null = null;
  for (const id of nextAwaiting) {
    // Fronte di salita: non c'era e ora c'è ⇒ è un nuovo "tocca a te".
    if (prevAwaiting.has(id)) continue;
    if (!prevSeen.has(id)) continue;
    if (next === null) next = new Set(prevSeen);
    next.delete(id);
  }
  return next ?? prevSeen;
}

/**
 * Il fill di attenzione da applicare a una superficie, in UN posto.
 *
 * FOCUS WINS era ricopiato in QUATTRO punti indipendenti (sidebarRowCard,
 * PaneTabBar, la riga di progetto in TopicTree, SpaceSwitcher), ognuno con la
 * sua definizione di "focused" e nessun helper condiviso: aggiungere una quinta
 * superficie voleva dire ricopiarlo di nuovo, e dimenticarselo voleva dire far
 * pulsare in faccia all'utente la cosa che sta guardando. Ora la regola sta qui:
 * il tier si mostra se c'è, a meno che quella superficie non sia stata VISTA.
 *
 * Nota la differenza con prima: il gate è `seen`, non `focused`. Una tab appena
 * selezionata è focused ma non ancora vista, quindi tiene il suo fill finché la
 * soglia non scatta — che è esattamente ciò che "resta blu finché non la
 * visualizzi" chiede.
 */
export function attentionFillFor(
  tier: AttentionTier | null | undefined,
  seen: boolean,
): AttentionTier | null {
  if (!tier) return null;
  return seen ? null : tier;
}

/** Pure: topic ids whose bound Claude session is parked awaiting human input.
 *  Mirror of the `claudeAttentionTopics` derivation but keyed on
 *  AWAITING_FEEDBACK_PHASES. Extracted (and unit-tested) so the blue-tab signal
 *  is provable without standing up the store / WS. */
export function deriveAwaitingFeedbackTopics(
  topics: Record<string, Topic>,
  claudeSessions: ReadonlyMap<string, ClaudeSessionState>,
): Set<string> {
  const ids = new Set<string>();
  for (const t of Object.values(topics)) {
    const st = t.sessionKey ? claudeSessions.get(t.sessionKey) : undefined;
    if (st && AWAITING_FEEDBACK_PHASES.has(st.phase)) ids.add(t.id);
  }
  return ids;
}

/** Pure: topic ids whose bound Claude session is specifically awaiting a
 *  permission answer (the amber 'input' tier) — a strict subset of
 *  deriveAwaitingFeedbackTopics. Kept separate so the UI can pick amber vs blue
 *  while the union set still drives the tier-agnostic counts/rollups. */
export function deriveAwaitingInputTopics(
  topics: Record<string, Topic>,
  claudeSessions: ReadonlyMap<string, ClaudeSessionState>,
): Set<string> {
  const ids = new Set<string>();
  for (const t of Object.values(topics)) {
    const st = t.sessionKey ? claudeSessions.get(t.sessionKey) : undefined;
    if (st && AWAITING_INPUT_PHASES.has(st.phase)) ids.add(t.id);
  }
  return ids;
}

/** Phases that mean "Claude is actively working".
 *
 *  The loading rule is a UNION, so it stays correct even where Claude Code
 *  hooks don't fire reliably (the phase machine then simply stays idle and
 *  contributes nothing):
 *    loading = ptyBusy OR phase is running/tool-running/watching
 *  - ptyBusy (cosmetic-filtered, so the colour-only `/goal` statusline pulse
 *    doesn't count) is the always-available "something is happening" signal.
 *  - phase running/tool-running adds coverage when hooks DO fire (e.g. a quiet
 *    tool call that produces no pty output for a while).
 *  - phase watching means a Monitor/background-task is armed, waiting for an event.
 *  Crucially, an absent/stale phase never HIDES real pty activity — that was the
 *  flaw of the earlier suppression model when hooks were silent. */
export const ACTIVE_CLAUDE_PHASES: ReadonlySet<ClaudeSessionPhase> = new Set<ClaudeSessionPhase>([
  'running',
  'tool-running',
  'watching',
]);

/** Phases where the session is CONFIDENTLY idle, so the pty heuristic is
 *  suppressed (a TUI repaint or an awaiting-input prompt must not raise the
 *  spinner — those phases show a notification badge instead, never a spinner).
 *
 *  Deliberately EXCLUDES `starting`. `starting` is the INITIAL, not-yet-confirmed
 *  phase: a session can sit there while genuinely working when its phase hooks
 *  never advanced it (bare-CLI / tmux sessions Topics only monitors, or a
 *  session whose first hook was missed). Treating `starting` as resting hid the
 *  loading spinner for real work — the "sessions are loading but no spinner in
 *  the tabs" bug. So `starting` (and any unknown phase) falls through to the pty
 *  heuristic, exactly like a session with no phase entry yet. The cost is a brief
 *  spinner while a freshly-opened session paints its startup banner — an
 *  acceptable trade vs. silently hiding active work. */
export const RESTING_CLAUDE_PHASES: ReadonlySet<ClaudeSessionPhase> = new Set<ClaudeSessionPhase>([
  'awaiting-user',
  'awaiting-approval',
  'paused',
  'completed',
  'error',
  'dormant',
]);

// ---- Store -----------------------------------------------------------------

interface SignalsState {
  // loading inputs
  liveStreamTopics: Set<string>;     // useChat live stream (sessionKey resolved to topicId)
  hydratedStreamTopics: Set<string>; // server "mid-reply" (DB partial flag), survives reload
  terminalBusyIds: Set<string>;      // server-tracked pty busy, by session id (fallback heuristic)
  browserBusyPaneIds: Set<string>;   // browser panel loading/agent, by pane id
  // claude-code terminals whose known phase is active (running/tool-running).
  // Drives loading directly (a quiet tool call still shows a spinner when hooks
  // fire). By terminal session id. See ACTIVE_CLAUDE_PHASES for the rationale.
  claudePhaseActiveTermIds: Set<string>;
  // claude-code terminals whose phase is KNOWN but NOT active (starting,
  // awaiting-user, paused, completed, dormant, error, …). For these the phase
  // is authoritative: the session is NOT working, so pty output (the TUI's
  // startup banner/prompt paint, an idle redraw) must NOT raise the spinner —
  // otherwise opening a fresh Claude Code session flashes "loading" for no
  // reason. pty still drives plain shells and any session with no phase yet.
  claudePhaseRestingTermIds: Set<string>;
  // claude-code terminals whose phase is specifically awaiting the user
  // (awaiting-user/-approval/paused) — subset of resting. Drives the "awaiting
  // feedback" fill on terminal tabs/rows, the terminal twin of
  // awaitingFeedbackTopics. By terminal session id.
  claudePhaseAwaitingTermIds: Set<string>;
  // claude-code terminals in the LOUD 'input' tier (awaiting-approval only) —
  // a strict subset of claudePhaseAwaitingTermIds. Amber fill (act now); the
  // rest of the awaiting set is calm blue (done-unseen). By terminal session id.
  claudePhaseAwaitingInputTermIds: Set<string>;
  // attention inputs
  claudeAttentionTopics: Set<string>;   // chat Claude awaiting-*/error
  // chat Claude parked awaiting human input (awaiting-user/-approval/paused) —
  // the subset that drives the "awaiting feedback" tab/row fill. Separate
  // from claudeAttentionTopics because `error` belongs to the badge, not the fill.
  awaitingFeedbackTopics: Set<string>;
  // chat topics in the LOUD 'input' tier (awaiting-approval) — subset of
  // awaitingFeedbackTopics. Amber fill; the rest is calm blue done-unseen.
  awaitingInputTopics: Set<string>;
  // The set the rising edge of `seenSubjects` is measured against: EVERY chat
  // subject that is currently asking for you, blue 'done' and amber 'input'
  // alike (an in-app ask_user_question lives only in awaitingInputTopics).
  // It has to be its own field. Reusing awaitingFeedbackTopics for both jobs
  // is what broke this: a topic held by an open question never entered that
  // set, so every pass looked like a fresh rising edge and wiped the "seen"
  // flag forever, and the amber could never be dismissed. Written only by
  // applyNewAttention, which is also its only reader.
  attentionEdgeTopics: ReadonlySet<string>;
  // Soggetti (topicId o terminalSessionId) che l'utente ha DAVVERO guardato: sono
  // stati davanti, con la finestra sveglia, per SEEN_DWELL_MS continui. È il gate
  // di FOCUS WINS — vedi `attentionFillFor` — e sostituisce "è selezionata", che
  // spegneva il fill al primo clic di passaggio. Si annulla per un soggetto
  // quando arriva un nuovo "tocca a te" (`resetSeenOnNewAttention`).
  seenSubjects: ReadonlySet<string>;
  terminalFinishedIds: Set<string>;     // claude-code finished a turn, until the user looks
  terminalReloadingIds: Set<string>;    // a terminal is restarting (Ricarica), until it reconnects
  // "What is this session doing right now" — a compact descriptor keyed by
  // SUBJECT id (topicId for chats, terminalSessionId for terminals; the two id
  // spaces are disjoint so one map is unambiguous). Drives the SessionActivity
  // label on sidebar rows and the mobile activity view. Derived centrally from
  // the claude session states + roster (see deriveSessionActivity).
  sessionActivity: Map<string, SessionActivitySignal>;
  // Unfiltered twin of sessionActivity: last-touched timestamp for EVERY
  // session with known Claude state (idle/completed/dormant/error included),
  // keyed the same way. Drives sidebar ORDERING and the "agg. Xm fa" label —
  // sessionActivity can't serve that because it drops idle/finished sessions
  // entirely (see deriveSessionLastActivity).
  sessionLastActivity: Map<string, number>;

  setTopicSet: (key: TopicSetKey, ids: Set<string>) => void;
  /** Segna un soggetto come VISTO (la soglia è scattata). Idempotente. */
  markSubjectSeen: (id: string) => void;
  /** Clears the "seen" flag of the chat subjects that ENTER the attention set
   *  now. Takes the full set that wants you (awaiting-feedback plus the topics
   *  parked on an open question) and keeps its own previous value in
   *  `attentionEdgeTopics`, so no call order can lose the edge. */
  applyNewAttention: (nextAttention: ReadonlySet<string>) => void;
  setBrowserBusy: (paneId: string, busy: boolean) => void;
  setTerminalBusy: (id: string, busy: boolean) => void;
  markTerminalFinished: (id: string) => void;
  clearTerminalFinished: (id: string) => void;
  markTerminalReloading: (id: string) => void;
  clearTerminalReloading: (id: string) => void;
  reconcileTerminals: (roster: TerminalRosterEntry[]) => void;
  setClaudePhaseTerminals: (active: Set<string>, resting: Set<string>, awaiting: Set<string>, awaitingInput: Set<string>) => void;
  setSessionActivity: (activity: Map<string, SessionActivitySignal>) => void;
  setSessionLastActivity: (activity: Map<string, number>) => void;
}

/**
 * Compact "what is this session doing" descriptor — the display half of a
 * ClaudeSessionState, flattened to exactly what an activity label renders so the
 * label component never has to reach into the full session map. `since` powers a
 * live elapsed timer. Pure data; one per subject (topic/terminal).
 */
export interface SessionActivitySignal {
  phase: ClaudeSessionPhase;
  /** null = neither working nor awaiting (idle/error handled by badge). */
  tier: AttentionTier | null;
  /** running / tool-running — Claude is producing work right now. */
  working: boolean;
  /** The tool Claude is currently running (from lastTool), when working. */
  tool?: string;
  /** The pending approval kind (plan/edit/bash/other), when tier === 'input'. */
  approvalKind?: string;
  /** Timestamp the current phase/tool started — for the elapsed counter. */
  since: number;
  /**
   * Quando è cominciato il TURNO (non l'azione dentro il turno): epoch-ms del
   * fronte di salita verso una fase di lavoro, dal server (`turnStartedAt`).
   * Assente per un turno cominciato prima dell'ultimo riavvio del server — il
   * campo non è persistito apposta — e allora `since` resta l'unica base.
   *
   * `since` e questo rispondono a due domande diverse e la UI le mostra in due
   * posti diversi: `since` è «da quanto dura QUESTA azione» (il tool corrente),
   * questo è «da quanto va avanti il turno». Confonderli è come cronometrare una
   * maratona ripartendo da zero a ogni ristoro.
   */
  turnSince?: number;
}

/** Minimal shape the reconciler reads from the server session roster. */
export interface TerminalRosterEntry {
  id: string;
  busy?: boolean;
}

type TopicSetKey = 'liveStreamTopics' | 'hydratedStreamTopics' | 'claudeAttentionTopics' | 'awaitingFeedbackTopics' | 'awaitingInputTopics';

export function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function withToggled(prev: Set<string>, id: string, present: boolean): Set<string> | null {
  if (present === prev.has(id)) return null; // no change
  const next = new Set(prev);
  if (present) next.add(id); else next.delete(id);
  return next;
}

/**
 * Reconcile the busy/finished sets against an authoritative session roster.
 *
 * The server roster is the single source of truth for which pty sessions exist
 * and which are busy *right now*. Incremental `terminal:activity` deltas can be
 * lost (server restart wipes the in-memory activity map, WS reconnect, a
 * dropped message) — leaving a session stuck "in progress". Re-deriving from
 * the roster whenever it arrives makes the loading state self-healing:
 *   - busy     = full sync to the roster (a session not reported busy is idle).
 *   - finished = prune-only (drop ids whose session is gone; a completed-turn
 *                badge must otherwise survive roster broadcasts until the user
 *                looks, so we never clear it just because busy went false).
 *
 * Pure: returns the SAME set references when nothing changed so the store can
 * skip the update and avoid spurious re-renders.
 */
export function reconcileTerminalSignals(
  prevBusy: Set<string>,
  prevFinished: Set<string>,
  roster: TerminalRosterEntry[],
): { busy: Set<string>; finished: Set<string> } {
  const rosterIds = new Set<string>();
  const nextBusy = new Set<string>();
  for (const s of roster) {
    rosterIds.add(s.id);
    if (s.busy) nextBusy.add(s.id);
  }
  const nextFinished = new Set<string>();
  for (const id of prevFinished) if (rosterIds.has(id)) nextFinished.add(id);
  return {
    busy: setsEqual(nextBusy, prevBusy) ? prevBusy : nextBusy,
    finished: setsEqual(nextFinished, prevFinished) ? prevFinished : nextFinished,
  };
}

/**
 * Decide which locally-"streaming" chat sessions are ORPHANS — the client still
 * shows a chat mid-reply but the server's authoritative streaming registry
 * (GET /api/topics/streaming, backed by the in-memory activeStreams map) has not
 * listed it for `threshold` consecutive polls.
 *
 * This is the self-heal for a MISSED `stream:end`. The WS can drop between
 * `stream:start` and `stream:end` (server churn / a sleeping laptop): the server
 * finalises the message and clears its registry, but the terminal event never
 * reaches the client, so useChat's `streaming[sessionKey]` stays `true` and the
 * spinner never stops (the 3-min watchdog only helps if it was armed, and a
 * reload was the only sure cure). The 15s poll already fetches server truth;
 * this turns it into a reconciler so an orphaned flag clears in ≤2 poll cycles.
 *
 * Guards against false clears:
 *  - `inFlightLocalSends` — a session whose own SSE response is still being read
 *    locally is authoritative by itself (its `sendMessage` finally clears it);
 *    never touch it, even if the server registry momentarily lacks it (the brief
 *    window after send before `startStream` registers the entry).
 *  - `threshold` consecutive misses — right after send the client optimistically
 *    streams before the server registers; a REAL stream re-appears within one
 *    poll, so requiring N≥2 misses means only a genuinely dead flag accumulates
 *    enough to be cleared. A session that re-appears, goes in-flight, or stops
 *    streaming resets to 0 (by omission from the returned map).
 *
 * Pure: returns the sessionKeys to clear + the next miss-count map.
 */
export function reconcileOrphanStreams(
  localStreamingSessionKeys: Iterable<string>,
  serverStreamingSessionKeys: Set<string>,
  inFlightLocalSends: Set<string>,
  prevMiss: Map<string, number>,
  threshold = 2,
): { orphans: string[]; nextMiss: Map<string, number> } {
  const nextMiss = new Map<string, number>();
  const orphans: string[] = [];
  for (const sk of localStreamingSessionKeys) {
    if (inFlightLocalSends.has(sk)) continue;         // own in-flight SSE → leave it
    if (serverStreamingSessionKeys.has(sk)) continue; // server agrees it's live → reset
    const n = (prevMiss.get(sk) ?? 0) + 1;
    if (n >= threshold) orphans.push(sk);             // dead for ≥threshold polls → clear
    else nextMiss.set(sk, n);                         // not yet — carry the count forward
  }
  return { orphans, nextMiss };
}

export const useSignalsStore = create<SignalsState>((set) => ({
  liveStreamTopics: new Set(),
  hydratedStreamTopics: new Set(),
  terminalBusyIds: new Set(),
  browserBusyPaneIds: new Set(),
  claudePhaseActiveTermIds: new Set(),
  claudePhaseRestingTermIds: new Set(),
  claudePhaseAwaitingTermIds: new Set(),
  claudePhaseAwaitingInputTermIds: new Set(),
  claudeAttentionTopics: new Set(),
  awaitingFeedbackTopics: new Set(),
  awaitingInputTopics: new Set(),
  attentionEdgeTopics: new Set(),
  seenSubjects: new Set(),
  terminalFinishedIds: new Set(),
  terminalReloadingIds: new Set(),
  sessionActivity: new Map(),
  sessionLastActivity: new Map(),

  setTopicSet: (key, ids) =>
    set((s) => (setsEqual(ids, s[key]) ? s : ({ [key]: ids } as Pick<SignalsState, TopicSetKey>))),

  // "Visto" — due sole mosse, entrambe con bail-out sull'identità perché questo
  // set è letto da OGNI riga e OGNI tab.
  markSubjectSeen: (id: string) =>
    set((s) => (s.seenSubjects.has(id) ? s : { seenSubjects: new Set(s.seenSubjects).add(id) })),
  // Applies the rising edge of the chat attention set. The set it compares
  // against is the one IT stored last time (attentionEdgeTopics), never one of
  // the tier sets: those are rewritten for their own reasons and a subject
  // missing from them would read as a new edge on every single pass.
  applyNewAttention: (nextAttention: ReadonlySet<string>) =>
    set((s) => {
      const seenSubjects = resetSeenOnNewAttention(s.seenSubjects, s.attentionEdgeTopics, nextAttention);
      const edgeChanged = !setsEqual(s.attentionEdgeTopics, nextAttention);
      if (!edgeChanged && seenSubjects === s.seenSubjects) return s;
      return {
        ...(edgeChanged ? { attentionEdgeTopics: nextAttention } : {}),
        ...(seenSubjects === s.seenSubjects ? {} : { seenSubjects }),
      };
    }),

  setBrowserBusy: (paneId, busy) =>
    set((s) => {
      const next = withToggled(s.browserBusyPaneIds, paneId, busy);
      return next ? { browserBusyPaneIds: next } : s;
    }),

  setTerminalBusy: (id, busy) =>
    set((s) => {
      const next = withToggled(s.terminalBusyIds, id, busy);
      return next ? { terminalBusyIds: next } : s;
    }),

  markTerminalFinished: (id) =>
    set((s) => {
      const next = withToggled(s.terminalFinishedIds, id, true);
      return next ? { terminalFinishedIds: next } : s;
    }),

  clearTerminalFinished: (id) =>
    set((s) => {
      const next = withToggled(s.terminalFinishedIds, id, false);
      return next ? { terminalFinishedIds: next } : s;
    }),

  markTerminalReloading: (id) =>
    set((s) => {
      const next = withToggled(s.terminalReloadingIds, id, true);
      return next ? { terminalReloadingIds: next } : s;
    }),

  clearTerminalReloading: (id) =>
    set((s) => {
      const next = withToggled(s.terminalReloadingIds, id, false);
      return next ? { terminalReloadingIds: next } : s;
    }),

  reconcileTerminals: (roster) =>
    set((s) => {
      const { busy, finished } = reconcileTerminalSignals(s.terminalBusyIds, s.terminalFinishedIds, roster);
      if (busy === s.terminalBusyIds && finished === s.terminalFinishedIds) return s;
      return { terminalBusyIds: busy, terminalFinishedIds: finished };
    }),

  setClaudePhaseTerminals: (active, resting, awaiting, awaitingInput) =>
    set((s) => {
      const activeChanged = !setsEqual(active, s.claudePhaseActiveTermIds);
      const restingChanged = !setsEqual(resting, s.claudePhaseRestingTermIds);
      const awaitingChanged = !setsEqual(awaiting, s.claudePhaseAwaitingTermIds);
      const awaitingInputChanged = !setsEqual(awaitingInput, s.claudePhaseAwaitingInputTermIds);
      if (!activeChanged && !restingChanged && !awaitingChanged && !awaitingInputChanged) return s;
      // Il "visto" dei TERMINALI si annulla qui, sul fronte di salita, esattamente
      // come quello delle chat in `applyNewAttention`. Per le chat è una chiamata
      // separata da fare PRIMA della sostituzione (col suo avvertimento
      // sull'ordine); qui sta dentro l'aggiornamento che HA già il precedente,
      // quindi l'ordine non si può sbagliare.
      //
      // Senza, un terminale claude-code guardato una volta restava "visto" per
      // sempre: `seenSubjects` non lo toglieva più nessuno, e la sua tab non
      // tornava blu al secondo turno finito. Lo stesso silenzio si propagava al
      // progetto, che ora salta i figli visti.
      const seenSubjects = awaitingChanged
        ? resetSeenOnNewAttention(s.seenSubjects, s.claudePhaseAwaitingTermIds, awaiting)
        : s.seenSubjects;
      return {
        ...(activeChanged ? { claudePhaseActiveTermIds: active } : {}),
        ...(restingChanged ? { claudePhaseRestingTermIds: resting } : {}),
        ...(awaitingChanged ? { claudePhaseAwaitingTermIds: awaiting } : {}),
        ...(awaitingInputChanged ? { claudePhaseAwaitingInputTermIds: awaitingInput } : {}),
        ...(seenSubjects === s.seenSubjects ? {} : { seenSubjects }),
      };
    }),

  setSessionActivity: (activity) =>
    set((s) => (sessionActivityEqual(s.sessionActivity, activity) ? s : { sessionActivity: activity })),

  setSessionLastActivity: (activity) =>
    set((s) => (sessionLastActivityEqual(s.sessionLastActivity, activity) ? s : { sessionLastActivity: activity })),
}));

/** Shallow structural equality for the sessionActivity map — same keys and each
 *  descriptor field-equal — so an identical re-derivation skips the store update
 *  (no spurious re-render of every activity label). */
function sessionActivityEqual(a: Map<string, SessionActivitySignal>, b: Map<string, SessionActivitySignal>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, va] of a) {
    const vb = b.get(k);
    if (!vb) return false;
    if (va.phase !== vb.phase || va.tier !== vb.tier || va.working !== vb.working
      || va.tool !== vb.tool || va.approvalKind !== vb.approvalKind || va.since !== vb.since) return false;
  }
  return true;
}

/** Shallow structural equality for the sessionLastActivity map. */
function sessionLastActivityEqual(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, va] of a) {
    if (b.get(k) !== va) return false;
  }
  return true;
}

// ---- Raw setters for App-level sync (stable references) ---------------------

export const signalsActions = {
  setLiveStreamTopics: (ids: Set<string>) => useSignalsStore.getState().setTopicSet('liveStreamTopics', ids),
  setHydratedStreamTopics: (ids: Set<string>) => useSignalsStore.getState().setTopicSet('hydratedStreamTopics', ids),
  setClaudeAttentionTopics: (ids: Set<string>) => useSignalsStore.getState().setTopicSet('claudeAttentionTopics', ids),
  setAwaitingFeedbackTopics: (ids: Set<string>) => useSignalsStore.getState().setTopicSet('awaitingFeedbackTopics', ids),
  setAwaitingInputTopics: (ids: Set<string>) => useSignalsStore.getState().setTopicSet('awaitingInputTopics', ids),
  applyNewAttention: (nextAttention: ReadonlySet<string>) => useSignalsStore.getState().applyNewAttention(nextAttention),
  markSubjectSeen: (id: string) => useSignalsStore.getState().markSubjectSeen(id),
  setSessionActivity: (activity: Map<string, SessionActivitySignal>) => useSignalsStore.getState().setSessionActivity(activity),
  setSessionLastActivity: (activity: Map<string, number>) => useSignalsStore.getState().setSessionLastActivity(activity),
  setBrowserBusy: (paneId: string, busy: boolean) => useSignalsStore.getState().setBrowserBusy(paneId, busy),
  setTerminalBusy: (id: string, busy: boolean) => useSignalsStore.getState().setTerminalBusy(id, busy),
  markTerminalFinished: (id: string) => useSignalsStore.getState().markTerminalFinished(id),
  clearTerminalFinished: (id: string) => useSignalsStore.getState().clearTerminalFinished(id),
  markTerminalReloading: (id: string) => useSignalsStore.getState().markTerminalReloading(id),
  clearTerminalReloading: (id: string) => useSignalsStore.getState().clearTerminalReloading(id),
  reconcileTerminals: (roster: TerminalRosterEntry[]) => useSignalsStore.getState().reconcileTerminals(roster),
  setClaudePhaseTerminals: (active: Set<string>, resting: Set<string>, awaiting: Set<string>, awaitingInput: Set<string>) => useSignalsStore.getState().setClaudePhaseTerminals(active, resting, awaiting, awaitingInput),
};

/**
 * Resolve a terminal session's loading state.
 *
 *   loading = phaseActive  OR  (ptyBusy AND NOT phaseResting)
 *
 * The phase is authoritative WHEN KNOWN: a claude-code session sitting at a
 * resting phase (starting / awaiting-user / paused / completed / dormant /
 * error) is NOT working, so its pty output — the TUI's startup banner+prompt
 * paint when you first open it, or an idle redraw — must not raise the spinner.
 * That startup paint is exactly what made a freshly-opened Claude Code session
 * flash "loading" for a second or two even though Claude was idle.
 *
 * pty remains the signal for everything WITHOUT a resting phase: plain shells,
 * and claude-code sessions whose phase isn't known yet (the brief window before
 * the first session:state arrives) — so real work is never hidden when hooks
 * are silent. An active phase always wins, so a quiet tool call still spins.
 */
export function terminalLoadingFrom(
  sid: string,
  phaseActive: Set<string>,
  ptyBusy: Set<string>,
  phaseResting?: Set<string>,
): boolean {
  if (phaseActive.has(sid)) return true;
  if (phaseResting?.has(sid)) return false;
  return ptyBusy.has(sid);
}

/** Minimal phase view the terminal-loading derivation needs. */
export interface TerminalPhaseLite {
  phase: ClaudeSessionPhase;
}
/** Minimal roster entry the derivation reads. */
export interface TerminalRosterTypeEntry {
  id: string;
  type: string;
  claudeSessionId?: string | null;
}

/**
 * Partition claude-code terminal sessions by phase, for terminalLoadingFrom:
 *   - active:  phase ∈ {running, tool-running, watching} → drives the spinner/ring.
 *   - resting: phase ∈ RESTING_CLAUDE_PHASES (confidently idle) → suppresses the
 *              pty heuristic (the session isn't working; pty is idle paint).
 * A claude-code session with no phase entry yet — OR one still at `starting` —
 * appears in NEITHER set, so pty drives it (union fallback). That keeps the
 * spinner honest for sessions that work while pinned at `starting` (hooks never
 * advanced them). Plain shells never appear here at all.
 */
export function derivePhaseTerminals(
  roster: TerminalRosterTypeEntry[],
  byCsid: Map<string, TerminalPhaseLite>,
): { active: Set<string>; resting: Set<string>; awaiting: Set<string>; awaitingInput: Set<string> } {
  const active = new Set<string>();
  const resting = new Set<string>();
  // `awaiting` is a SUBSET of `resting` (AWAITING_FEEDBACK_PHASES ⊂
  // RESTING_CLAUDE_PHASES): the session is idle (no spinner) AND specifically
  // parked waiting for the user → drives the terminal-tab/row fill.
  const awaiting = new Set<string>();
  // `awaitingInput` ⊂ `awaiting`: the LOUD amber tier (awaiting-approval only).
  const awaitingInput = new Set<string>();
  for (const ts of roster) {
    if (ts.type !== 'claude-code' && ts.type !== 'claude-code-team') continue;
    if (!ts.claudeSessionId) continue;
    const st = byCsid.get(ts.claudeSessionId);
    if (!st) continue;
    if (ACTIVE_CLAUDE_PHASES.has(st.phase)) active.add(ts.id);
    else if (RESTING_CLAUDE_PHASES.has(st.phase)) {
      resting.add(ts.id);
      if (AWAITING_FEEDBACK_PHASES.has(st.phase)) awaiting.add(ts.id);
      if (AWAITING_INPUT_PHASES.has(st.phase)) awaitingInput.add(ts.id);
    }
    // `starting` / unknown → neither set → pty heuristic decides.
  }
  return { active, resting, awaiting, awaitingInput };
}

/**
 * Build the "what is each session doing" map, keyed by SUBJECT id (topicId for
 * chats, terminalSessionId for claude-code terminals). Only sessions that are
 * WORKING or AWAITING produce an entry — an idle/dormant session shows nothing,
 * so the map stays small and the activity labels only render where there's
 * something to say. The descriptor is flattened from the full session state so
 * the label component never reaches into the session map itself.
 */
export function deriveSessionActivity(
  topics: Record<string, Topic>,
  roster: TerminalRosterTypeEntry[],
  claudeSessions: ReadonlyMap<string, ClaudeSessionState>,
): Map<string, SessionActivitySignal> {
  const out = new Map<string, SessionActivitySignal>();
  const signalFor = (st: ClaudeSessionState): SessionActivitySignal | null => {
    const working = ACTIVE_CLAUDE_PHASES.has(st.phase);
    const tier = attentionTierForPhase(st.phase);
    if (!working && !tier) return null; // idle / completed / dormant / error → no label
    return {
      phase: st.phase,
      tier,
      working,
      tool: working ? st.lastTool?.name : undefined,
      approvalKind: tier === 'input' ? st.pendingApproval?.kind : undefined,
      // Prefer the running tool's start (freshest) when working, else the phase
      // change — so the elapsed counter tracks the current action.
      since: (working && st.lastTool?.startedAt) || st.phaseUpdatedAt || st.updatedAt,
      // Il turno nel suo insieme. Solo mentre lavora: a turno finito il numero
      // che serve è «quanto fa che ha finito» (phaseUpdatedAt), non la durata.
      turnSince: working ? st.turnStartedAt : undefined,
    };
  };
  // Chats — keyed by topicId via sessionKey.
  for (const t of Object.values(topics)) {
    const st = t.sessionKey ? claudeSessions.get(t.sessionKey) : undefined;
    if (!st) continue;
    const sig = signalFor(st);
    if (sig) out.set(t.id, sig);
  }
  // Terminals — keyed by terminal session id via claudeSessionId.
  const byCsid = new Map<string, ClaudeSessionState>();
  for (const st of claudeSessions.values()) byCsid.set(st.claudeSessionId, st);
  for (const ts of roster) {
    if (ts.type !== 'claude-code' && ts.type !== 'claude-code-team') continue;
    if (!ts.claudeSessionId) continue;
    const st = byCsid.get(ts.claudeSessionId);
    if (!st) continue;
    const sig = signalFor(st);
    if (sig) out.set(ts.id, sig);
  }
  return out;
}

/**
 * Build a "when did this session last actually do something" map, keyed by
 * SUBJECT id (topicId for chats, terminalSessionId for claude-code
 * terminals) — the UNFILTERED twin of deriveSessionActivity. That function
 * drops idle/completed/dormant/error sessions (nothing to show as an
 * activity label), which is exactly wrong for ORDERING: a finished session
 * still needs its real finish time so the sidebar can rank it by last touch
 * instead of freezing at createdAt. Every session with known Claude state
 * gets an entry here, regardless of phase.
 */
export function deriveSessionLastActivity(
  topics: Record<string, Topic>,
  roster: TerminalRosterTypeEntry[],
  claudeSessions: ReadonlyMap<string, ClaudeSessionState>,
): Map<string, number> {
  const out = new Map<string, number>();
  const lastTouchedAt = (st: ClaudeSessionState): number => st.phaseUpdatedAt || st.updatedAt;
  // Chats — keyed by topicId via sessionKey.
  for (const t of Object.values(topics)) {
    const st = t.sessionKey ? claudeSessions.get(t.sessionKey) : undefined;
    if (!st) continue;
    out.set(t.id, lastTouchedAt(st));
  }
  // Terminals — keyed by terminal session id via claudeSessionId.
  const byCsid = new Map<string, ClaudeSessionState>();
  for (const st of claudeSessions.values()) byCsid.set(st.claudeSessionId, st);
  for (const ts of roster) {
    if (ts.type !== 'claude-code' && ts.type !== 'claude-code-team') continue;
    if (!ts.claudeSessionId) continue;
    const st = byCsid.get(ts.claudeSessionId);
    if (!st) continue;
    out.set(ts.id, lastTouchedAt(st));
  }
  return out;
}

function terminalBelongsToProject(cwd: string, projectPath: string): boolean {
  return cwd === projectPath || cwd.startsWith(projectPath + '/');
}

// ---- Loading facade --------------------------------------------------------

/** Reactive: is any child of this project loading? Computed for the SPECIFIC
 *  path — a chat topic in it streaming, or a terminal whose cwd lives under it
 *  (covers projects with no chat topic, e.g. a bare claude-code session). Used
 *  by both the project tab and the sidebar project row so they always agree. */
export function useProjectLoading(projectPath: string | undefined): boolean {
  const topics = useTopics();
  const terminalSessions = useTerminalSessions();
  const { live, hydrated, term, phaseActive, phaseResting } = useSignalsStore(
    useShallow((s) => ({
      live: s.liveStreamTopics,
      hydrated: s.hydratedStreamTopics,
      term: s.terminalBusyIds,
      phaseActive: s.claudePhaseActiveTermIds,
      phaseResting: s.claudePhaseRestingTermIds,
    })),
  );
  return useMemo(() => {
    if (!projectPath) return false;
    for (const t of Object.values(topics)) {
      if (t.projectPath === projectPath && (live.has(t.id) || hydrated.has(t.id))) return true;
    }
    for (const ts of terminalSessions) {
      // Plain shells are the user's own background processes (dev servers,
      // watchers, ad-hoc commands). Their intermittent pty output must NOT make
      // the project tab flicker "loading" — the rollup means "a chat or a Claude
      // Code session in this project is working", not "a shell printed a line".
      // (A shell still shows loading on its OWN terminal tab; it just doesn't
      // roll up.) Only claude-code / claude-code-team sessions count here.
      if (ts.type === 'shell') continue;
      if (!ts.cwd || !terminalBelongsToProject(ts.cwd, projectPath)) continue;
      if (terminalLoadingFrom(ts.id, phaseActive, term, phaseResting)) return true;
    }
    return false;
  }, [projectPath, topics, terminalSessions, live, hydrated, term, phaseActive, phaseResting]);
}

/**
 * Il progetto sta aspettando TE?
 *
 * Serve al glifo del progetto, che finora ondeggiava in blu — «sto lavorando» —
 * anche quando l'unica cosa che succedeva lì dentro era una chat ferma su una
 * domanda. Sulla stessa riga il fill era già ambra, e i due segni si
 * contraddicevano: uno diceva «tocca a te», l'altro «lascialo lavorare».
 *
 * Stessa fonte del fill (`projectAttentionTier`), così non possono divergere.
 * Il tier 'input' è il più forte: se un figlio aspetta te, il progetto aspetta
 * te — anche se un altro figlio sta ancora macinando, perché la cosa che devi
 * fare non smette di esistere.
 */
export function useProjectAwaitingInput(projectPath: string | undefined): boolean {
  const topics = useTopics();
  const terminalSessions = useTerminalSessions();
  const { awaitingTopics, awaitingTerms, inputTopics, inputTerms, seen } = useSignalsStore(
    useShallow((s) => ({
      awaitingTopics: s.awaitingFeedbackTopics,
      awaitingTerms: s.claudePhaseAwaitingTermIds,
      inputTopics: s.awaitingInputTopics,
      inputTerms: s.claudePhaseAwaitingInputTermIds,
      seen: s.seenSubjects,
    })),
  );
  return useMemo(() => {
    if (!projectPath) return false;
    return projectAttentionTier(
      projectPath, topics, terminalSessions,
      awaitingTopics, awaitingTerms, inputTopics, inputTerms, seen,
    ) === 'input';
  }, [projectPath, topics, terminalSessions, awaitingTopics, awaitingTerms, inputTopics, inputTerms, seen]);
}

/** The attention TIER a project row/tab should paint: 'input' (amber) if ANY
 *  child is awaiting a permission — the loudest child wins — else 'done' (blue)
 *  if any child finished-and-unseen, else null. Mirrors useProjectLoading's
 *  child-walk ma tier-aware, così la superficie del progetto combacia con le
 *  sue foglie.
 *
 *  È l'UNICO rollup di attenzione: il predicato booleano `projectHasAwaitingChild`
 *  nasceva nello stesso commit ma non ha mai avuto un chiamante — questo lo
 *  copre, e con un tier invece che con un sì/no.
 *
 *  `seenSubjects` è il gate del "visto", ed è il motivo per cui la tab di un
 *  progetto tornava blu per sempre. Una fase Claude come `awaiting-user` NON si
 *  spegne da sola: resta lì fino al turno dopo. Per una chat o un terminale il
 *  fill lo spegne il "visto" (vedi `attentionFillFor`), ma questo rollup leggeva
 *  gli insiemi GREZZI — quindi il progetto continuava a segnalare un figlio che
 *  avevi già letto, e la sola cosa che lo nascondeva era il gate transitorio
 *  «la tab è attiva adesso»: bastava selezionare un'altra tab e tornava blu.
 *  Passandolo, un figlio già guardato smette di contribuire, e ricomincia da solo
 *  al turno successivo (`resetSeenOnNewAttention` gli toglie il visto sul fronte
 *  di salita).
 *
 *  Questo NON sostituisce FOCUS WINS sulla superficie del progetto: il gate
 *  «quella che stai guardando non ti pulsa in faccia» resta dov'era, nei
 *  chiamanti. Serve perché non tutti i figli sono raggiungibili — una sessione
 *  claude-code nel roster con cwd sotto il progetto e nessuna riga né tab non può
 *  essere marcata vista da nessuno (le tre soglie si armano solo su una riga
 *  renderizzata o sulla tab attiva), e senza quella valvola il progetto pulserebbe
 *  per sempre. I due gate sono complementari: questo spegne ciò che HAI letto,
 *  quello copre ciò che non puoi raggiungere.
 *
 *  Gli ARCHIVIATI non contano, ed è la causa che si misura sul campo, non un caso
 *  di scuola: sulla macchina di sviluppo, dei 22 figli che tenevano accesi i
 *  progetti, 21 erano chat CHIUSE ferme su `awaiting-user` — alcune di settimane
 *  prima. Una chat chiusa non ha riga né tab, quindi non c'è nessun posto dove
 *  andare a spegnerla: senza questa riga il progetto resta acceso per sempre, ed è
 *  precisamente il sintomo. È anche la scelta già fatta per l'ALTRO aggregato,
 *  `visibleTopicSignalCount` (che nacque dal gemello di questo bug: la status bar
 *  annunciava 22 sessioni parcheggiate mentre la sidebar non ne mostrava
 *  nessuna). Prezzo accettato, lo stesso di lì: una chat archiviata ma FISSATA ha
 *  una riga che pulsa mentre il progetto tace — il segnale non si perde, non viene
 *  aggregato. */
export function projectAttentionTier(
  projectPath: string,
  topics: Record<string, Topic>,
  terminalSessions: TerminalSessionInfo[],
  awaitingTopics: ReadonlySet<string>,
  awaitingTerms: ReadonlySet<string>,
  inputTopics: ReadonlySet<string>,
  inputTerms: ReadonlySet<string>,
  seenSubjects?: ReadonlySet<string>,
): AttentionTier | null {
  let hasDone = false;
  for (const t of Object.values(topics)) {
    if (t.projectPath !== projectPath) continue;
    if (t.archived) continue;
    if (t.standalone) continue; // resa fuori dal progetto — vedi rollupProjectAttention
    if (seenSubjects?.has(t.id)) continue;
    if (inputTopics.has(t.id)) return 'input';
    if (awaitingTopics.has(t.id)) hasDone = true;
  }
  for (const ts of terminalSessions) {
    if (ts.type === 'shell') continue;
    if (!ts.cwd || !terminalBelongsToProject(ts.cwd, projectPath)) continue;
    if (seenSubjects?.has(ts.id)) continue;
    if (inputTerms.has(ts.id)) return 'input';
    if (awaitingTerms.has(ts.id)) hasDone = true;
  }
  return hasDone ? 'done' : null;
}

// `usePaneLoading(pane)` lived here: a per-pane dispatcher that subscribed to
// SEVEN signal Sets through useShallow, so a single flip of `terminalBusyIds`
// re-rendered every component holding it. It had ZERO callers — every loading
// indicator goes through the id-based hooks below, which each subscribe to the
// one Set they need. Removed rather than kept "just in case": the id-based
// hooks are the API, and reviving a seven-Set subscription would undo the
// per-signal narrowing they exist for.

// ---- Id-based loading hooks (keep the spinner component API stable) ---------

/** A topic is loading if it has a live stream or a hydrated mid-reply. */
export function useTopicLoading(topicId: string | undefined): boolean {
  return useSignalsStore((s) =>
    !!topicId && (s.liveStreamTopics.has(topicId) || s.hydratedStreamTopics.has(topicId)),
  );
}

/**
 * Il turno di questo topic è FERMO ad aspettare una risposta — una domanda a
 * schermo in chat, o un permesso da concedere sul terminale.
 *
 * È il gemello «sta lavorando?» di `useTopicLoading`: un turno sospeso è ancora
 * aperto (quindi loading resta true, e il bottone stop ha ancora senso) ma non
 * macina niente. Chi disegna un indicatore chiede ENTRAMBI e sceglie il glifo,
 * invece di far passare per lavoro un'attesa.
 */
export function useTopicAwaitingInput(topicId: string | undefined): boolean {
  return useSignalsStore((s) => !!topicId && s.awaitingInputTopics.has(topicId));
}

/** The attention TIER of a chat topic's Claude session, or null. 'input' (amber,
 *  act now) when awaiting a permission; 'done' (blue, look when ready) when the
 *  turn finished/paused. The surface colour is chosen from this — see
 *  selectionStyles.attentionSurface. Returns a stable primitive so the selector
 *  is referentially safe. */
export function useTopicAttentionTier(topicId: string | undefined): AttentionTier | null {
  return useSignalsStore((s) => {
    if (!topicId) return null;
    if (s.awaitingInputTopics.has(topicId)) return 'input';
    if (s.awaitingFeedbackTopics.has(topicId)) return 'done';
    return null;
  });
}

/** The attention TIER of a claude-code terminal session — the terminal twin of
 *  useTopicAttentionTier. */
export function useTerminalAttentionTier(sessionId: string | undefined): AttentionTier | null {
  return useSignalsStore((s) => {
    if (!sessionId) return null;
    if (s.claudePhaseAwaitingInputTermIds.has(sessionId)) return 'input';
    if (s.claudePhaseAwaitingTermIds.has(sessionId)) return 'done';
    return null;
  });
}

/** Questo soggetto è stato DAVVERO guardato (soglia scattata)? */
export function useSubjectSeen(subjectId: string | undefined): boolean {
  return useSignalsStore((s) => !!subjectId && s.seenSubjects.has(subjectId));
}

/**
 * Il fill di attenzione di un soggetto, già passato per FOCUS WINS.
 *
 * Un hook solo al posto della coppia "leggi il tier" + "e poi ricordati di
 * spegnerlo se è focussato", che era ricopiata in quattro superfici con quattro
 * definizioni diverse di "focussato". Chi disegna una tab o una riga chiede
 * questo e disegna quello che torna.
 */
export function useTopicAttentionFill(topicId: string | undefined): AttentionTier | null {
  const tier = useTopicAttentionTier(topicId);
  const seen = useSubjectSeen(topicId);
  return attentionFillFor(tier, seen);
}

/** Il gemello terminale di `useTopicAttentionFill`. */
export function useTerminalAttentionFill(sessionId: string | undefined): AttentionTier | null {
  const tier = useTerminalAttentionTier(sessionId);
  const seen = useSubjectSeen(sessionId);
  return attentionFillFor(tier, seen);
}

/**
 * Arma la soglia del "visto" su un soggetto mentre è davanti.
 *
 * `focused` è la nozione di davanti della superficie che chiama (ognuna ha la
 * sua: una tab pretende anche che il gruppo e l'app abbiano il fuoco). A questa
 * si aggiunge SEMPRE `isWindowAwake()`, perché una tab selezionata in una
 * finestra che nessuno guarda non è stata vista — ed è lo stesso predicato con
 * cui l'app parcheggia animazioni e poll, tenuto in passo di proposito.
 *
 * Il timer non è un `setTimeout` nudo: se la finestra si addormenta o il fuoco
 * cambia prima della soglia, l'attesa RIPARTE da zero. Solo uno sguardo continuo
 * conta.
 */
export function useSeenDwell(subjectId: string | undefined, focused: boolean): void {
  useEffect(() => {
    if (!subjectId || !focused) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const arm = () => {
      if (cancelled || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        // Ri-controlla al momento dello scatto: la finestra può essersi
        // addormentata durante l'attesa senza emettere un evento che vediamo.
        if (!cancelled && isWindowAwake()) signalsActions.markSubjectSeen(subjectId);
      }, SEEN_DWELL_MS);
    };
    const disarm = () => {
      if (timer !== null) { clearTimeout(timer); timer = null; }
    };
    const onAwakeChange = () => { if (isWindowAwake()) arm(); else disarm(); };

    if (isWindowAwake()) arm();
    // `visibilitychange` copre la scheda nascosta, focus/blur la finestra dietro
    // a un'altra: `isWindowAwake` guarda entrambi, quindi serve ascoltarli tutti.
    document.addEventListener('visibilitychange', onAwakeChange);
    window.addEventListener('focus', onAwakeChange);
    window.addEventListener('blur', onAwakeChange);
    return () => {
      cancelled = true;
      disarm();
      document.removeEventListener('visibilitychange', onAwakeChange);
      window.removeEventListener('focus', onAwakeChange);
      window.removeEventListener('blur', onAwakeChange);
    };
  }, [subjectId, focused]);
}

/** "What is this session doing" for a subject id (topicId or terminalSessionId),
 *  or undefined when idle. Drives the SessionActivity label. */
export function useSessionActivity(subjectId: string | undefined): SessionActivitySignal | undefined {
  // Field-level (shallow) equality, NOT Object.is: deriveSessionActivity rebuilds
  // fresh descriptor objects for EVERY subject on each derivation, so any one
  // session's tool tick would otherwise re-render every activity label (its .get
  // returns a new-but-equal ref). useShallow compares the descriptor's fields so
  // an unchanged subject stays referentially stable to its consumer.
  return useSignalsStore(useShallow((s) => (subjectId ? s.sessionActivity.get(subjectId) : undefined)));
}

/** The full "last touched" map (topicId/terminalSessionId → ms epoch), for
 *  buildSidebarItems to fold into terminal row ordering. See
 *  deriveSessionLastActivity — unlike useSessionActivity this includes idle
 *  and finished sessions, so a completed run still sorts by when it actually
 *  finished instead of vanishing back to createdAt. */
export function useSessionLastActivity(): Map<string, number> {
  return useSignalsStore((s) => s.sessionLastActivity);
}

/** L'ultimo movimento di UN soggetto. Il gemello per-riga di
 *  `useSessionLastActivity`: quella restituisce la mappa intera, e una riga di
 *  sidebar che ci si iscrivesse si ri-renderebbe a ogni tick di QUALUNQUE altra
 *  sessione. Qui il selettore estrae un numero, quindi la riga si muove solo
 *  quando è il suo numero a muoversi. */
export function useSubjectLastActivity(subjectId: string | undefined): number | undefined {
  return useSignalsStore((s) => (subjectId ? s.sessionLastActivity.get(subjectId) : undefined));
}

/** A terminal session is loading when its claude phase is active, or (for
 *  shells / not-yet-known phases) its pty is busy. A claude-code session at a
 *  resting phase never shows loading from pty alone — see terminalLoadingFrom. */
export function useTerminalLoading(sessionId: string | undefined): boolean {
  return useSignalsStore((s) =>
    !!sessionId && terminalLoadingFrom(sessionId, s.claudePhaseActiveTermIds, s.terminalBusyIds, s.claudePhaseRestingTermIds),
  );
}

/** A claude-code session finished a turn and the user hasn't looked yet. */
export function useTerminalFinished(sessionId: string | undefined): boolean {
  return useSignalsStore((s) => !!sessionId && s.terminalFinishedIds.has(sessionId));
}

/** A terminal session is restarting via "Ricarica", until it reconnects. */
export function useTerminalReloading(sessionId: string | undefined): boolean {
  return useSignalsStore((s) => !!sessionId && s.terminalReloadingIds.has(sessionId));
}

/** A browser pane is loading (page load or an agent driving it). */
export function useBrowserLoading(paneId: string | undefined): boolean {
  return useSignalsStore((s) => !!paneId && s.browserBusyPaneIds.has(paneId));
}

/** Pure: how many of `ids` belong to a topic that is actually ON SCREEN.
 *
 *  The topic signal Sets are deliberately NOT archived-filtered: they are keyed
 *  by topic id and every per-row / per-tab consumer is already gated by the
 *  existence of its row or tab (the sidebar even keeps a PINNED archived chat
 *  visible on purpose — `buildSidebarItems`' pinned escape — and must keep its
 *  badge). A raw `.size`, though, has no such gate, and that is how the status
 *  bar came to advertise 22 parked sessions while the sidebar showed none: all
 *  22 were archived topics, some of them reaped worktrees weeks old.
 *
 *  So the COUNT — the one consumer that reads the Sets without a surface behind
 *  it — applies the gate here instead. An id whose topic no longer exists is
 *  dropped too: a deleted topic must not keep nagging from the status bar. */
export function visibleTopicSignalCount(
  ids: ReadonlySet<string>,
  topics: Record<string, Topic>,
): number {
  let n = 0;
  for (const id of ids) {
    const t = topics[id];
    if (t && !t.archived) n++;
  }
  return n;
}

/**
 * Global live agent counts for the status bar, counted from the SAME signals the
 * tab spinners and blue "awaiting" fills read — and, for the topic-keyed ones,
 * narrowed to topics that are actually on screen (see `visibleTopicSignalCount`)
 * so the number cannot drift from what you can see:
 *   - working      = claude/codex sessions producing output right now. A terminal
 *     counts via `terminalLoadingFrom` (phase-active OR pty-busy-and-not-resting)
 *     — crucially the pty-busy fallback means a session stuck at `starting`
 *     (hooks never advanced it) still counts, which raw phase counting missed —
 *     plus chat topics mid-stream (live or hydrated).
 *   - awaiting     = sessions parked for the user (the whole blue-fill set):
 *     claude terminals awaiting + chat topics awaiting.
 *   - awaitingInput= the LOUD subset of `awaiting` (`awaiting-approval`): blocked
 *     on a permission, needs an answer now. Split out so the chip can paint the
 *     two tiers the way `attentionTierForPhase` defines them instead of calling
 *     everything amber — `awaiting-user` means "the turn ended", not "answer me".
 *
 * `roster` is the authoritative terminal session list (App's `terminalSessions`)
 * — needed to enumerate which ids are claude/codex and apply the loading rule.
 * `topics` is App's topic map, the authority on what is archived.
 */
export function useAgentActivityCounts(
  roster: ReadonlyArray<{ id: string; type: string }>,
  topics: Record<string, Topic>,
): { working: number; awaiting: number; awaitingInput: number } {
  const sig = useSignalsStore(
    useShallow((s) => ({
      active: s.claudePhaseActiveTermIds,
      resting: s.claudePhaseRestingTermIds,
      busy: s.terminalBusyIds,
      awaitingTerm: s.claudePhaseAwaitingTermIds,
      awaitingInputTerm: s.claudePhaseAwaitingInputTermIds,
      liveStream: s.liveStreamTopics,
      hydratedStream: s.hydratedStreamTopics,
      awaitingTopics: s.awaitingFeedbackTopics,
      awaitingInputTopics: s.awaitingInputTopics,
      // I turni claude-code FINITI. Erano fuori dal conteggio, e il tooltip
      // intanto chiamava «con il turno finito» un'altra cosa — vedi sotto.
      finishedTerms: s.terminalFinishedIds,
    })),
  );
  return useMemo(() => {
    let working = 0;
    for (const t of roster) {
      // L'esclusione voluta e' la SHELL, non «tutto tranne i tre che mi
      // ricordo»: scritta come lista negata, aveva gia' lasciato fuori
      // 'opencode', che quindi lavorava senza comparire fra gli agenti attivi
      // (il dato c'era: useSignalsSync popola terminalBusyIds per ogni
      // sessione, senza filtrare sul tipo).
      if (t.type === 'shell') continue;
      if (terminalLoadingFrom(t.id, sig.active, sig.busy, sig.resting)) working++;
    }
    // Chat sessions mid-reply (distinct id space from terminals → no overlap).
    const streamingTopics = new Set<string>([...sig.liveStream, ...sig.hydratedStream]);
    working += visibleTopicSignalCount(streamingTopics, topics);
    // Awaiting = the blue-fill set across both surfaces, and its loud subset.
    //
    // Ai terminali si aggiungono i turni FINITI (`terminalFinishedIds`), che
    // prima non contavano da nessuna parte. È la stessa cosa che badgia la loro
    // tab, e la barra ne stava fuori: si vedevano N tab col pallino blu «turno
    // finito» e la barra ne annunciava due. Peggio, il tooltip chiamava
    // «con il turno finito» il resto di `awaiting`, che sono le sessioni in
    // `awaiting-user`/`paused` — un'altra cosa, con lo stesso nome.
    //
    // UNION, non somma: una sessione può essere in entrambi gli insiemi (ha
    // finito il turno E la fase è `awaiting-user`) e vale UNA cosa da guardare.
    const awaitingTermIds = new Set<string>(sig.awaitingTerm);
    // Solo i terminali che esistono ancora nel roster: un id finito la cui
    // sessione è stata chiusa non ha più né riga né tab, e il suo "1" non
    // sarebbe azzerabile da nessuna parte (stessa ragione del gate sugli
    // archiviati in `visibleTopicSignalCount`).
    for (const t of roster) if (sig.finishedTerms.has(t.id)) awaitingTermIds.add(t.id);
    const awaiting = awaitingTermIds.size + visibleTopicSignalCount(sig.awaitingTopics, topics);
    const awaitingInput =
      sig.awaitingInputTerm.size + visibleTopicSignalCount(sig.awaitingInputTopics, topics);
    return { working, awaiting, awaitingInput };
  }, [roster, topics, sig]);
}

// ---- Attention facade (read by the notification layer) ---------------------

/** Reactive attention sets for getBadgeCount. */
export function useAttentionSignals() {
  return useSignalsStore(
    useShallow((s) => ({
      claudeAttentionTopics: s.claudeAttentionTopics,
      terminalFinishedIds: s.terminalFinishedIds,
    })),
  );
}

/**
 * Attention count for a single chat topic: server unread OR a "Claude needs
 * you" phase (awaiting-approval / awaiting-user / paused / error). `max`, never
 * sum — a topic that is both unread AND awaiting you is still ONE thing to look
 * at. This is the single
 * source the tab bar (getBadgeCount) and the sidebar (buildSidebarItems) both
 * call, so a chat's badge can never differ between the two surfaces.
 */
export function topicAttentionCount(
  topicId: string,
  unread: Record<string, { unreadCount: number } | undefined>,
  claudeAttentionTopics: Set<string>,
): number {
  // NB: nessun gate "visto" qui, ed è deliberato. Il conteggio e il fill sono due
  // ASSI diversi: il fill risponde a «devo attirare la tua attenzione?» e si
  // spegne quando hai guardato (`attentionFillFor`, `projectAttentionTier`); il
  // numero risponde a «ti resta un'azione da fare» e si spegne quando l'azione è
  // fatta. Portare il "visto" qui è stato provato e scartato: farebbe dire 0 al
  // progetto mentre la riga della chat figlia dice ancora 1, che è esattamente la
  // deriva fra superfici che questi helper esistono per impedire.
  return Math.max(unread[topicId]?.unreadCount || 0, claudeAttentionTopics.has(topicId) ? 1 : 0);
}

/**
 * Attention count for a terminal session: a claude-code turn that finished and
 * hasn't been opened yet. Same source the tab bar and sidebar terminal rows
 * read, so the finished signal is one badge, not a dot here and a badge there.
 */
export function terminalAttentionCount(sid: string, terminalFinishedIds: Set<string>): number {
  // MAI un gate "visto" davanti a `terminalFinishedIds`: quel segnale si alza
  // proprio per le sessioni senza fase nota, che per costruzione non entrano mai
  // in `claudePhaseAwaitingTermIds` — da cui passa il reset del visto. Le due
  // popolazioni sono disgiunte, e un gate qui renderebbe il chip muto per sempre
  // dal secondo turno finito in poi.
  return terminalFinishedIds.has(sid) ? 1 : 0;
}

/**
 * Project attention rollup: sum of child unread + Claude attention + finished
 * claude-code turns. Pure helper (not a hook) so both getProjectBadgeCount (tab
 * bar) and buildSidebarItems (sidebar project row) call it — guaranteeing the
 * project tab and the sidebar project row show the SAME summed count. Built on
 * the per-subject helpers above so there's one definition of "attention".
 *
 * Gli ARCHIVIATI non contano, per la stessa ragione di `projectAttentionTier` e
 * di `visibleTopicSignalCount`: una chat chiusa ferma su `awaiting-user` non ha
 * riga né tab, quindi il suo "1" non si può azzerare da nessuna parte e il badge
 * del progetto resta appeso per sempre. Misurato: 6 dei 6 figli che tenevano
 * segnalato `topics-app` erano archiviati. Il gemello globale
 * (`rollupGlobalAttention`, badge del dock) NON è cambiato qui — è un'altra
 * superficie e va guardato a parte.
 */
export function rollupProjectAttention(
  projectPath: string,
  topics: Record<string, Topic>,
  terminalSessions: TerminalSessionInfo[],
  unread: Record<string, { unreadCount: number } | undefined>,
  claudeAttentionTopics: Set<string>,
  terminalFinishedIds: Set<string>,
): number {
  let sum = 0;
  for (const s of projectAttentionSubjects(projectPath, topics, terminalSessions, unread, claudeAttentionTopics, terminalFinishedIds)) {
    sum += s.count;
  }
  return sum;
}

/** Un figlio che contribuisce al numero del progetto, con il suo NOME. */
export interface AttentionSubject {
  id: string;
  kind: 'chat' | 'terminal';
  name: string;
  count: number;
}

/**
 * CHI compone il numero del progetto, non solo quanto fa.
 *
 * Nasce da un sintomo preciso: il progetto «Guido AI» mostrava 1 e nessuna tab
 * dentro mostrava niente. Il numero era corretto — una chat ferma su
 * `awaiting-user` — ma non era ATTRIBUIBILE: quella chat era l'unica pane aperta
 * del progetto, quindi per forza la tab attiva, e sia la tab (`suppressOnSelect`)
 * sia la riga di sidebar (`!isFocused`) nascondono il numero di ciò che stai
 * guardando. Due regole giuste che, insieme, producono un numero orfano.
 *
 * La soppressione non si tocca: è la spec, ed è coperta da un test E2E
 * (`tab-notifications.spec.ts`, TAB-BADGE-07). Quello che mancava era il modo di
 * RISALIRE dal numero al suo autore, e ora ce l'hanno il tooltip della riga di
 * progetto e il nome accessibile della tab.
 *
 * `rollupProjectAttention` è definito su questa lista, non accanto ad essa: due
 * walk paralleli sugli stessi figli sono esattamente come i due gemelli
 * fill/badge hanno già divergito una volta.
 */
export function projectAttentionSubjects(
  projectPath: string,
  topics: Record<string, Topic>,
  terminalSessions: TerminalSessionInfo[],
  unread: Record<string, { unreadCount: number } | undefined>,
  claudeAttentionTopics: Set<string>,
  terminalFinishedIds: Set<string>,
): AttentionSubject[] {
  const out: AttentionSubject[] = [];
  for (const t of Object.values(topics)) {
    if (t.projectPath !== projectPath) continue;
    if (t.archived) continue;
    const count = topicAttentionCount(t.id, unread, claudeAttentionTopics);
    if (count > 0) out.push({ id: t.id, kind: 'chat', name: t.name || 'Chat', count });
  }
  if (terminalFinishedIds.size) {
    for (const ts of terminalSessions) {
      // Le shell non sono agenti e `projectAttentionTier` le salta già (:947):
      // due gemelli che camminano sugli stessi figli con due predicati diversi
      // producono, prima o poi, un fill senza numero o un numero senza fill.
      if (ts.type === 'shell') continue;
      if (!ts.cwd || !terminalBelongsToProject(ts.cwd, projectPath)) continue;
      const count = terminalAttentionCount(ts.id, terminalFinishedIds);
      if (count > 0) out.push({ id: ts.id, kind: 'terminal', name: ts.name || ts.type || 'Terminale', count });
    }
  }
  return out;
}

/** Il tooltip del progetto: «2 da guardare: Lavori aperti da fare · build». Vuoto
 *  quando non c'è niente, così il chiamante può concatenarlo senza guardie. */
export function describeProjectAttention(subjects: AttentionSubject[]): string {
  if (!subjects.length) return '';
  const total = subjects.reduce((n, s) => n + s.count, 0);
  // Cap a 4 nomi: un progetto con venti figli non deve produrre un tooltip che
  // copre lo schermo. Il resto si conta.
  const shown = subjects.slice(0, 4).map((s) => s.name);
  const rest = subjects.length - shown.length;
  return `${total} da guardare: ${shown.join(' · ')}${rest > 0 ? ` · +altri ${rest}` : ''}`;
}

/**
 * App-wide attention total for the desktop dock badge + macOS menu-bar tray glyph
 * (Electron parity). The number of things needing the user across EVERY topic and
 * terminal, using the SAME per-subject attention the tab badges show — chats
 * contribute their unread-or-awaiting count, finished claude-code turns one each —
 * summed once. Pure so it's unit-testable and shares the single definition of
 * "attention" with the tab bar / sidebar (no drift). Agent/session-viewer pane
 * badges live in the notification layer's local `extraCounts`, so the caller adds
 * those; keeping them out here keeps this a pure function of the global stores.
 */
export function rollupGlobalAttention(
  topics: Record<string, Topic>,
  unread: Record<string, { unreadCount: number } | undefined>,
  claudeAttentionTopics: Set<string>,
  terminalFinishedIds: Set<string>,
): number {
  let sum = 0;
  for (const t of Object.values(topics)) {
    // Gli ARCHIVIATI fuori anche qui. Il commento di `rollupProjectAttention`
    // diceva che questo gemello «va guardato a parte»: guardato. Misurato sui
    // dati veri il 03/08: dei 23 topic con sessione ferma su `awaiting-user`, 21
    // erano ARCHIVIATI — chat chiuse, alcune di settimane prima, senza riga né
    // tab. Erano 21 unità sul badge del dock e sul glifo nella barra dei menu che
    // non si potevano azzerare da nessuna parte, perché non esiste una superficie
    // dove andare a spegnerle. Stesso gate di `visibleTopicSignalCount`.
    if (t.archived) continue;
    sum += topicAttentionCount(t.id, unread, claudeAttentionTopics);
  }
  return sum + terminalFinishedIds.size;
}
