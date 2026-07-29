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
  /**
   * `terminalSessions` va creduto quando è VUOTO? Vedi `hooks/rosterTrust.ts`.
   * Serve SOLO a chi prende decisioni irreversibili sull'assenza di una sessione
   * (dichiarare scaduta una pane): chi mostra una lista può ignorarlo.
   * Default `false` — chi non passa dal provider non ha diritto di decidere.
   */
  terminalRosterAuthoritative: boolean;
  /** Workspace projects (paths) — what the server reports as
   *  `workspaceProjects` on the topics index endpoint. Optional because
   *  some older callers never hydrate it. */
  workspaceProjects?: string[];
}

const EMPTY_VALUE: TopicsContextValue = {
  topics: {},
  terminalSessions: [],
  terminalRosterAuthoritative: false,
};

const Ctx = createContext<TopicsContextValue>(EMPTY_VALUE);

interface ProviderProps {
  topics: Record<string, Topic>;
  terminalSessions: TerminalSessionInfo[];
  terminalRosterAuthoritative?: boolean;
  workspaceProjects?: string[];
  children: ReactNode;
}

export function TopicsProvider({ topics, terminalSessions, terminalRosterAuthoritative = false, workspaceProjects, children }: ProviderProps) {
  // Memoised wrapper so the context value identity changes only when an
  // input actually changes — prevents cascade re-renders across every
  // consumer when an unrelated piece of App state updates.
  const value = useMemo<TopicsContextValue>(() => ({
    topics,
    terminalSessions,
    terminalRosterAuthoritative,
    workspaceProjects,
  }), [topics, terminalSessions, terminalRosterAuthoritative, workspaceProjects]);

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

/**
 * Il roster dei terminali è stato confermato almeno una volta?
 *
 * Da guardare PRIMA di trattare l'assenza di una sessione come una morte: un
 * roster vuoto perche' non e' ancora arrivato ha lo stesso tipo di uno vuoto
 * perche' non c'e' piu' nulla, e confonderli fa comparire "Sessione scaduta" su
 * un terminale vivo. Vedi `hooks/rosterTrust.ts` per la regola.
 */
// eslint-disable-next-line react-refresh/only-export-components -- idiomatic Provider+hook colocation; the consumer hook belongs with its context
export function useTerminalRosterAuthoritative(): boolean {
  return useContext(Ctx).terminalRosterAuthoritative;
}
