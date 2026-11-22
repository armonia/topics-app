/**
 * ONE LINE PER CONFIGURE SECTION ("48 chat · 102 thread", "ereditati",
 * "12 tok"): shown at the right of each entry of the Configure column and,
 * as the "How it is made" box, on the agent's Activity page. Read once per
 * agent from the same endpoints the sections use, so a number here never
 * disagrees with the section it opens.
 */
import { useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import { apiFetch } from '../../lib/shell/net';
import { useChannelPlaces, type ChannelPlace } from '../../state/agentGroups';
import type { Registry } from '../../state/agentRegistry';
import type { ConfigureSection } from './configureSections';

type Agent = Registry['agents'][number];

interface Fetched { tools: 'all' | 'selected' | null; memory: number | null; contextTokens: number | null }

function useFetchedSummary(agentId: string): Fetched {
  const [fetched, setFetched] = useState<Fetched>({ tools: null, memory: null, contextTokens: null });
  useEffect(() => {
    let alive = true;
    const patch = (p: Partial<Fetched>) => { if (alive) setFetched((f) => ({ ...f, ...p })); };
    const get = (url: string) => apiFetch(url, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    void get(`/api/agent-tools?agent=${encodeURIComponent(agentId)}`).then((b: { filter?: { mode?: string } } | null) => b && patch({ tools: b.filter?.mode === 'selected' ? 'selected' : 'all' }));
    void get('/api/memory-stores').then((b: { stores?: { owners?: string[] }[] } | null) => b && patch({ memory: (b.stores ?? []).filter((s) => !s.owners || s.owners.includes(agentId)).length }));
    void get(`/api/agent-config/persona?agent=${encodeURIComponent(agentId)}`).then((b: { layers?: { tokens: number }[] } | null) => b?.layers && patch({ contextTokens: b.layers.reduce((s, l) => s + l.tokens, 0) }));
    return () => { alive = false; };
  }, [agentId]);
  return fetched;
}

function countThreads(agent: Agent, places: Record<string, ChannelPlace>): number {
  const chats = new Set(agent.chats.filter((c) => c.chat !== '*').map((c) => c.chat));
  return Object.keys(places).filter((k) => { const i = k.indexOf(':'); return i > 0 && chats.has(k.slice(0, i)); }).length;
}

function countPeople(agent: Agent): number {
  return new Set(agent.chats.flatMap((c) => [...c.senders, ...c.denied])).size;
}

/** The summary of each section, or null while it is still loading (nothing is shown rather than a zero). */
export function useConfigSummary(agent: Agent): Record<ConfigureSection, string | null> {
  const tr = useT();
  const places = useChannelPlaces();
  const f = useFetchedSummary(agent.id);
  const chats = agent.chats.filter((c) => c.chat !== '*').length;
  return {
    identity: null,
    job: null,
    channels: tr('agentConfig.summary.chats', { n: chats, t: countThreads(agent, places) }),
    people: tr('agentConfig.summary.people', { n: countPeople(agent) }),
    jobs: String(agent.jobs.length),
    tools: f.tools === null ? null : tr(f.tools === 'all' ? 'agentConfig.summary.toolsInherited' : 'agentConfig.summary.toolsFiltered'),
    memory: f.memory === null ? null : tr('agentConfig.summary.memory', { n: f.memory }),
    model: agent.model.engine ?? tr('agentConfig.summary.modelDefault'),
    context: f.contextTokens === null ? null : tr('agentConfig.summary.context', { n: f.contextTokens }),
    files: tr('agentConfig.summary.files', { n: Object.keys(agent.persona).length }),
  };
}
