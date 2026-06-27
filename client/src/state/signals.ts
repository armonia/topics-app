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
import { useMemo } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { Pane, Topic, TerminalSessionInfo, ClaudeSessionPhase, ClaudeSessionState } from '../types';
import { useTopics, useTerminalSessions } from '../contexts/TopicsContext';
import { getTerminalSessionFromPaneId, getProjectPathFromPaneId } from './pane/adapters';

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

/** Phases that mean "Claude is actively working".
 *
 *  The loading rule is a UNION, so it stays correct even where Claude Code
 *  hooks don't fire reliably (the phase machine then simply stays idle and
 *  contributes nothing):
 *    loading = ptyBusy OR phase is running/tool-running
 *  - ptyBusy (cosmetic-filtered, so the colour-only `/goal` statusline pulse
 *    doesn't count) is the always-available "something is happening" signal.
 *  - phase running/tool-running adds coverage when hooks DO fire (e.g. a quiet
 *    tool call that produces no pty output for a while).
 *  Crucially, an absent/stale phase never HIDES real pty activity — that was the
 *  flaw of the earlier suppression model when hooks were silent. */
export const ACTIVE_CLAUDE_PHASES: ReadonlySet<ClaudeSessionPhase> = new Set<ClaudeSessionPhase>([
  'running',
  'tool-running',
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
  agentActiveTopics: Set<string>;    // agent sessions active, by topic
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
  // (awaiting-user/-approval/paused) — subset of resting. Drives the blue
  // "awaiting feedback" fill on terminal tabs/rows, the terminal twin of
  // awaitingFeedbackTopics. By terminal session id.
  claudePhaseAwaitingTermIds: Set<string>;
  // attention inputs
  claudeAttentionTopics: Set<string>;   // chat Claude awaiting-*/error
  // chat Claude parked awaiting human input (awaiting-user/-approval/paused) —
  // the subset that drives the blue "awaiting feedback" tab/row fill. Separate
  // from claudeAttentionTopics because `error` belongs to the badge, not blue.
  awaitingFeedbackTopics: Set<string>;
  terminalFinishedIds: Set<string>;     // claude-code finished a turn, until the user looks
  terminalReloadingIds: Set<string>;    // a terminal is restarting (Ricarica), until it reconnects

  setTopicSet: (key: TopicSetKey, ids: Set<string>) => void;
  setBrowserBusy: (paneId: string, busy: boolean) => void;
  setTerminalBusy: (id: string, busy: boolean) => void;
  markTerminalFinished: (id: string) => void;
  clearTerminalFinished: (id: string) => void;
  markTerminalReloading: (id: string) => void;
  clearTerminalReloading: (id: string) => void;
  reconcileTerminals: (roster: TerminalRosterEntry[]) => void;
  setClaudePhaseTerminals: (active: Set<string>, resting: Set<string>, awaiting: Set<string>) => void;
}

/** Minimal shape the reconciler reads from the server session roster. */
export interface TerminalRosterEntry {
  id: string;
  busy?: boolean;
}

type TopicSetKey = 'liveStreamTopics' | 'hydratedStreamTopics' | 'agentActiveTopics' | 'claudeAttentionTopics' | 'awaitingFeedbackTopics';

function setsEqual(a: Set<string>, b: Set<string>): boolean {
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
  agentActiveTopics: new Set(),
  terminalBusyIds: new Set(),
  browserBusyPaneIds: new Set(),
  claudePhaseActiveTermIds: new Set(),
  claudePhaseRestingTermIds: new Set(),
  claudePhaseAwaitingTermIds: new Set(),
  claudeAttentionTopics: new Set(),
  awaitingFeedbackTopics: new Set(),
  terminalFinishedIds: new Set(),
  terminalReloadingIds: new Set(),

  setTopicSet: (key, ids) =>
    set((s) => (setsEqual(ids, s[key]) ? s : ({ [key]: ids } as Pick<SignalsState, TopicSetKey>))),

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

  setClaudePhaseTerminals: (active, resting, awaiting) =>
    set((s) => {
      const activeChanged = !setsEqual(active, s.claudePhaseActiveTermIds);
      const restingChanged = !setsEqual(resting, s.claudePhaseRestingTermIds);
      const awaitingChanged = !setsEqual(awaiting, s.claudePhaseAwaitingTermIds);
      if (!activeChanged && !restingChanged && !awaitingChanged) return s;
      return {
        ...(activeChanged ? { claudePhaseActiveTermIds: active } : {}),
        ...(restingChanged ? { claudePhaseRestingTermIds: resting } : {}),
        ...(awaitingChanged ? { claudePhaseAwaitingTermIds: awaiting } : {}),
      };
    }),
}));

// ---- Raw setters for App-level sync (stable references) ---------------------

export const signalsActions = {
  setLiveStreamTopics: (ids: Set<string>) => useSignalsStore.getState().setTopicSet('liveStreamTopics', ids),
  setHydratedStreamTopics: (ids: Set<string>) => useSignalsStore.getState().setTopicSet('hydratedStreamTopics', ids),
  setAgentActiveTopics: (ids: Set<string>) => useSignalsStore.getState().setTopicSet('agentActiveTopics', ids),
  setClaudeAttentionTopics: (ids: Set<string>) => useSignalsStore.getState().setTopicSet('claudeAttentionTopics', ids),
  setAwaitingFeedbackTopics: (ids: Set<string>) => useSignalsStore.getState().setTopicSet('awaitingFeedbackTopics', ids),
  setBrowserBusy: (paneId: string, busy: boolean) => useSignalsStore.getState().setBrowserBusy(paneId, busy),
  setTerminalBusy: (id: string, busy: boolean) => useSignalsStore.getState().setTerminalBusy(id, busy),
  markTerminalFinished: (id: string) => useSignalsStore.getState().markTerminalFinished(id),
  clearTerminalFinished: (id: string) => useSignalsStore.getState().clearTerminalFinished(id),
  markTerminalReloading: (id: string) => useSignalsStore.getState().markTerminalReloading(id),
  clearTerminalReloading: (id: string) => useSignalsStore.getState().clearTerminalReloading(id),
  reconcileTerminals: (roster: TerminalRosterEntry[]) => useSignalsStore.getState().reconcileTerminals(roster),
  setClaudePhaseTerminals: (active: Set<string>, resting: Set<string>, awaiting: Set<string>) => useSignalsStore.getState().setClaudePhaseTerminals(active, resting, awaiting),
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
 *   - active:  phase ∈ {running, tool-running} → drives the spinner.
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
): { active: Set<string>; resting: Set<string>; awaiting: Set<string> } {
  const active = new Set<string>();
  const resting = new Set<string>();
  // `awaiting` is a SUBSET of `resting` (AWAITING_FEEDBACK_PHASES ⊂
  // RESTING_CLAUDE_PHASES): the session is idle (no spinner) AND specifically
  // parked waiting for the user → drives the blue terminal-tab/row fill.
  const awaiting = new Set<string>();
  for (const ts of roster) {
    if (ts.type !== 'claude-code' && ts.type !== 'claude-code-team') continue;
    if (!ts.claudeSessionId) continue;
    const st = byCsid.get(ts.claudeSessionId);
    if (!st) continue;
    if (ACTIVE_CLAUDE_PHASES.has(st.phase)) active.add(ts.id);
    else if (RESTING_CLAUDE_PHASES.has(st.phase)) {
      resting.add(ts.id);
      if (AWAITING_FEEDBACK_PHASES.has(st.phase)) awaiting.add(ts.id);
    }
    // `starting` / unknown → neither set → pty heuristic decides.
  }
  return { active, resting, awaiting };
}

// ---- Key derivation --------------------------------------------------------

/** topicId for a chat pane — falls back to the pane id (top-level chat panes
 *  use the bare topic id as their pane id). */
function topicIdOf(pane: Pane): string | undefined {
  return pane.topicId ?? (pane.type === 'chat' ? pane.id : undefined);
}
/** terminal session id — derived from `terminal:<id>` when the field is unset. */
function terminalIdOf(pane: Pane): string | undefined {
  return pane.terminalSessionId ?? getTerminalSessionFromPaneId(pane.id) ?? undefined;
}
/** project path — derived from `project:<encoded>` when the field is unset. */
function projectPathOf(pane: Pane): string | undefined {
  return pane.projectPath ?? getProjectPathFromPaneId(pane.id) ?? undefined;
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
  const { live, hydrated, agent, term, phaseActive, phaseResting } = useSignalsStore(
    useShallow((s) => ({
      live: s.liveStreamTopics,
      hydrated: s.hydratedStreamTopics,
      agent: s.agentActiveTopics,
      term: s.terminalBusyIds,
      phaseActive: s.claudePhaseActiveTermIds,
      phaseResting: s.claudePhaseRestingTermIds,
    })),
  );
  return useMemo(() => {
    if (!projectPath) return false;
    for (const t of Object.values(topics)) {
      if (t.projectPath === projectPath && (live.has(t.id) || hydrated.has(t.id) || agent.has(t.id))) return true;
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
  }, [projectPath, topics, terminalSessions, live, hydrated, agent, term, phaseActive, phaseResting]);
}

/** Pure rollup: is any child of this project parked awaiting the user? A chat
 *  topic under the project in `awaitingTopics`, or a claude-code terminal whose
 *  cwd lives under it in `awaitingTerms`. Shared by the tab bar (synchronous, in
 *  the panes.map loop) and the sidebar (the hook below + the project row), so
 *  every awaiting surface agrees. Mirrors useProjectLoading's child-walk. */
export function projectHasAwaitingChild(
  projectPath: string,
  topics: Record<string, Topic>,
  terminalSessions: TerminalSessionInfo[],
  awaitingTopics: ReadonlySet<string>,
  awaitingTerms: ReadonlySet<string>,
): boolean {
  for (const t of Object.values(topics)) {
    if (t.projectPath === projectPath && awaitingTopics.has(t.id)) return true;
  }
  for (const ts of terminalSessions) {
    if (ts.type === 'shell') continue;
    if (!ts.cwd || !terminalBelongsToProject(ts.cwd, projectPath)) continue;
    if (awaitingTerms.has(ts.id)) return true;
  }
  return false;
}

/** Is this pane producing output right now? Single entry point for every
 *  loading indicator, dispatching by pane type with derived keys. */
export function usePaneLoading(pane: Pane): boolean {
  const projectLoading = useProjectLoading(pane.type === 'project' ? projectPathOf(pane) : undefined);
  const signals = useSignalsStore(
    useShallow((s) => ({
      live: s.liveStreamTopics,
      hydrated: s.hydratedStreamTopics,
      agent: s.agentActiveTopics,
      term: s.terminalBusyIds,
      browser: s.browserBusyPaneIds,
      phaseActive: s.claudePhaseActiveTermIds,
      phaseResting: s.claudePhaseRestingTermIds,
    })),
  );
  switch (pane.type) {
    case 'chat': {
      const tid = topicIdOf(pane);
      return !!tid && (signals.live.has(tid) || signals.hydrated.has(tid) || signals.agent.has(tid));
    }
    case 'terminal': {
      const sid = terminalIdOf(pane);
      return !!sid && terminalLoadingFrom(sid, signals.phaseActive, signals.term, signals.phaseResting);
    }
    case 'browser':
      return signals.browser.has(pane.id);
    case 'agents':
      return signals.agent.size > 0;
    case 'project':
      return projectLoading;
    default:
      return false;
  }
}

// ---- Id-based loading hooks (keep the spinner component API stable) ---------

/** A topic is loading if it has a live stream, hydrated mid-reply, or an
 *  active agent. */
export function useTopicLoading(topicId: string | undefined): boolean {
  return useSignalsStore((s) =>
    !!topicId && (s.liveStreamTopics.has(topicId) || s.hydratedStreamTopics.has(topicId) || s.agentActiveTopics.has(topicId)),
  );
}

/** A chat topic whose bound Claude session is parked awaiting human input
 *  (awaiting-user / awaiting-approval / paused) — drives the blue "awaiting
 *  feedback" tab/row fill. Distinct from loading (the spinner axis) and from
 *  the attention badge (which also counts `error` + unread). */
export function useTopicAwaitingFeedback(topicId: string | undefined): boolean {
  return useSignalsStore((s) => !!topicId && s.awaitingFeedbackTopics.has(topicId));
}

/** A terminal session is loading when its claude phase is active, or (for
 *  shells / not-yet-known phases) its pty is busy. A claude-code session at a
 *  resting phase never shows loading from pty alone — see terminalLoadingFrom. */
export function useTerminalLoading(sessionId: string | undefined): boolean {
  return useSignalsStore((s) =>
    !!sessionId && terminalLoadingFrom(sessionId, s.claudePhaseActiveTermIds, s.terminalBusyIds, s.claudePhaseRestingTermIds),
  );
}

/** A claude-code terminal session parked awaiting human input — the terminal
 *  twin of useTopicAwaitingFeedback. Drives the blue fill on terminal tabs/rows. */
export function useTerminalAwaitingFeedback(sessionId: string | undefined): boolean {
  return useSignalsStore((s) => !!sessionId && s.claudePhaseAwaitingTermIds.has(sessionId));
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

/** Any agent session active anywhere (global agents tab). */
export function useAnyAgentActive(): boolean {
  return useSignalsStore((s) => s.agentActiveTopics.size > 0);
}

/**
 * Global live agent counts for the status bar, counted from the SAME signals the
 * tab spinners and blue "awaiting" fills read — so the number can never drift
 * from what's on screen:
 *   - working  = claude/codex sessions producing output right now. A terminal
 *     counts via `terminalLoadingFrom` (phase-active OR pty-busy-and-not-resting)
 *     — crucially the pty-busy fallback means a session stuck at `starting`
 *     (hooks never advanced it) still counts, which raw phase counting missed —
 *     plus chat topics mid-stream (live or hydrated).
 *   - awaiting = sessions parked for the user (the blue-fill set): claude
 *     terminals awaiting + chat topics awaiting.
 *
 * `roster` is the authoritative terminal session list (App's `terminalSessions`)
 * — needed to enumerate which ids are claude/codex and apply the loading rule.
 */
export function useAgentActivityCounts(
  roster: ReadonlyArray<{ id: string; type: string }>,
): { working: number; awaiting: number } {
  const sig = useSignalsStore(
    useShallow((s) => ({
      active: s.claudePhaseActiveTermIds,
      resting: s.claudePhaseRestingTermIds,
      busy: s.terminalBusyIds,
      awaitingTerm: s.claudePhaseAwaitingTermIds,
      liveStream: s.liveStreamTopics,
      hydratedStream: s.hydratedStreamTopics,
      awaitingTopics: s.awaitingFeedbackTopics,
    })),
  );
  return useMemo(() => {
    let working = 0;
    for (const t of roster) {
      if (t.type !== 'claude-code' && t.type !== 'claude-code-team' && t.type !== 'codex') continue;
      if (terminalLoadingFrom(t.id, sig.active, sig.busy, sig.resting)) working++;
    }
    // Chat sessions mid-reply (distinct id space from terminals → no overlap).
    const streamingTopics = new Set<string>([...sig.liveStream, ...sig.hydratedStream]);
    working += streamingTopics.size;
    // Awaiting = the blue-fill set across both surfaces.
    const awaiting = sig.awaitingTerm.size + sig.awaitingTopics.size;
    return { working, awaiting };
  }, [roster, sig]);
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
  return Math.max(unread[topicId]?.unreadCount || 0, claudeAttentionTopics.has(topicId) ? 1 : 0);
}

/**
 * Attention count for a terminal session: a claude-code turn that finished and
 * hasn't been opened yet. Same source the tab bar and sidebar terminal rows
 * read, so the finished signal is one badge, not a dot here and a badge there.
 */
export function terminalAttentionCount(sid: string, terminalFinishedIds: Set<string>): number {
  return terminalFinishedIds.has(sid) ? 1 : 0;
}

/**
 * Project attention rollup: sum of child unread + Claude attention + finished
 * claude-code turns. Pure helper (not a hook) so both getProjectBadgeCount (tab
 * bar) and buildSidebarItems (sidebar project row) call it — guaranteeing the
 * project tab and the sidebar project row show the SAME summed count. Built on
 * the per-subject helpers above so there's one definition of "attention".
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
  for (const t of Object.values(topics)) {
    if (t.projectPath !== projectPath) continue;
    sum += topicAttentionCount(t.id, unread, claudeAttentionTopics);
  }
  if (terminalFinishedIds.size) {
    for (const ts of terminalSessions) {
      if (ts.cwd && terminalBelongsToProject(ts.cwd, projectPath)) sum += terminalAttentionCount(ts.id, terminalFinishedIds);
    }
  }
  return sum;
}

export { topicIdOf, terminalIdOf, projectPathOf };
