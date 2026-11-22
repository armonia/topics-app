/**
 * PANORAMICA AGENTI (AGENTS-01): a card per agent with its channel marks and
 * chat count, a «Da sistemare» list (T7's `/api/system/agents-health`, linked
 * into the right Configure section) and a «Nuovo agente» card. At 375px the
 * cards stack in one column — no horizontal scroll (the acceptance scenario
 * tests this width specifically).
 */
import { useEffect, useState } from 'react';
import { Bot, Plus, TriangleAlert } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { apiFetch } from '../../lib/shell/net';
import { CHANNEL_MARKS } from '../../lib/brandIcons';
import { PALLINO_ATTESA, PALLINO_OK, SEGNALE_ATTESA, SEGNALE_OK } from '../Sidebar/chromeSignals';
import { FIELD, SAVE, BTN } from './AgentConfigPieces';
import type { ConfigureSection } from './AgentConfigure';
import type { Registry } from '../../state/agentRegistry';

type Agent = Registry['agents'][number];
const CHANNEL_BRAND: Record<string, string> = { discord: 'Discord', whatsapp: 'WhatsApp', telegram: 'Telegram' };

interface HealthProblem { id: string; sentence: string; destination: { section: string; agentId?: string } }

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

function AgentCard({ agent, onOpen }: { agent: Agent; onOpen: () => void }) {
  const tr = useT();
  const channels = [...new Set(agent.accounts.map((a) => a.channel))];
  const chatCount = agent.chats.filter((c) => c.chat !== '*').length;
  return (
    <button type="button" data-testid="agent-overview-card" onClick={onOpen} className="flex flex-col gap-2 rounded-lg border border-app-border-light p-3 text-left hover:border-app-border">
      <span className="flex items-center gap-2">
        <Bot size={16} className="text-app-text-secondary" aria-hidden="true" />
        <span className="truncate text-body-lg font-semibold text-app-text">{agent.name}</span>
      </span>
      {agent.job && <span className="truncate text-mini text-app-text-secondary">{agent.job}</span>}
      {channels.length > 0 ? (
        <span className="flex items-center gap-2">
          <span className="flex items-center gap-1">
            {channels.map((ch) => { const Mark = CHANNEL_MARKS[CHANNEL_BRAND[ch] ?? '']; return Mark ? <Mark key={ch} className="h-3.5 w-3.5 text-app-text-secondary" aria-hidden /> : null; })}
          </span>
          <span data-testid="agent-overview-chat-count" className="text-mini text-app-text-muted">
            {chatCount === 1 ? tr('agents.chatsCountOne') : tr('agents.chatsCount', { n: chatCount })}
          </span>
        </span>
      ) : (
        <span data-testid="agent-overview-no-channels" className="text-mini text-app-text-muted">
          {tr('agents.noChannels')} · <span className="text-primary">{tr('agents.addChannel')}</span>
        </span>
      )}
      <span className="flex items-center gap-3 text-mini text-app-text-muted">
        <span>{tr('agentConfig.jobsAside', { on: agent.jobs.filter((j) => !j.paused).length, n: agent.jobs.length })}</span>
        <span data-testid="agent-overview-context">{tr('agents.contextWeight', { n: contextWeight(agent) })}</span>
      </span>
    </button>
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
  return (
    <div>
      {reg.health && (
        <span data-testid="agent-health" title={reg.health.text} className={`mb-2 flex items-center gap-1.5 text-mini ${reg.health.ok ? SEGNALE_OK : SEGNALE_ATTESA}`}>
          <span className={`h-2 w-2 rounded-full ${reg.health.ok ? PALLINO_OK : PALLINO_ATTESA}`} aria-hidden="true" />
          <span className="truncate">{reg.health.ok ? tr('agentConfig.healthy') : reg.health.text.replace(/^⚠️?\s*/, '')}</span>
        </span>
      )}
      <div data-testid="agent-overview-cards" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {reg.agents.map((a) => <AgentCard key={a.id} agent={a} onOpen={() => onOpenAgent(a.id)} />)}
        <NewAgentCard onCreated={reload} />
      </div>

      <section className="mt-6">
        <h2 className="flex items-center gap-1.5 text-body-lg font-semibold text-app-text"><TriangleAlert size={14} className="text-app-text-secondary" aria-hidden="true" />{tr('agents.toFix')}</h2>
        {problems.length === 0 ? (
          <p className="mt-1 text-prose text-app-text-muted">{tr('agents.toFixEmpty')}</p>
        ) : (
          <ul data-testid="agent-overview-to-fix" className="mt-2 space-y-1">
            {problems.map((p) => (
              <li key={p.id}>
                <button
                  type="button" className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-prose text-app-text hover:bg-app-hover"
                  onClick={() => { if (p.destination.agentId) onOpenAgent(p.destination.agentId, SECTION_OF_HEALTH[p.destination.section]); }}
                >
                  <span className={`h-2 w-2 flex-shrink-0 rounded-full ${PALLINO_ATTESA}`} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{p.sentence}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

