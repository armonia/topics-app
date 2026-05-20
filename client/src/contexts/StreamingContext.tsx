/**
 * StreamingContext — single source of truth for "this surface is producing
 * output right now" across every pane kind the app surfaces. Sits next to
 * ClaudeSessionContext in App.tsx; same provider pattern.
 *
 * Signal sources folded in:
 *   - chat       — live server-side stream (isSessionStreaming(sessionKey))
 *   - agent      — already-active agent sessions by topic (agentActivity,
 *                  HYDRATED at load; covers sessions running before mount)
 *   - project    — aggregation: ANY chat/agent inside the project is active
 *   - terminal   — client-side PTY pulse (useTerminalActivity)
 *
 * Consumers (tab bar, sidebar row, master strip, etc.) read via the
 * focused hooks — they never reach back to the raw inputs. Adding a new
 * pane kind with a loading signal means: extend the provider once, add a
 * matching hook + indicator widget, done.
 *
 * Project rollup split: chat streams roll up here (topics carry projectPath)
 * because the signal is global. NON-chat children (terminal / browser /
 * agent) live in the ProjectWindow's local state, so they roll up via the
 * `projectActivity` store instead — the mounted window reports its aggregate
 * and ProjectStreamingSpinner ORs the two sources. When you add a new
 * non-chat loading signal, fold it into ProjectWindow's `childLoading` + the
 * per-tab spinner; chat-shaped signals extend this provider.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { Topic } from '../types';
import { useTerminalActivity } from '../hooks/useTerminalActivity';
import { useAgentActivityStore } from '../state/agentActivity';
import { useStreamingHydrationStore } from '../state/streamingHydration';

interface StreamingContextValue {
  /** True iff this topic has an active server-side stream. */
  isTopicStreaming: (topicId: string) => boolean;
  /** True iff ANY topic with this projectPath has an active stream. */
  isProjectStreaming: (projectPath: string) => boolean;
  /** True iff this terminal session has produced output in the last ~1.5s. */
  isTerminalActive: (sessionId: string) => boolean;
  /** Total streaming topic count (used by the sidebar's small counter). */
  streamingCount: number;
}

const EMPTY_VALUE: StreamingContextValue = {
  isTopicStreaming: () => false,
  isProjectStreaming: () => false,
  isTerminalActive: () => false,
  streamingCount: 0,
};

const Ctx = createContext<StreamingContextValue>(EMPTY_VALUE);

interface ProviderProps {
  topics: Record<string, Topic>;
  /** Primitive from useSessions — sessionKey → boolean lookup. */
  isSessionStreaming: (sessionKey: string) => boolean;
  children: ReactNode;
}

export function StreamingProvider({ topics, isSessionStreaming, children }: ProviderProps) {
  // Pull terminal pulses from the existing global hook. Lives behind the
  // provider boundary so consumers don't have to know about it — they just
  // ask "is this pane loading?" via the focused selectors.
  const activeTerminalIds = useTerminalActivity();

  // Agent sessions that are active right now, keyed by topic. Unlike
  // isSessionStreaming (live `stream:start` events only — empty at load), this
  // is HYDRATED from useAgents' initial fetch, so a session that was already
  // running when the page opened still lights its topic + tab. Folding it in
  // here means every consumer (sidebar topic row, chat tab, project row)
  // reflects already-active sessions uniformly — no per-site wiring.
  const agentActiveTopicIds = useAgentActivityStore((s) => s.activeTopicIds);
  // Server-truth set of topics mid-reply (DB partial flag) — covers sessions
  // already streaming at page load, which the live map misses.
  const hydratedStreamingTopicIds = useStreamingHydrationStore((s) => s.topicIds);

  // Single pass over topics: build the streaming Sets. A topic counts as
  // streaming if it has a live chat stream, an already-active agent session,
  // or a server-reported in-progress reply (hydrated at load).
  const { streamingTopicIds, streamingProjects } = useMemo(() => {
    const topicIds = new Set<string>();
    const projects = new Set<string>();
    for (const t of Object.values(topics)) {
      const active = isSessionStreaming(t.sessionKey)
        || agentActiveTopicIds.has(t.id)
        || hydratedStreamingTopicIds.has(t.id);
      if (!active) continue;
      topicIds.add(t.id);
      if (t.projectPath) projects.add(t.projectPath);
    }
    return { streamingTopicIds: topicIds, streamingProjects: projects };
  }, [topics, isSessionStreaming, agentActiveTopicIds, hydratedStreamingTopicIds]);

  const value = useMemo<StreamingContextValue>(() => ({
    isTopicStreaming: (topicId) => streamingTopicIds.has(topicId),
    isProjectStreaming: (projectPath) => streamingProjects.has(projectPath),
    isTerminalActive: (sessionId) => activeTerminalIds.has(sessionId),
    streamingCount: streamingTopicIds.size,
  }), [streamingTopicIds, streamingProjects, activeTerminalIds]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** True iff this topic is currently producing a server-side stream. */
export function useTopicStreaming(topicId: string | undefined): boolean {
  const ctx = useContext(Ctx);
  if (!topicId) return false;
  return ctx.isTopicStreaming(topicId);
}

/** True iff ANY topic in this project has an active stream. */
export function useProjectStreaming(projectPath: string | undefined): boolean {
  const ctx = useContext(Ctx);
  if (!projectPath) return false;
  return ctx.isProjectStreaming(projectPath);
}

/** True iff this terminal session has produced output recently. */
export function useTerminalStreaming(sessionId: string | undefined): boolean {
  const ctx = useContext(Ctx);
  if (!sessionId) return false;
  return ctx.isTerminalActive(sessionId);
}

/** Total streaming topic count across the workspace. */
export function useStreamingCount(): number {
  const ctx = useContext(Ctx);
  return ctx.streamingCount;
}
