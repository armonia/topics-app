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
import type { ChannelPlace } from '../../../shared/channel-origin';

export type { ChannelPlace };

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
        // Only a real payload is worth caching: a non-ok response (or one with
        // no `titles`) must leave `titlesCache` unset so the next mount retries,
        // instead of freezing an empty object forever.
        if (!body?.titles) return;
        titlesCache = body.titles;
        if (alive) setTitles(titlesCache);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return titles;
}

let placesCache: Record<string, ChannelPlace> | null = null;

/** Where each chat/thread lives (Discord server, channel, thread title), read once per window:
 *  the Agents channel tree (Configure › Canali e chat) groups chats under their server with it. */
export function useChannelPlaces(): Record<string, ChannelPlace> {
  const [places, setPlaces] = useState<Record<string, ChannelPlace>>(placesCache ?? {});
  useEffect(() => {
    if (placesCache) return;
    let alive = true;
    void apiFetch('/api/agent-channels/places', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { places?: Record<string, ChannelPlace> } | null) => {
        if (!body?.places) return;
        placesCache = body.places;
        if (alive) setPlaces(placesCache);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return places;
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
