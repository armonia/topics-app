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
import type { Pane, Topic, TerminalSessionInfo, ClaudeSessionPhase } from '../types';
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
  // attention inputs
  claudeAttentionTopics: Set<string>;   // chat Claude awaiting-*/error
  terminalFinishedIds: Set<string>;     // claude-code finished a turn, until the user looks

  setTopicSet: (key: TopicSetKey, ids: Set<string>) => void;
  setBrowserBusy: (paneId: string, busy: boolean) => void;
  setTerminalBusy: (id: string, busy: boolean) => void;
  markTerminalFinished: (id: string) => void;
  clearTerminalFinished: (id: string) => void;
  reconcileTerminals: (roster: TerminalRosterEntry[]) => void;
  setClaudePhaseTerminals: (active: Set<string>, resting: Set<string>) => void;
}

/** Minimal shape the reconciler reads from the server session roster. */
export interface TerminalRosterEntry {
  id: string;
  busy?: boolean;
}

type TopicSetKey = 'liveStreamTopics' | 'hydratedStreamTopics' | 'agentActiveTopics' | 'claudeAttentionTopics';

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

export const useSignalsStore = create<SignalsState>((set) => ({
  liveStreamTopics: new Set(),
  hydratedStreamTopics: new Set(),
  agentActiveTopics: new Set(),
  terminalBusyIds: new Set(),
  browserBusyPaneIds: new Set(),
  claudePhaseActiveTermIds: new Set(),
  claudePhaseRestingTermIds: new Set(),
  claudeAttentionTopics: new Set(),
  terminalFinishedIds: new Set(),

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

  reconcileTerminals: (roster) =>
    set((s) => {
      const { busy, finished } = reconcileTerminalSignals(s.terminalBusyIds, s.terminalFinishedIds, roster);
      if (busy === s.terminalBusyIds && finished === s.terminalFinishedIds) return s;
      return { terminalBusyIds: busy, terminalFinishedIds: finished };
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
}));

// ---- Raw setters for App-level sync (stable references) ---------------------

export const signalsActions = {
  setLiveStreamTopics: (ids: Set<string>) => useSignalsStore.getState().setTopicSet('liveStreamTopics', ids),
  setHydratedStreamTopics: (ids: Set<string>) => useSignalsStore.getState().setTopicSet('hydratedStreamTopics', ids),
  setAgentActiveTopics: (ids: Set<string>) => useSignalsStore.getState().setTopicSet('agentActiveTopics', ids),
  setClaudeAttentionTopics: (ids: Set<string>) => useSignalsStore.getState().setTopicSet('claudeAttentionTopics', ids),
  setBrowserBusy: (paneId: string, busy: boolean) => useSignalsStore.getState().setBrowserBusy(paneId, busy),
  setTerminalBusy: (id: string, busy: boolean) => useSignalsStore.getState().setTerminalBusy(id, busy),
  markTerminalFinished: (id: string) => useSignalsStore.getState().markTerminalFinished(id),
  clearTerminalFinished: (id: string) => useSignalsStore.getState().clearTerminalFinished(id),
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
 *   - active:  phase ∈ {running, tool-running} → drives the spinner.
 *   - resting: phase is KNOWN but not active → suppresses the pty heuristic
 *              (the session isn't working; its pty output is startup/idle paint).
 * A claude-code session with no phase entry yet appears in NEITHER set, so pty
 * still drives it (union fallback) until its first session:state lands. Plain
 * shells never appear here at all.
 */
export function derivePhaseTerminals(
  roster: TerminalRosterTypeEntry[],
  byCsid: Map<string, TerminalPhaseLite>,
): { active: Set<string>; resting: Set<string> } {
  const active = new Set<string>();
  const resting = new Set<string>();
  for (const ts of roster) {
    if (ts.type !== 'claude-code' && ts.type !== 'claude-code-team') continue;
    if (!ts.claudeSessionId) continue;
    const st = byCsid.get(ts.claudeSessionId);
    if (!st) continue;
    if (ACTIVE_CLAUDE_PHASES.has(st.phase)) active.add(ts.id);
    else resting.add(ts.id);
  }
  return { active, resting };
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
      if (!ts.cwd || !terminalBelongsToProject(ts.cwd, projectPath)) continue;
      if (terminalLoadingFrom(ts.id, phaseActive, term, phaseResting)) return true;
    }
    return false;
  }, [projectPath, topics, terminalSessions, live, hydrated, agent, term, phaseActive, phaseResting]);
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

/** A browser pane is loading (page load or an agent driving it). */
export function useBrowserLoading(paneId: string | undefined): boolean {
  return useSignalsStore((s) => !!paneId && s.browserBusyPaneIds.has(paneId));
}

/** Any agent session active anywhere (global agents tab). */
export function useAnyAgentActive(): boolean {
  return useSignalsStore((s) => s.agentActiveTopics.size > 0);
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
