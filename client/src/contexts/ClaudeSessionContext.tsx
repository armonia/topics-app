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
}

const EMPTY_VALUE: ClaudeSessionContextValue = {
  getPhaseByTopicId: () => undefined,
  getStateByTopicId: () => undefined,
};

const Ctx = createContext<ClaudeSessionContextValue>(EMPTY_VALUE);

interface ProviderProps {
  topics: Record<string, Topic>;
  sessions: ReadonlyMap<string, ClaudeSessionState>;
  children: ReactNode;
}

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

  const value = useMemo<ClaudeSessionContextValue>(() => ({
    getPhaseByTopicId: (topicId) => byTopic.get(topicId)?.phase,
    getStateByTopicId: (topicId) => byTopic.get(topicId),
  }), [byTopic]);

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
