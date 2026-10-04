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
 *   - attention — "this pane needs you": NOT here any more. It is the server's
 *     attention state (`state/attention.ts`, notifications-redesign), and the
 *     rollups below read it from there.
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
import { useMemo } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { Topic, ClaudeSessionPhase, ClaudeSessionState, AttentionTier, PhaseTier } from '../types';
import { useTopics, useTerminalSessions } from '../contexts/TopicsContext';
import { mergeBackgroundWork, type TopicBackgroundWork } from './backgroundWork';
import type { AttentionTask } from '../../../shared/attention';
import { attentionOf, useAttentionRows, useAttentionStore, useTerminalAttention, useTopicAttention, type AttentionRows } from './attention';
import { projectAttention, projectBackgroundCount } from './attentionRollups';

/** Phases that mean "Claude STOPPED and is waiting for YOU" — the subset of
 *  NOTABLE that warrants a blue "awaiting feedback" tab/row highlight.
 *
 *  It is NOTABLE minus `error`: an errored session is a failure, not a chat
 *  parked for your input, so it keeps the (red-ish) badge but never goes blue.
 *  `paused` stays in (a timed-out approval whose question is still on screen —
 *  see NOTABLE_CLAUDE_PHASES). Loading phases (running / tool-running) are the
 *  opposite axis and, being mutually exclusive with these in time, never show a
 *  blue fill and a spinner at once. */
const AWAITING_FEEDBACK_PHASES: ReadonlySet<ClaudeSessionPhase> = new Set<ClaudeSessionPhase>([
  'awaiting-user',
  'awaiting-approval',
  'paused',
]);

/** The LOUD subset of AWAITING_FEEDBACK_PHASES: Claude is blocked on a permission
 *  and needs an answer NOW (the amber "act now" tier). Strictly `awaiting-approval`
 *  — a mid-task gate — as opposed to `awaiting-user`/`paused`, which mean the turn
 *  simply finished (the calm blue "done, look when ready" tier). Splitting the two
 *  is the fix for "one blue does two jobs → everything looks equally urgent". */
const AWAITING_INPUT_PHASES: ReadonlySet<ClaudeSessionPhase> = new Set<ClaudeSessionPhase>([
  'awaiting-approval',
]);

/** Map a phase to its LABEL tier, or null if it isn't a "needs you" phase.
 *  `awaiting-approval` → 'input'; `awaiting-user`/`paused` → 'done'. It names
 *  what the session's activity label says; whether a surface LIGHTS UP is the
 *  attention state's decision (`state/attention.ts`), never the phase's. */
export function attentionTierForPhase(phase: ClaudeSessionPhase): PhaseTier | null {
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
//
// The one dwell, and the one seen event it fires, live in `paneSeen.ts`: the
// window's focused pane, whatever input focused it.

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
 *
 * The amber ('needs-you', a permission or a question waiting) is NOT cleared
 * by a look: it is not news to read but a request still open, and only the
 * answer takes it away. Since notifications-redesign the "seen" of a chat or a
 * terminal is the server's (a seen subject is no longer lit), so the one
 * caller left is the project row, whose `seen` is "the folder is selected".
 */
export function attentionFillFor(
  tier: AttentionTier | null | undefined,
  seen: boolean,
): AttentionTier | null {
  if (!tier) return null;
  if (tier === 'needs-you') return tier;
  return seen ? null : tier;
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
  /** Whether `/api/topics/streaming` has answered at least once in this page:
   *  before that the hydrated set is empty because nobody asked, not because
   *  nothing is open. */
  hydratedStreamAsked: boolean;
  /**
   * The poll's DETAIL of the work a closed turn left running, by topic: the
   * process of a `run_command` (its link to the Processes pane) and when the
   * CLI last said something about the work (the stale readout). Never whether
   * there IS work, nor which glyph: that is the attention state's
   * (`attentionOf(...).background`), so the glyph and the fill cannot diverge.
   */
  backgroundWorkTopics: ReadonlyMap<string, TopicBackgroundWork>;
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
  markHydratedStreamAsked: () => void;
  setBackgroundDetail: (byTopic: ReadonlyMap<string, TopicBackgroundWork>) => void;
  setBrowserBusy: (paneId: string, busy: boolean) => void;
  setTerminalBusy: (id: string, busy: boolean) => void;
  markTerminalReloading: (id: string) => void;
  clearTerminalReloading: (id: string) => void;
  reconcileTerminals: (roster: TerminalRosterEntry[]) => void;
  setClaudePhaseTerminals: (active: Set<string>, resting: Set<string>) => void;
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
  tier: PhaseTier | null;
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

type TopicSetKey = 'liveStreamTopics' | 'hydratedStreamTopics';

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
 * Reconcile the busy set against an authoritative session roster.
 *
 * The server roster is the single source of truth for which pty sessions exist
 * and which are busy *right now*. Incremental `terminal:activity` deltas can be
 * lost (server restart wipes the in-memory activity map, WS reconnect, a
 * dropped message) — leaving a session stuck "in progress". Re-deriving from
 * the roster whenever it arrives makes the loading state self-healing. The
 * "finished" mark that used to be pruned here is the server's attention state
 * now: a closed terminal is composed `idle` there (`closed`).
 *
 * Pure: returns the SAME set reference when nothing changed so the store can
 * skip the update and avoid spurious re-renders.
 */
export function reconcileTerminalSignals(prevBusy: Set<string>, roster: TerminalRosterEntry[]): Set<string> {
  const nextBusy = new Set<string>();
  for (const s of roster) if (s.busy) nextBusy.add(s.id);
  return setsEqual(nextBusy, prevBusy) ? prevBusy : nextBusy;
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
  hydratedStreamAsked: false,
  backgroundWorkTopics: new Map(),
  terminalBusyIds: new Set(),
  browserBusyPaneIds: new Set(),
  claudePhaseActiveTermIds: new Set(),
  claudePhaseRestingTermIds: new Set(),
  terminalReloadingIds: new Set(),
  sessionActivity: new Map(),
  sessionLastActivity: new Map(),

  markHydratedStreamAsked: () => set((s) => (s.hydratedStreamAsked ? s : { hydratedStreamAsked: true })),
  setTopicSet: (key, ids) =>
    set((s) => (setsEqual(ids, s[key]) ? s : ({ [key]: ids } as Pick<SignalsState, TopicSetKey>))),
  setBackgroundDetail: (byTopic) =>
    set((s) => {
      const topics = mergeBackgroundWork(s.backgroundWorkTopics, byTopic);
      return topics === s.backgroundWorkTopics ? s : { backgroundWorkTopics: topics };
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
      const busy = reconcileTerminalSignals(s.terminalBusyIds, roster);
      return busy === s.terminalBusyIds ? s : { terminalBusyIds: busy };
    }),

  setClaudePhaseTerminals: (active, resting) =>
    set((s) => {
      const activeChanged = !setsEqual(active, s.claudePhaseActiveTermIds);
      const restingChanged = !setsEqual(resting, s.claudePhaseRestingTermIds);
      if (!activeChanged && !restingChanged) return s;
      return {
        ...(activeChanged ? { claudePhaseActiveTermIds: active } : {}),
        ...(restingChanged ? { claudePhaseRestingTermIds: resting } : {}),
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
  setHydratedStreamTopics: (ids: Set<string>) => {
    const st = useSignalsStore.getState();
    st.setTopicSet('hydratedStreamTopics', ids);
    st.markHydratedStreamAsked();
  },
  setBackgroundDetail: (byTopic: ReadonlyMap<string, TopicBackgroundWork>) => useSignalsStore.getState().setBackgroundDetail(byTopic),
  setSessionActivity: (activity: Map<string, SessionActivitySignal>) => useSignalsStore.getState().setSessionActivity(activity),
  setSessionLastActivity: (activity: Map<string, number>) => useSignalsStore.getState().setSessionLastActivity(activity),
  setBrowserBusy: (paneId: string, busy: boolean) => useSignalsStore.getState().setBrowserBusy(paneId, busy),
  setTerminalBusy: (id: string, busy: boolean) => useSignalsStore.getState().setTerminalBusy(id, busy),
  markTerminalReloading: (id: string) => useSignalsStore.getState().markTerminalReloading(id),
  clearTerminalReloading: (id: string) => useSignalsStore.getState().clearTerminalReloading(id),
  reconcileTerminals: (roster: TerminalRosterEntry[]) => useSignalsStore.getState().reconcileTerminals(roster),
  setClaudePhaseTerminals: (active: Set<string>, resting: Set<string>) => useSignalsStore.getState().setClaudePhaseTerminals(active, resting),
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
 * SINCE WHEN has this project had something running: the epoch-ms of the
 * OLDEST turn still going among its children, or undefined when nothing is
 * working.
 *
 * The project surfaces (tab, sidebar row) already roll up "is anything running"
 * (useProjectLoading); this is the same roll-up with a clock on it, so a closed
 * folder can say "12m" instead of only "yes". The oldest and not the newest: the
 * question a folder answers is "how long has this been going on", and a turn
 * started two seconds ago inside it does not make that answer smaller.
 *
 * Same child-walk as useProjectLoading (chat topics of the project, non-shell
 * terminals whose cwd lives under it), so the number cannot appear on a folder
 * whose glyph is off, nor go missing on one whose glyph is on.
 */
export function useProjectWorkStart(projectPath: string | undefined): number | undefined {
  const topics = useTopics();
  const terminalSessions = useTerminalSessions();
  const activity = useSignalsStore((s) => s.sessionActivity);
  return useMemo(() => {
    if (!projectPath) return undefined;
    let oldest: number | undefined;
    const consider = (subjectId: string) => {
      const a = activity.get(subjectId);
      if (!a?.working) return;
      // `turnSince` is the start of the turn; `since` (start of the current
      // tool) is the fallback the server leaves after a mid-turn restart, and
      // it is the same fallback deriveSubjectTime uses.
      const at = a.turnSince && a.turnSince > 0 ? a.turnSince : a.since;
      if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return;
      if (oldest === undefined || at < oldest) oldest = at;
    };
    for (const t of Object.values(topics)) {
      if (t.projectPath === projectPath) consider(t.id);
    }
    for (const ts of terminalSessions) {
      if (ts.type === 'shell') continue;
      if (!ts.cwd || !terminalBelongsToProject(ts.cwd, projectPath)) continue;
      consider(ts.id);
    }
    return oldest;
  }, [projectPath, topics, terminalSessions, activity]);
}

/**
 * Il progetto sta aspettando TE?
 *
 * Serve al glifo del progetto, che finora ondeggiava in blu — «sto lavorando» —
 * anche quando l'unica cosa che succedeva lì dentro era una chat ferma su una
 * domanda. Sulla stessa riga il fill era già ambra, e i due segni si
 * contraddicevano: uno diceva «tocca a te», l'altro «lascialo lavorare».
 *
 * Same source as the fill (`projectAttention`, the rollup of the attention
 * state), so the two cannot diverge. 'needs-you' is the loudest tier: a child
 * that waits for you makes the project wait for you.
 */
export function useProjectAwaitingInput(projectPath: string | undefined): boolean {
  const topics = useTopics();
  const terminalSessions = useTerminalSessions();
  const rows = useAttentionRows();
  return useMemo(
    () => !!projectPath && projectAttention(rows, projectPath, topics, terminalSessions).tier === 'needs-you',
    [projectPath, topics, terminalSessions, rows],
  );
}

// `usePaneLoading(pane)` lived here: a per-pane dispatcher that subscribed to
// SEVEN signal Sets through useShallow, so a single flip of `terminalBusyIds`
// re-rendered every component holding it. It had ZERO callers — every loading
// indicator goes through the id-based hooks below, which each subscribe to the
// one Set they need. Removed rather than kept "just in case": the id-based
// hooks are the API, and reviving a seven-Set subscription would undo the
// per-signal narrowing they exist for.

// ---- Id-based loading hooks (keep the spinner component API stable) ---------

/** Has the server's stream registry answered at least once in this page? The
 *  «no reply» banner must not speak before it has. */
export function useServerTurnAsked(): boolean {
  return useSignalsStore((s) => s.hydratedStreamAsked);
}

/** The poll's detail of a chat's background work (command processes, last news): the line reads it, never to decide whether there is work. */
export function useTopicBackgroundDetail(topicId: string | undefined): TopicBackgroundWork | undefined {
  return useSignalsStore((s) => (topicId ? s.backgroundWorkTopics.get(topicId) : undefined));
}

const NO_TASKS: readonly AttentionTask[] = [];

/**
 * Is the chat waiting on its own background work, with nothing to ask (tier
 * `background`)? The grey glyph on the tab, the row and the indicator: read
 * from the same frame as the fill, so a row cannot be grey and blue at once
 * (BG-1, ATTN-12).
 */
export function useTopicInBackground(topicId: string | undefined): boolean {
  return useAttentionStore((s) => !!topicId && s.rows.get(`topic:${topicId}`)?.state === 'background');
}

/**
 * The tasks a chat's closed turns left running, whatever its tier: the line
 * under the transcript names them, and the composer's Stop is offered while
 * there are any (even on a `finished(error)` chat, ATTN-12).
 */
export function useTopicBackgroundTasks(topicId: string | undefined): readonly AttentionTask[] {
  return useAttentionStore((s) => (topicId ? s.rows.get(`topic:${topicId}`)?.background : undefined)) ?? NO_TASKS;
}

/**
 * A terminal waiting on background work (attention tier `background`) and the
 * tasks it waits on: the same grey glyph a chat gets (ATTN-12). The phase
 * partition counts `watching` as active, so without this a terminal whose
 * turn left a job running kept the blue working ring (tasks.md 5.1).
 */
export function useTerminalInBackground(sessionId: string | undefined): boolean {
  return useAttentionStore((s) => !!sessionId && s.rows.get(`terminal:${sessionId}`)?.state === 'background');
}

export function useTerminalBackgroundTasks(sessionId: string | undefined): readonly AttentionTask[] {
  return useAttentionStore((s) => (sessionId ? s.rows.get(`terminal:${sessionId}`)?.background : undefined)) ?? NO_TASKS;
}

/** How many children of this project wait on background work: the closed folder's grey glyph. */
export function useProjectBackgroundWork(projectPath: string | undefined): number {
  const topics = useTopics();
  const terminalSessions = useTerminalSessions();
  const rows = useAttentionRows();
  return useMemo(
    () => (projectPath ? projectBackgroundCount(rows, projectPath, topics, terminalSessions) : 0),
    [projectPath, topics, terminalSessions, rows],
  );
}

/** A topic is loading if it has a live stream or a hydrated mid-reply. */
export function useTopicLoading(topicId: string | undefined): boolean {
  return useSignalsStore((s) =>
    !!topicId && (s.liveStreamTopics.has(topicId) || s.hydratedStreamTopics.has(topicId)),
  );
}

/**
 * Il turno di questo topic è FERMO ad aspettare una risposta — una domanda a
 * schermo, un permesso, un piano da approvare.
 *
 * È il gemello «sta lavorando?» di `useTopicLoading`: un turno sospeso è ancora
 * aperto (quindi loading resta true, e il bottone stop ha ancora senso) ma non
 * macina niente. Chi disegna un indicatore chiede ENTRAMBI e sceglie il glifo,
 * invece di far passare per lavoro un'attesa. Read from the attention state
 * (`needs-you`), the same frame that paints the amber fill.
 */
export function useTopicAwaitingInput(topicId: string | undefined): boolean {
  return useAttentionStore((s) => !!topicId && s.rows.get(`topic:${topicId}`)?.state === 'needs-you');
}

/** The lit tier of a chat (its fill), from the attention state: a seen subject is not lit. */
export function useTopicAttentionFill(topicId: string | undefined): AttentionTier | null {
  const a = useTopicAttention(topicId);
  return a.lit ? (a.tier as AttentionTier) : null;
}

/** The terminal twin of `useTopicAttentionFill`. */
export function useTerminalAttentionFill(sessionId: string | undefined): AttentionTier | null {
  const a = useTerminalAttention(sessionId);
  return a.lit ? (a.tier as AttentionTier) : null;
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
export function visibleTopicSignalIds(
  ids: Iterable<string>,
  topics: Record<string, Topic>,
): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const t = topics[id];
    if (t && !t.archived) out.push(id);
  }
  return out;
}

/** The count is the list's length: one gate, one place. A consumer that needs
 *  the number reads this, one that needs the rows reads `visibleTopicSignalIds`,
 *  and the two cannot disagree. */
export function visibleTopicSignalCount(
  ids: ReadonlySet<string>,
  topics: Record<string, Topic>,
): number {
  return visibleTopicSignalIds(ids, topics).length;
}

/** One agent that is doing something right now, with the words to name it:
 *  a terminal by its name, a chat by its title. `kind` says which id space the
 *  id belongs to. */
export interface ActiveAgentRow {
  id: string;
  kind: 'terminal' | 'topic';
  label: string;
}

/** The agent lists of the menu, as `activeAgentRowsFrom` builds them. */
export interface ActiveAgentRows {
  working: ActiveAgentRow[];
  background: ActiveAgentRow[];
  awaitingInput: ActiveAgentRow[];
  finished: ActiveAgentRow[];
}

/** The minimum a roster entry has to carry to be turned into a row. It is a
 *  subset of `TerminalSessionInfo`, so App's list fits without a cast. */
export type AgentRosterEntry = { id: string; type: string; name: string };

/** The slice both agent hooks read: the loading sets of this store and the
 *  attention rows. One selector so the two hooks re-run on the same changes. */
type AgentActivitySlice = {
  active: Set<string>;
  resting: Set<string>;
  busy: Set<string>;
  liveStream: Set<string>;
  hydratedStream: Set<string>;
  attention: AttentionRows;
};

function useAgentActivitySlice(): AgentActivitySlice {
  const loading = useSignalsStore(
    useShallow((s) => ({
      active: s.claudePhaseActiveTermIds,
      resting: s.claudePhaseRestingTermIds,
      busy: s.terminalBusyIds,
      liveStream: s.liveStreamTopics,
      hydratedStream: s.hydratedStreamTopics,
    })),
  );
  const attention = useAttentionRows();
  return useMemo(() => ({ ...loading, attention }), [loading, attention]);
}

/**
 * Pure: the agents WORKING, IN BACKGROUND, WAITING FOR AN ANSWER and FINISHED,
 * as rows.
 *
 * This is the one place that decides who counts as an active agent. The
 * profile menu lists these rows, the card badges their number, and the status
 * counts are their `.length`: a session cannot be in the number and missing
 * from the list, because there is no second predicate to drift.
 *
 *   - working: a non-shell terminal that `terminalLoadingFrom` calls loading
 *     (phase-active OR pty-busy-and-not-resting), plus every chat topic mid
 *     stream (live or hydrated) that is on screen (not archived, not deleted).
 *   - background, awaitingInput, finished: the attention tier of the subject
 *     (`background`, `needs-you`, a lit `done`/`error`), the same frame the
 *     tab and the row paint from. One session is in one of the three: a chat
 *     with an Agent in background is never also "turn finished" (ATTN-01).
 *     Terminals are read through the roster so each row has a name: an id
 *     whose session is gone has no row and no tab, and its "1" would be
 *     unanswerable from anywhere.
 *
 * Exported for its unit test; the two hooks under it are the callers.
 */
export function activeAgentRowsFrom(
  roster: ReadonlyArray<AgentRosterEntry>,
  topics: Record<string, Topic>,
  sig: AgentActivitySlice,
): ActiveAgentRows {
  const working: ActiveAgentRow[] = [];
  const background: ActiveAgentRow[] = [];
  const awaitingInput: ActiveAgentRow[] = [];
  const finished: ActiveAgentRow[] = [];
  const place = (subject: string, row: ActiveAgentRow, streaming: boolean) => {
    const a = attentionOf(sig.attention, subject);
    if (a.tier === 'needs-you') awaitingInput.push(row);
    else if (a.lit) finished.push(row);
    else if (a.tier === 'background' && !streaming) background.push(row);
  };
  for (const t of roster) {
    // The exclusion is THE SHELL, not "everything but the three I remember":
    // written as a negated list it had already left out 'opencode', which
    // worked without ever showing among the active agents.
    if (t.type === 'shell') continue;
    const row: ActiveAgentRow = { id: t.id, kind: 'terminal', label: t.name };
    const loading = terminalLoadingFrom(t.id, sig.active, sig.busy, sig.resting);
    if (loading) working.push(row);
    place(`terminal:${t.id}`, row, loading);
  }
  // Chat sessions (distinct id space from terminals: no overlap).
  const streamingTopics = new Set<string>([...sig.liveStream, ...sig.hydratedStream]);
  for (const id of visibleTopicSignalIds(streamingTopics, topics)) {
    working.push({ id, kind: 'topic', label: topics[id].name });
  }
  const chatSubjects: string[] = [];
  for (const subject of sig.attention.keys()) if (subject.startsWith('topic:')) chatSubjects.push(subject.slice('topic:'.length));
  for (const id of visibleTopicSignalIds(chatSubjects, topics)) {
    place(`topic:${id}`, { id, kind: 'topic', label: topics[id].name }, streamingTopics.has(id));
  }
  return { working, background, awaitingInput, finished };
}

/** The agents at work: the number on the card's badge, counted from the same rows the menu lists. */
export function activeAgentCount(rows: Pick<ActiveAgentRows, 'working' | 'background'>): number {
  return rows.working.length + rows.background.length;
}

/** The rows behind the "Active agents" submenu and the card badge. See
 *  `activeAgentRowsFrom` for the rule. */
export function useActiveAgentRows(
  roster: ReadonlyArray<AgentRosterEntry>,
  topics: Record<string, Topic>,
): ActiveAgentRows {
  const sig = useAgentActivitySlice();
  return useMemo(() => activeAgentRowsFrom(roster, topics, sig), [roster, topics, sig]);
}

/**
 * Global live agent counts for the status bar, counted from the same rows the
 * menu lists (`activeAgentRowsFrom`), so the number cannot drift from what you
 * can see:
 *   - working       = sessions producing output right now;
 *   - awaiting      = sessions lit for the person: waiting for an answer, or
 *                     finished and not seen;
 *   - awaitingInput = the LOUD subset of `awaiting` (`needs-you`).
 */
export function useAgentActivityCounts(
  roster: ReadonlyArray<AgentRosterEntry>,
  topics: Record<string, Topic>,
): { working: number; awaiting: number; awaitingInput: number } {
  const sig = useAgentActivitySlice();
  return useMemo(() => {
    const rows = activeAgentRowsFrom(roster, topics, sig);
    return { working: rows.working.length, awaiting: rows.awaitingInput.length + rows.finished.length, awaitingInput: rows.awaitingInput.length };
  }, [roster, topics, sig]);
}
