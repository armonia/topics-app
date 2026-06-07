/**
 * TopicsContext — provides the workspace's top-level entities that
 * every UI surface needs: the topics map, the workspace project list,
 * and the terminal sessions list.
 *
 * Before this context the three values were prop-drilled four levels
 * deep (App → PanelGrid → StandaloneChatGroup/ProjectWindow → leaf)
 * with intermediate forwarders that didn't read them. Consumers now
 * pull from context; intermediates lose the prop entirely.
 *
 * Scope: shared, read-only entity caches. Mutators (createTopic,
 * archiveTopic, etc.) deliberately stay out — they remain wired
 * through call-site props because they have call-site-specific
 * semantics (deferred archive countdown, focus restoration, etc.).
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { Topic, TerminalSessionInfo } from '../types';

interface TopicsContextValue {
  topics: Record<string, Topic>;
  terminalSessions: TerminalSessionInfo[];
  /** Workspace projects (paths) — what the server reports as
   *  `workspaceProjects` on the topics index endpoint. Optional because
   *  some older callers never hydrate it. */
  workspaceProjects?: string[];
}

const EMPTY_VALUE: TopicsContextValue = {
  topics: {},
  terminalSessions: [],
};

const Ctx = createContext<TopicsContextValue>(EMPTY_VALUE);

interface ProviderProps {
  topics: Record<string, Topic>;
  terminalSessions: TerminalSessionInfo[];
  workspaceProjects?: string[];
  children: ReactNode;
}

export function TopicsProvider({ topics, terminalSessions, workspaceProjects, children }: ProviderProps) {
  // Memoised wrapper so the context value identity changes only when an
  // input actually changes — prevents cascade re-renders across every
  // consumer when an unrelated piece of App state updates.
  const value = useMemo<TopicsContextValue>(() => ({
    topics,
    terminalSessions,
    workspaceProjects,
  }), [topics, terminalSessions, workspaceProjects]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components -- idiomatic Provider+hook colocation; the consumer hook belongs with its context
export function useTopics(): Record<string, Topic> {
  return useContext(Ctx).topics;
}

// eslint-disable-next-line react-refresh/only-export-components -- idiomatic Provider+hook colocation; the consumer hook belongs with its context
export function useTerminalSessions(): TerminalSessionInfo[] {
  return useContext(Ctx).terminalSessions;
}
