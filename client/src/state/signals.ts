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
 *  Loading-ish phases (running / tool-running) surface as spinners instead. */
export const NOTABLE_CLAUDE_PHASES: ReadonlySet<ClaudeSessionPhase> = new Set<ClaudeSessionPhase>([
  'awaiting-approval',
  'awaiting-user',
  'error',
]);

// ---- Store -----------------------------------------------------------------

interface SignalsState {
  // loading inputs
  liveStreamTopics: Set<string>;     // useChat live stream (sessionKey resolved to topicId)
  hydratedStreamTopics: Set<string>; // server "mid-reply" (DB partial flag), survives reload
  agentActiveTopics: Set<string>;    // agent sessions active, by topic
  terminalBusyIds: Set<string>;      // server-tracked pty busy, by session id
  browserBusyPaneIds: Set<string>;   // browser panel loading/agent, by pane id
  // attention inputs
  claudeAttentionTopics: Set<string>;   // chat Claude awaiting-*/error
  terminalFinishedIds: Set<string>;     // claude-code finished a turn, until the user looks

  setTopicSet: (key: TopicSetKey, ids: Set<string>) => void;
  setBrowserBusy: (paneId: string, busy: boolean) => void;
  setTerminalBusy: (id: string, busy: boolean) => void;
  markTerminalFinished: (id: string) => void;
  clearTerminalFinished: (id: string) => void;
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

export const useSignalsStore = create<SignalsState>((set) => ({
  liveStreamTopics: new Set(),
  hydratedStreamTopics: new Set(),
  agentActiveTopics: new Set(),
  terminalBusyIds: new Set(),
  browserBusyPaneIds: new Set(),
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
};

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
  const { live, hydrated, agent, term } = useSignalsStore(
    useShallow((s) => ({
      live: s.liveStreamTopics,
      hydrated: s.hydratedStreamTopics,
      agent: s.agentActiveTopics,
      term: s.terminalBusyIds,
    })),
  );
  return useMemo(() => {
    if (!projectPath) return false;
    for (const t of Object.values(topics)) {
      if (t.projectPath === projectPath && (live.has(t.id) || hydrated.has(t.id) || agent.has(t.id))) return true;
    }
    if (term.size) {
      for (const ts of terminalSessions) {
        if (term.has(ts.id) && ts.cwd && terminalBelongsToProject(ts.cwd, projectPath)) return true;
      }
    }
    return false;
  }, [projectPath, topics, terminalSessions, live, hydrated, agent, term]);
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
    })),
  );
  switch (pane.type) {
    case 'chat': {
      const tid = topicIdOf(pane);
      return !!tid && (signals.live.has(tid) || signals.hydrated.has(tid) || signals.agent.has(tid));
    }
    case 'terminal': {
      const sid = terminalIdOf(pane);
      return !!sid && signals.term.has(sid);
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

/** A terminal session is loading if its pty is currently producing output. */
export function useTerminalLoading(sessionId: string | undefined): boolean {
  return useSignalsStore((s) => !!sessionId && s.terminalBusyIds.has(sessionId));
}

/** A browser pane is loading (page load or an agent driving it). */
export function useBrowserLoading(paneId: string | undefined): boolean {
  return useSignalsStore((s) => !!paneId && s.browserBusyPaneIds.has(paneId));
}

/** Any agent session active anywhere (global agents tab). */
export function useAnyAgentActive(): boolean {
  return useSignalsStore((s) => s.agentActiveTopics.size > 0);
}

/** Count of topics with a live/hydrated/agent stream — sidebar counter. */
export function useStreamingCount(): number {
  return useSignalsStore(
    useShallow((s) => {
      const all = new Set<string>([...s.liveStreamTopics, ...s.hydratedStreamTopics, ...s.agentActiveTopics]);
      return all.size;
    }),
  );
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
 * Project attention rollup: sum of child unread + Claude attention + finished
 * claude-code turns. Pure helper (not a hook) so getBadgeCount can call it with
 * the data it already holds.
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
    const u = unread[t.id]?.unreadCount || 0;
    const att = claudeAttentionTopics.has(t.id) ? 1 : 0;
    sum += Math.max(u, att);
  }
  if (terminalFinishedIds.size) {
    for (const ts of terminalSessions) {
      if (terminalFinishedIds.has(ts.id) && ts.cwd && terminalBelongsToProject(ts.cwd, projectPath)) sum += 1;
    }
  }
  return sum;
}

export { topicIdOf, terminalIdOf, projectPathOf };
