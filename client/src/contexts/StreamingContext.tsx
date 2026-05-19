/**
 * StreamingContext — single source of truth for the "this surface is
 * actively producing output" signal across the app. Mirrors
 * ClaudeSessionContext's shape: provider takes raw inputs once at the top,
 * pre-computes per-topic + per-project aggregations, exposes hooks that
 * read in O(1).
 *
 * Without this, the same aggregation ("any topic in project P is mid-stream
 * via isSessionStreaming") had to be reimplemented at every surface — top
 * tab bar, sidebar topic row, sidebar project row, project pane tab. The
 * old layout drilled `isSessionStreaming` through five components and the
 * aggregation logic landed in two places that drifted independently.
 *
 * What's NOT in here: terminal PTY activity (lives in `useTerminalActivity`
 * — different semantics: client-side decayed pulse, not server-tracked
 * stream). The two are combined where they need to be (e.g. PaneTabBar's
 * `isPaneStreaming`).
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { Topic } from '../types';

interface StreamingContextValue {
  /** True iff this topic has an active server-side stream. */
  isTopicStreaming: (topicId: string) => boolean;
  /** True iff ANY topic with this projectPath has an active stream. */
  isProjectStreaming: (projectPath: string) => boolean;
  /** Total streaming topic count (used for the sidebar's small counter). */
  streamingCount: number;
  /**
   * Raw Set of streaming topic ids. Useful for consumers that already
   * iterate a list of pane ids (e.g. StandaloneChatGroup's
   * `streamingPaneIds` computation) and want an O(1) `has()` instead of
   * a function call per element.
   */
  streamingTopicIds: ReadonlySet<string>;
  /** Raw Set of project paths with at least one streaming topic. */
  streamingProjects: ReadonlySet<string>;
}

const EMPTY_VALUE: StreamingContextValue = {
  isTopicStreaming: () => false,
  isProjectStreaming: () => false,
  streamingCount: 0,
  streamingTopicIds: new Set(),
  streamingProjects: new Set(),
};

const Ctx = createContext<StreamingContextValue>(EMPTY_VALUE);

interface ProviderProps {
  topics: Record<string, Topic>;
  /** Primitive from useSessions — async sessionKey → boolean lookup. */
  isSessionStreaming: (sessionKey: string) => boolean;
  children: ReactNode;
}

export function StreamingProvider({ topics, isSessionStreaming, children }: ProviderProps) {
  // Single pass over topics: build (a) a Set of streaming topic ids,
  // (b) a Set of project paths with at least one streaming topic.
  // Re-runs only when topics or the stream-detector identity changes;
  // the detector is stable across renders (useCallback inside useSessions).
  const { streamingTopicIds, streamingProjects } = useMemo(() => {
    const topicIds = new Set<string>();
    const projects = new Set<string>();
    for (const t of Object.values(topics)) {
      if (!isSessionStreaming(t.sessionKey)) continue;
      topicIds.add(t.id);
      if (t.projectPath) projects.add(t.projectPath);
    }
    return { streamingTopicIds: topicIds, streamingProjects: projects };
  }, [topics, isSessionStreaming]);

  const value = useMemo<StreamingContextValue>(() => ({
    isTopicStreaming: (topicId) => streamingTopicIds.has(topicId),
    isProjectStreaming: (projectPath) => streamingProjects.has(projectPath),
    streamingCount: streamingTopicIds.size,
    streamingTopicIds,
    streamingProjects,
  }), [streamingTopicIds, streamingProjects]);

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

/** Total streaming topic count across the workspace. */
export function useStreamingCount(): number {
  const ctx = useContext(Ctx);
  return ctx.streamingCount;
}

/** Set view of streaming topic ids — for consumers that need O(1) `has()`. */
export function useStreamingTopicIds(): ReadonlySet<string> {
  return useContext(Ctx).streamingTopicIds;
}

/** Set view of project paths with at least one streaming chat. */
export function useStreamingProjectPaths(): ReadonlySet<string> {
  return useContext(Ctx).streamingProjects;
}
