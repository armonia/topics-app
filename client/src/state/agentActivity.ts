/**
 * agentActivity — global set of topics with a currently-active agent session.
 *
 * Agent sessions are reported globally over the `agents:sessions` WS (see
 * useAgents). App owns the single live `useAgents` instance and `sync()`s the
 * active sessions here so any surface can ask "is an agent running?" without
 * re-subscribing:
 *   - the agents tab pulses when ANY agent is active (useAnyAgentActive)
 *   - a project tab pulses when an active agent's topic belongs to it
 *     (ProjectWindow maps the active topic ids through `topics[id].projectPath`)
 *
 * Sessions without a topicId still count toward `anyActive` (so the global
 * agents tab spins) but can't be attributed to a project.
 */
import { create } from 'zustand';

interface AgentActivityStore {
  /** Topic ids that have a currently-active agent session. */
  activeTopicIds: Set<string>;
  /** True iff at least one agent session is active (topic-bound or not). */
  anyActive: boolean;
  sync: (active: { topicId?: string }[]) => void;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export const useAgentActivityStore = create<AgentActivityStore>((set) => ({
  activeTopicIds: new Set(),
  anyActive: false,
  sync: (active) =>
    set((state) => {
      const nextTopics = new Set<string>();
      for (const s of active) if (s.topicId) nextTopics.add(s.topicId);
      const nextAny = active.length > 0;
      if (nextAny === state.anyActive && setsEqual(nextTopics, state.activeTopicIds)) {
        return state; // no-op — preserve identity, skip re-render
      }
      return { activeTopicIds: nextTopics, anyActive: nextAny };
    }),
}));

/** Reactive: is any agent session active anywhere? */
export function useAnyAgentActive(): boolean {
  return useAgentActivityStore((s) => s.anyActive);
}

/** Non-reactive read of the active-topic set (for project rollup passes). */
export function getActiveAgentTopicIds(): Set<string> {
  return useAgentActivityStore.getState().activeTopicIds;
}
