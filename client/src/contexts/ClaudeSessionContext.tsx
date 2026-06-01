/**
 * ClaudeSessionContext — exposes the canonical lifecycle phase of every
 * tracked Claude Code session, keyed by the Topics topicId so consumers
 * (tab renderer, master strip, completion notifier) don't have to know
 * about sessionKey mapping.
 *
 * Wired from App.tsx after the useClaudeSessionState hook. Producers are
 * read-only — only the App owns the underlying state.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { ClaudeSessionPhase, ClaudeSessionState, Topic } from '../types';

interface ClaudeSessionContextValue {
  /** Phase for a topic, or undefined if there's no tracked Claude session. */
  getPhaseByTopicId: (topicId: string) => ClaudeSessionPhase | undefined;
  /** Full session state for a topic (richer info — pendingApproval, lastTool). */
  getStateByTopicId: (topicId: string) => ClaudeSessionState | undefined;
  /**
   * Aggregated phase across every topic associated with a project path:
   * picks the highest-priority phase among all tracked sessions whose
   * topic.projectPath matches. Used by the PaneTabBar to surface "a Claude
   * is running inside this project" on the project pane's tab even when
   * the user has navigated away from the inner chat tab.
   *
   * Priority (most attention-worthy first):
   *   awaiting-approval > error > awaiting-user > tool-running > running
   * Lower-attention phases (paused, completed, dormant, starting) are
   * intentionally treated as "none" so the project tab stays quiet for
   * sessions that don't need the user's eyes.
   */
  getAggregatedPhaseByProjectPath: (projectPath: string) => ClaudeSessionPhase | undefined;
}

const EMPTY_VALUE: ClaudeSessionContextValue = {
  getPhaseByTopicId: () => undefined,
  getStateByTopicId: () => undefined,
  getAggregatedPhaseByProjectPath: () => undefined,
};

const Ctx = createContext<ClaudeSessionContextValue>(EMPTY_VALUE);

interface ProviderProps {
  topics: Record<string, Topic>;
  sessions: ReadonlyMap<string, ClaudeSessionState>;
  children: ReactNode;
}

// Phase priority — see getAggregatedPhaseByProjectPath docstring. Higher
// number = louder; we pick the max across a project's topics.
const PHASE_WEIGHT: Partial<Record<ClaudeSessionPhase, number>> = {
  'awaiting-approval': 5,
  error: 4,
  // paused = a timed-out-but-unanswered approval (see NOTABLE_CLAUDE_PHASES);
  // ranks just under a fresh approval so a project tab still surfaces it.
  paused: 4,
  'awaiting-user': 3,
  'tool-running': 2,
  running: 1,
};

export function ClaudeSessionProvider({ topics, sessions, children }: ProviderProps) {
  // Pre-compute topicId → sessionKey map for O(1) lookups. Rebuilds when
  // either topics or sessions change.
  const byTopic = useMemo(() => {
    const m = new Map<string, ClaudeSessionState>();
    for (const t of Object.values(topics)) {
      if (!t.sessionKey) continue;
      const s = sessions.get(t.sessionKey);
      if (s) m.set(t.id, s);
    }
    return m;
  }, [topics, sessions]);

  // Pre-aggregate the per-project phase so the project tab can read it in
  // O(1). Rebuilds whenever the per-topic map changes (= a session
  // transition or a topic mutation). Empty projects produce no entry.
  const byProject = useMemo(() => {
    const m = new Map<string, ClaudeSessionPhase>();
    for (const t of Object.values(topics)) {
      if (!t.projectPath) continue;
      const state = byTopic.get(t.id);
      if (!state) continue;
      const weight = PHASE_WEIGHT[state.phase] ?? 0;
      if (weight === 0) continue;
      const existing = m.get(t.projectPath);
      const existingWeight = existing ? (PHASE_WEIGHT[existing] ?? 0) : 0;
      if (weight > existingWeight) m.set(t.projectPath, state.phase);
    }
    return m;
  }, [topics, byTopic]);

  const value = useMemo<ClaudeSessionContextValue>(() => ({
    getPhaseByTopicId: (topicId) => byTopic.get(topicId)?.phase,
    getStateByTopicId: (topicId) => byTopic.get(topicId),
    getAggregatedPhaseByProjectPath: (projectPath) => byProject.get(projectPath),
  }), [byTopic, byProject]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useClaudeSessionPhase(topicId: string | undefined): ClaudeSessionPhase | undefined {
  const ctx = useContext(Ctx);
  if (!topicId) return undefined;
  return ctx.getPhaseByTopicId(topicId);
}

export function useClaudeSessionForTopic(topicId: string | undefined): ClaudeSessionState | undefined {
  const ctx = useContext(Ctx);
  if (!topicId) return undefined;
  return ctx.getStateByTopicId(topicId);
}

/**
 * Highest-priority Claude phase across every topic in a project, or
 * undefined if no tracked Claude session in this project is in an
 * attention-worthy phase. Used by the project tab indicator.
 */
export function useClaudeProjectPhase(projectPath: string | undefined): ClaudeSessionPhase | undefined {
  const ctx = useContext(Ctx);
  if (!projectPath) return undefined;
  return ctx.getAggregatedPhaseByProjectPath(projectPath);
}
