/**
 * PANORAMICA AGENTI (AGENTS-01): "To fix" first (T7's
 * `/api/system/agents-health`, one button per row that opens the
 * destination), a card per agent (a mark per channel with ITS chat count,
 * at work / in error / last turn, Activity and Configure buttons), the
 * "New agent" card, then the activity list with its filters. At 375px the
 * cards stack in one column: no horizontal scroll.
 */
import { useEffect, useState } from 'react';
import { Bot, Plus, TriangleAlert } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { apiFetch } from '../../lib/shell/net';
import { DANGER_TEXT } from '../../lib/popoverStyles';
import { PALLINO_ATTESA, PALLINO_OK, SEGNALE_ATTESA, SEGNALE_OK } from '../Sidebar/chromeSignals';
import { FIELD, SAVE, BTN } from './AgentConfigPieces';
import { ActivityList } from './ActivityList';
import { ChannelMark } from './ChannelMark';
import { useAgentActivity, type ActivityTurn } from './useAgentActivity';
import { useAgo } from './useAgo';
import { healthSentence } from '../System/healthSentence';
import type { HealthProblem } from '../../../../shared/agents-health';
import type { ConfigureSection } from './configureSections';
import type { Registry } from '../../state/agentRegistry';

type Agent = Registry['agents'][number];


const SECTION_OF_HEALTH: Record<string, ConfigureSection> = {
  jobs: 'jobs', chats: 'channels', memory: 'memory', tools: 'tools', identity: 'identity', rules: 'identity', harness: 'context',
};

function useAgentsHealth(): HealthProblem[] {
  const [problems, setProblems] = useState<HealthProblem[]>([]);
  useEffect(() => {
    let alive = true;
    void apiFetch('/api/system/agents-health', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { problems?: HealthProblem[] } | null) => { if (alive && body?.problems) setProblems(body.problems); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return problems;
}

function contextWeight(agent: Agent): number {
  return Math.round((Object.values(agent.persona).join('').length) / 4);
}

/** Chats per channel, `*` (the channel default) not counted. */
function chatsPerChannel(agent: Agent): [string, number][] {
  const counts = new Map<string, number>();
  for (const a of agent.accounts) if (!counts.has(a.channel)) counts.set(a.channel, 0);
  for (const c of agent.chats) if (c.chat !== '*') counts.set(c.channel, (counts.get(c.channel) ?? 0) + 1);
  return [...counts.entries()];
}

function AgentCard({ agent, turns, onOpen, onConfigure }: { agent: Agent; turns: ActivityTurn[]; onOpen: () => void; onConfigure: () => void }) {
  const tr = useT();
  const ago = useAgo();
  const channels = chatsPerChannel(agent);
  const own = turns.filter((t) => t.agent === agent.id);
  const working = own.filter((t) => t.state === 'working').length;
  const failed = own.filter((t) => t.state === 'failed').length;
  const last = own[0];
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };
  return (
    <div
      data-testid="agent-overview-card" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}
      className="flex cursor-pointer flex-col gap-2 rounded-lg border border-app-border-light p-3 text-left hover:border-app-border"
    >
      <span className="flex items-center gap-2">
        <Bot size={16} className="flex-shrink-0 text-app-text-secondary" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-body-lg font-semibold text-app-text">{agent.name}</span>
        <button type="button" data-testid="agent-overview-activity" onClick={stop(onOpen)} className={BTN}>{tr('agents.tab.activity')}</button>
        <button type="button" data-testid="agent-overview-configure" onClick={stop(onConfigure)} className={BTN}>{tr('agents.tab.configure')}</button>
      </span>
      {agent.job && <span className="truncate text-mini text-app-text-secondary">{agent.job}</span>}
      {channels.length > 0 ? (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {channels.map(([ch, n]) => (
            <span key={ch} data-testid="agent-overview-channel" className="flex items-center gap-1 text-mini text-app-text-secondary">
              <ChannelMark channel={ch} className="h-3.5 w-3.5 text-app-text-secondary" />
              <span data-testid="agent-overview-chat-count">{n === 1 ? tr('agents.chatsCountOne') : tr('agents.chatsCount', { n })}</span>
            </span>
          ))}
        </span>
      ) : (
        <span data-testid="agent-overview-no-channels" className="text-mini text-app-text-muted">
          {tr('agents.noChannels')} · <span className="text-primary">{tr('agents.addChannel')}</span>
        </span>
      )}
      <span data-testid="agent-overview-state" className="flex flex-wrap items-center gap-x-3 text-mini text-app-text-muted">
        <span className="flex items-center gap-1">
          <span className={`h-2 w-2 rounded-full ${working ? PALLINO_ATTESA : PALLINO_OK}`} aria-hidden="true" />
          {working ? tr('agents.working', { n: working }) : tr('agents.state.idle')}
        </span>
        {failed > 0 && <span className={DANGER_TEXT}>{tr('agents.errors', { n: failed })}</span>}
        {last && <span>{tr('agents.lastTurn', { when: ago(last.created) })}</span>}
      </span>
      <span className="flex items-center gap-3 text-mini text-app-text-muted">
        <span>{tr('agentConfig.jobsAside', { on: agent.jobs.filter((j) => !j.paused).length, n: agent.jobs.length })}</span>
        <span data-testid="agent-overview-context">{tr('agents.contextWeight', { n: contextWeight(agent) })}</span>
      </span>
    </div>
  );
}

function NewAgentCard({ onCreated }: { onCreated: () => void }) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [job, setJob] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    const r = await apiFetch('/api/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, job }) });
    if (r.ok) { setOpen(false); setName(''); setJob(''); onCreated(); }
    else { const b = await r.json().catch(() => ({})); setError(b.error ?? String(r.status)); }
  };
  if (!open) {
    return (
      <button type="button" data-testid="agent-overview-new" onClick={() => setOpen(true)} className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-app-border-light p-3 text-app-text-secondary hover:border-app-border hover:text-app-text">
        <Plus size={18} aria-hidden="true" />
        <span className="text-prose">{tr('agents.newAgent')}</span>
      </button>
    );
  }
  return (
    <div data-testid="agent-overview-new-form" className="flex flex-col gap-2 rounded-lg border border-app-border-light p-3">
      <p className="text-mini text-app-text-muted">{tr('agents.newAgent.hint')}</p>
      <label className="block text-mini text-app-text-secondary">{tr('agents.newAgent.name')}
        <input data-testid="agent-new-name" value={name} onChange={(e) => setName(e.target.value)} className={`mt-1 ${FIELD}`} />
      </label>
      <label className="block text-mini text-app-text-secondary">{tr('agents.newAgent.job')}
        <input data-testid="agent-new-job" value={job} onChange={(e) => setJob(e.target.value)} className={`mt-1 ${FIELD}`} />
      </label>
      {error && <p className="text-mini text-red-500">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className={BTN} onClick={() => setOpen(false)}>{tr('agents.newAgent.cancel')}</button>
        <button type="button" data-testid="agent-new-create" disabled={!name.trim() || !job.trim()} className={SAVE} onClick={() => void create()}>{tr('agents.newAgent.create')}</button>
      </div>
    </div>
  );
}

export function AgentOverview({ reg, reload, onOpenAgent }: { reg: Registry; reload: () => void; onOpenAgent: (id: string, section?: ConfigureSection) => void }) {
  const tr = useT();
  const problems = useAgentsHealth();
  const { turns } = useAgentActivity();
  return (
    <div>
      <section className="mt-4">
        <h2 className="flex items-center gap-1.5 text-body-lg font-semibold text-app-text"><TriangleAlert size={14} className="text-app-text-secondary" aria-hidden="true" />{tr('agents.toFix')}</h2>
        {reg.health && (
          <span data-testid="agent-health" title={reg.health.text} className={`mt-1 flex items-center gap-1.5 text-mini ${reg.health.ok ? SEGNALE_OK : SEGNALE_ATTESA}`}>
            <span className={`h-2 w-2 rounded-full ${reg.health.ok ? PALLINO_OK : PALLINO_ATTESA}`} aria-hidden="true" />
            <span className="truncate">{reg.health.ok ? tr('agentConfig.healthy') : reg.health.text.replace(/^⚠️?\s*/, '')}</span>
          </span>
        )}
        {problems.length === 0 ? (
          <p className="mt-1 text-prose text-app-text-muted">{tr('agents.toFixEmpty')}</p>
        ) : (
          <ul data-testid="agent-overview-to-fix" className="mt-2 space-y-1">
            {problems.map((p) => (
              <li key={p.id} data-testid="agent-overview-to-fix-row" className="flex items-center gap-2 rounded border border-app-border-light px-2 py-1">
                <span className={`h-2 w-2 flex-shrink-0 rounded-full ${PALLINO_ATTESA}`} aria-hidden="true" />
                <span className="min-w-0 flex-1 text-prose text-app-text">{healthSentence(tr, p)}</span>
                {p.destination.agentId && (
                  <button
                    type="button" data-testid="agent-overview-to-fix-open" className={BTN}
                    onClick={() => onOpenAgent(p.destination.agentId!, SECTION_OF_HEALTH[p.destination.section])}
                  >{tr('agents.toFixOpen')}</button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div data-testid="agent-overview-cards" className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {reg.agents.map((a) => <AgentCard key={a.id} agent={a} turns={turns} onOpen={() => onOpenAgent(a.id)} onConfigure={() => onOpenAgent(a.id, 'identity')} />)}
        <NewAgentCard onCreated={reload} />
      </div>

      <ActivityList turns={turns} agents={reg.agents.map((a) => ({ id: a.id, name: a.name }))} />
    </div>
  );
}
