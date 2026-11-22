/**
 * CONFIGURE, ON ITS OWN PAGE (AGENTS-NAV-01, AGENTS-02).
 *
 * A column of sections (Identity, Craft, Channels and chats, People, Scheduled
 * jobs, Tools, Memory, Model and account, Received context, Files and
 * backup), each with its own address (`agentsNav.ts`), so a reload stays on
 * the same section instead of landing back on the first one. On a phone the
 * column is a list that opens the section (`sm:` breakpoint): there is no
 * room for both at once.
 */
import { useEffect, useState } from 'react';
import {
  Archive, Bot, Briefcase, Brain, Clock, MessageSquare, Settings2, Sparkles, Users, Wrench,
} from 'lucide-react';
import { useT } from '../../hooks/useT';
import { apiFetch } from '../../lib/shell/net';
import { useChannelPlaces, useChannelTitles } from '../../state/agentGroups';
import { FIELD, SAVE, AgentJobsSection, AgentModelSection, BTN } from './AgentConfigPieces';
import { ChannelTree } from './ChannelTree';
import { InheritedRow } from './InheritedRow';
import { CONFIGURE_SECTIONS, UNDERSTAND_SECTIONS, type ConfigureSection } from './configureSections';
import { useConfigSummary } from './configSummary';
import { CHANNEL_MARKS } from '../../lib/brandIcons';
import type { Registry } from '../../state/agentRegistry';
import { parseIdentity, writeIdentity } from '../../../../shared/agent-identity';

type Agent = Registry['agents'][number];
type Post = (kind: string, body: object) => Promise<boolean>;

const CHANNEL_BRAND: Record<string, string> = { discord: 'Discord', whatsapp: 'WhatsApp', telegram: 'Telegram' };


const SECTION_ICON: Record<ConfigureSection, typeof Bot> = {
  identity: Bot, job: Briefcase, channels: MessageSquare, people: Users, jobs: Clock,
  tools: Wrench, memory: Brain, model: Sparkles, context: Settings2, files: Archive,
};

function IdentitySection({ agent, post, onNavigate }: { agent: Agent; post: Post; onNavigate: (s: ConfigureSection) => void }) {
  const tr = useT();
  const [rules, setRules] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void apiFetch(`/api/agent-config/persona?agent=${encodeURIComponent(agent.id)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { layers?: { name: string; content: string }[] } | null) => {
        if (!alive) return;
        setRules(body?.layers?.find((l) => l.name === 'rules')?.content.trim() || '');
      })
      .catch(() => { if (alive) setRules(''); });
    return () => { alive = false; };
  }, [agent.id]);
  const identity = parseIdentity(agent.persona['IDENTITY.md'] ?? '');
  const [name, setName] = useState(identity.name);
  const [soul, setSoul] = useState(agent.persona['SOUL.md'] ?? '');
  const dirty = name !== identity.name || soul !== (agent.persona['SOUL.md'] ?? '');
  const save = () => {
    void post('persona', { agent: agent.id, file: 'IDENTITY.md', text: writeIdentity(agent.persona['IDENTITY.md'] ?? '', { name }) });
  };
  const saveSoul = () => void post('persona', { agent: agent.id, file: 'SOUL.md', text: soul });
  return (
    <div className="space-y-4">
      <label className="block text-mini text-app-text-secondary">{tr('agentConfig.identity.name')}
        <input data-testid="agent-identity-name" value={name} onChange={(e) => setName(e.target.value)} className={`mt-1 ${FIELD}`} />
      </label>
      {dirty && name !== identity.name && (
        <button type="button" data-testid="agent-identity-save" onClick={save} className={SAVE}>{tr('agentConfig.save')}</button>
      )}
      <ul>
        <InheritedRow
          title={tr('agentConfig.identity.soul')}
          badge={(agent.persona['SOUL.md'] ?? '').trim() ? tr('agentConfig.tree.own') : tr('agentConfig.inherited.fromBase')}
          detail={(
            <div className="space-y-2">
              <p>{tr('agentConfig.identity.soulBase')}: {tr('agentConfig.inherited.fromBase')}</p>
              <label className="block">{tr('agentConfig.identity.soulOwn')}
                <textarea data-testid="agent-soul-own" value={soul} onChange={(e) => setSoul(e.target.value)} rows={5} className={`mt-1 font-mono ${FIELD}`} placeholder={tr('agentConfig.inherited.soulEmpty')} />
              </label>
              <button type="button" data-testid="agent-soul-save" disabled={soul === (agent.persona['SOUL.md'] ?? '') || soul.trim().length < 20} onClick={saveSoul} className={SAVE}>{tr('agentConfig.save')}</button>
            </div>
          )}
          actionLabel={tr('agentConfig.inherited.override')}
          onAction={() => { /* the row's own «Vedi» already opens the editor above */ }}
        />
        <InheritedRow
          title={tr('agentConfig.inherited.rules')}
          badge={tr('agentConfig.inherited.fromUser')}
          detail={rules === null ? null : (rules || tr('agentConfig.inherited.soulEmpty'))}
          actionLabel={tr('agentConfig.inherited.view')}
          onAction={() => { /* read-only here: the user's rules are not an agent-level override */ }}
        />
        <InheritedRow
          title={tr('agentConfig.inherited.tools')}
          badge={tr('agentConfig.tools.all')}
          actionLabel={tr('agentConfig.inherited.filter')}
          onAction={() => onNavigate('tools')}
        />
        <InheritedRow
          title={tr('agentConfig.inherited.memory')}
          badge={tr('agentConfig.memory.own')}
          actionLabel={tr('agentConfig.inherited.filter')}
          onAction={() => onNavigate('memory')}
        />
      </ul>
    </div>
  );
}

function JobSection({ agent, post }: { agent: Agent; post: Post }) {
  const tr = useT();
  const identity = parseIdentity(agent.persona['IDENTITY.md'] ?? '');
  const [job, setJob] = useState(identity.job);
  return (
    <label className="block text-mini text-app-text-secondary">{tr('agentConfig.identity.job')}
      <input data-testid="agent-job-field" value={job} onChange={(e) => setJob(e.target.value)} className={`mt-1 ${FIELD}`} />
      <button
        type="button" data-testid="agent-job-field-save" disabled={job === identity.job} className={`mt-2 ${SAVE}`}
        onClick={() => void post('persona', { agent: agent.id, file: 'IDENTITY.md', text: writeIdentity(agent.persona['IDENTITY.md'] ?? '', { job }) })}
      >{tr('agentConfig.save')}</button>
    </label>
  );
}

function PeopleSection({ agent }: { agent: Agent }) {
  const tr = useT();
  const titles = useChannelTitles();
  const rows = agent.chats.filter((c) => c.chat !== '*' && (c.senders.length || c.denied.length));
  if (rows.length === 0) return <p className="text-mini text-app-text-muted">{tr('agentConfig.tree.noPeople')}</p>;
  return (
    <ul data-testid="agent-people" className="space-y-2">
      {rows.map((c) => {
        const Mark = CHANNEL_MARKS[CHANNEL_BRAND[c.channel] ?? ''];
        return (
          <li key={`${c.channel}:${c.chat}`} className="rounded border border-app-border-light p-2">
            <p className="flex items-center gap-1.5 text-mini font-semibold text-app-text">{Mark && <Mark className="h-3 w-3" aria-hidden />}{titles[c.chat] ?? c.chat}</p>
            {c.senders.map((id) => <p key={`w:${id}`} className="pl-4 text-mini text-app-text-secondary">{id} · {tr('agentConfig.tree.canWrite')}</p>)}
            {c.denied.map((id) => <p key={`d:${id}`} className="pl-4 text-mini text-app-text-secondary">{id} · {tr('agentConfig.tree.excluded')}</p>)}
          </li>
        );
      })}
    </ul>
  );
}

function ToolsRow({ agentId }: { agentId: string }) {
  const tr = useT();
  const [mode, setMode] = useState<'all' | 'selected' | null>(null);
  const [servers, setServers] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    let alive = true;
    void apiFetch(`/api/agent-tools?agent=${encodeURIComponent(agentId)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { filter?: { mode?: string; servers?: string[] }; servers?: { name: string }[] } | null) => {
        if (!alive || !body) return;
        setMode(body.filter?.mode === 'selected' ? 'selected' : 'all');
        setSelected(new Set(body.filter?.servers ?? []));
        setServers((body.servers ?? []).map((s) => s.name));
      })
      .catch(() => { if (alive) setMode('all'); });
    return () => { alive = false; };
  }, [agentId]);
  const save = (nextMode: 'all' | 'selected', nextServers: Set<string>) => {
    setMode(nextMode);
    void apiFetch('/api/agent-tools/agent-filter', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: agentId, mode: nextMode, servers: [...nextServers] }),
    });
  };
  if (mode === null) return <p className="text-mini text-app-text-muted">{tr('agentConfig.tools.loading')}</p>;
  return (
    <div data-testid="agent-tools-filter" className="space-y-2">
      <div className="flex gap-2">
        <button type="button" data-testid="agent-tools-all" onClick={() => save('all', selected)} className={mode === 'all' ? SAVE : BTN}>{tr('agentConfig.tools.all')}</button>
        <button type="button" data-testid="agent-tools-selected" onClick={() => save('selected', selected)} className={mode === 'selected' ? SAVE : BTN}>{tr('agentConfig.tools.selected')}</button>
      </div>
      {mode === 'selected' && (
        <ul className="space-y-1">
          {servers.map((name) => (
            <li key={name} className="flex items-center gap-2 text-mini text-app-text-secondary">
              <input
                type="checkbox" checked={selected.has(name)}
                onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(name); else next.delete(name);
                  setSelected(next);
                  save('selected', next);
                }}
              />
              {name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MemorySection({ agentId }: { agentId: string }) {
  const tr = useT();
  const [stores, setStores] = useState<{ id: string; scope: string }[] | null>(null);
  useEffect(() => {
    let alive = true;
    void apiFetch('/api/memory-stores', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { stores?: { id: string; owners?: string[]; scope?: string }[] } | null) => {
        if (!alive || !body) return;
        setStores((body.stores ?? []).filter((s) => !s.owners || s.owners.includes(agentId)).map((s) => ({ id: s.id, scope: s.scope ?? 'own' })));
      })
      .catch(() => { if (alive) setStores([]); });
    return () => { alive = false; };
  }, [agentId]);
  if (stores === null) return null;
  if (stores.length === 0) return <p className="text-mini text-app-text-muted">{tr('agentConfig.memory.none')}</p>;
  return (
    <ul data-testid="agent-memory-stores" className="space-y-1">
      {stores.map((s) => (
        <li key={s.id} className="flex items-center justify-between text-mini text-app-text-secondary">
          <span className="text-app-text">{s.id}</span>
          <span>{tr(`agentConfig.memory.${s.scope === 'shared' ? 'shared' : s.scope === 'readonly' ? 'readonly' : 'own'}` as 'agentConfig.memory.own')}</span>
        </li>
      ))}
    </ul>
  );
}

const CONTEXT_SNAPSHOT_KEY = (agentId: string) => `topics.agentContext.${agentId}`;

function ContextSection({ agentId }: { agentId: string }) {
  const tr = useT();
  const [layers, setLayers] = useState<{ name: string; tokens: number; files?: { name: string; tokens: number }[] }[] | null>(null);
  const [prev, setPrev] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    void apiFetch(`/api/agent-config/persona?agent=${encodeURIComponent(agentId)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { layers?: { name: string; tokens: number; files?: { name: string; tokens: number }[] }[] } | null) => {
        if (!alive || !body?.layers) return;
        const total = body.layers.reduce((s, l) => s + l.tokens, 0);
        try {
          const prevTotal = window.localStorage.getItem(CONTEXT_SNAPSHOT_KEY(agentId));
          setPrev(prevTotal === null ? null : Number(prevTotal));
          window.localStorage.setItem(CONTEXT_SNAPSHOT_KEY(agentId), String(total));
        } catch { /* no localStorage (private mode): just skip the comparison */ }
        setLayers(body.layers);
      })
      .catch(() => { if (alive) setLayers([]); });
    return () => { alive = false; };
  }, [agentId]);
  if (layers === null) return null;
  const total = layers.reduce((s, l) => s + l.tokens, 0);
  const delta = prev === null ? null : total - prev;
  return (
    <div data-testid="agent-context" className="space-y-2">
      <p data-testid="agent-context-total" className="text-prose text-app-text">{tr('agentConfig.context.tokens', { n: total })}</p>
      <p className="text-mini text-app-text-muted">
        {delta === null ? tr('agentConfig.context.vsPrev.none') : delta > 0 ? tr('agentConfig.context.vsPrev.more', { n: delta }) : delta < 0 ? tr('agentConfig.context.vsPrev.less', { n: -delta }) : tr('agentConfig.context.vsPrev.same')}
      </p>
      <ul className="space-y-1">
        {layers.map((l) => (
          <li key={l.name}>
            <p className="flex items-center justify-between text-mini text-app-text-secondary">
              <span className="text-app-text">{tr(`agentConfig.context.layer.${l.name}` as 'agentConfig.context.layer.base')}</span>
              <span>{tr('agentConfig.context.tokens', { n: l.tokens })}</span>
            </p>
            {l.files && l.files.length > 0 && (
              <ul className="ml-3">
                {l.files.map((f) => (
                  <li key={f.name} className="flex items-center justify-between text-mini text-app-text-muted">
                    <span>{f.name}</span><span>{tr('agentConfig.context.tokens', { n: f.tokens })}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FilesSection({ agent }: { agent: Agent }) {
  const tr = useT();
  return (
    <div className="space-y-1 text-mini text-app-text-secondary">
      <p>{tr('agentConfig.files.workspace')}: <span className="text-app-text">{agent.workspace.replace(/^\/Users\/[^/]+/, '~')}</span></p>
      <p className="text-app-text-muted">{tr('agentConfig.files.backups')}</p>
    </div>
  );
}

export function AgentConfigure({
  agent, allAgents, post, section, onSection,
}: {
  agent: Agent; allAgents: { id: string; name: string }[]; post: Post;
  section: ConfigureSection; onSection: (s: ConfigureSection) => void;
}) {
  const tr = useT();
  const titles = useChannelTitles();
  const places = useChannelPlaces();
  const [mobileOpen, setMobileOpen] = useState(false);

  const content = (() => {
    switch (section) {
      case 'identity': return <IdentitySection agent={agent} post={post} onNavigate={onSection} />;
      case 'job': return <JobSection agent={agent} post={post} />;
      case 'channels': return <ChannelTree agent={agent} post={post} allAgents={allAgents} titles={titles} places={places} />;
      case 'people': return <PeopleSection agent={agent} />;
      case 'jobs': return <AgentJobsSection agent={agent} post={post} />;
      case 'tools': return <ToolsRow agentId={agent.id} />;
      case 'memory': return <MemorySection agentId={agent.id} />;
      case 'model': return <AgentModelSection agent={agent} />;
      case 'context': return <ContextSection agentId={agent.id} />;
      case 'files': return <FilesSection agent={agent} />;
    }
  })();

  const summary = useConfigSummary(agent);

  return (
    <div data-testid="agent-configure" className="flex flex-col gap-4 sm:flex-row">
      <nav data-testid="agent-configure-nav" className={`w-full flex-shrink-0 sm:block sm:w-60 ${mobileOpen ? 'hidden' : ''}`}>
        <ul className="space-y-0.5">
          {CONFIGURE_SECTIONS.map((s) => {
            const Icon = SECTION_ICON[s];
            return (
              <li key={s}>
                {s === UNDERSTAND_SECTIONS[0] && <p data-testid="agent-configure-understand" className="px-2 pb-1 pt-3 text-mini font-semibold uppercase tracking-wide text-app-text-muted">{tr('agentConfig.understand')}</p>}
                <button
                  type="button" data-testid="agent-configure-section" aria-current={s === section}
                  onClick={() => { onSection(s); setMobileOpen(true); }}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-mini ${s === section ? 'bg-app-hover font-semibold text-app-text' : 'text-app-text-secondary hover:bg-app-hover'}`}
                >
                  <Icon size={13} className="flex-shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{tr(`agentConfig.section.${s}` as 'agentConfig.section.identity')}</span>
                  {summary[s] && <span data-testid="agent-configure-summary" className="flex-shrink-0 font-normal text-app-text-muted">{summary[s]}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <div data-testid="agent-configure-content" className={`min-w-0 flex-1 ${mobileOpen ? '' : 'hidden sm:block'}`}>
        <button type="button" data-testid="agent-configure-back" onClick={() => setMobileOpen(false)} className="mb-2 text-mini text-app-text-secondary hover:text-app-text sm:hidden">
          ← {tr(`agentConfig.section.${section}` as 'agentConfig.section.identity')}
        </button>
        {content}
      </div>
    </div>
  );
}
