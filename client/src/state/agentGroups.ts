/**
 * The agents' sessions grouped by agent, live: the topics of the store and the
 * same working / waiting rows the agents menu counts, so the «Agenti» row and
 * the status bar never disagree on who is at work.
 */
import { useMemo } from 'react';
import { useTopics, useTerminalSessions } from '../contexts/TopicsContext';
import { useActiveAgentRows } from './signals';
import { groupAgentSessions, type AgentGroup } from '../lib/agentSessions';

export function useAgentGroups(): AgentGroup[] {
  const topics = useTopics();
  const rows = useActiveAgentRows(useTerminalSessions(), topics);
  return useMemo(() => {
    const ids = (list: { id: string; kind: string }[]) => new Set(list.filter((r) => r.kind === 'topic').map((r) => r.id));
    return groupAgentSessions(topics, ids(rows.working), ids(rows.awaitingInput));
  }, [topics, rows]);
}
