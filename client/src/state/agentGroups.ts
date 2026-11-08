/**
 * The agents' sessions grouped by agent, live: the topics of the store and the
 * same working / waiting rows the agents menu counts, so the «Agenti» row and
 * the status bar never disagree on who is at work. A session whose last
 * message is a failure is marked from its preview; chats named after a raw
 * channel id take the channel's title from `/api/agent-channels`.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTopics, useTerminalSessions } from '../contexts/TopicsContext';
import { useActiveAgentRows } from './signals';
import { getTopicPreview } from './topicPreviews';
import { apiFetch } from '../lib/shell/net';
import { agentTopicIds, groupAgentSessions, isErrorText, type AgentGroup } from '../lib/agentSessions';

let titlesCache: Record<string, string> | null = null;

/** The channel titles, read once per window: they change when a channel is renamed. */
export function useChannelTitles(): Record<string, string> {
  const [titles, setTitles] = useState<Record<string, string>>(titlesCache ?? {});
  useEffect(() => {
    if (titlesCache) return;
    let alive = true;
    void apiFetch('/api/agent-channels', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { titles?: Record<string, string> } | null) => {
        titlesCache = body?.titles ?? {};
        if (alive) setTitles(titlesCache);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return titles;
}

export function useAgentGroups(): AgentGroup[] {
  const topics = useTopics();
  const terminals = useTerminalSessions();
  const rows = useActiveAgentRows(terminals, topics);
  return useMemo(() => {
    // Topic and terminal ids together: the terminal sub-agents of an agent count too.
    const ids = (list: { id: string }[]) => new Set(list.map((r) => r.id));
    const errored = new Set<string>();
    for (const id of agentTopicIds(topics)) {
      const p = getTopicPreview(id);
      if (p && p.role !== 'user' && isErrorText(p.text)) errored.add(id);
    }
    return groupAgentSessions(topics, ids(rows.working), ids(rows.awaitingInput), errored, terminals);
  }, [topics, rows, terminals]);
}
