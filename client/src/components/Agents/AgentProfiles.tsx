/**
 * AGENT PROFILE: the registry card of an always-on agent (Jarvis, Visione):
 * health, personality, accounts, chats with their rules, model and scheduled
 * jobs, read from jarvis-channels through `/api/agent-config`. The switches
 * write back to the right file (the server backs it up first and reloads the
 * service); the personality is edited in place and saved explicitly.
 * Switches follow Bruno Delorence's «Weekly hours» pattern: one switch per row.
 * A row opens into its fields where it stands («Row editor»): a chat's own
 * instructions and who may write, a job's schedule.
 */
import { Fragment, useMemo, useState } from 'react';
import { Activity, Bot, Pencil, Users, CalendarClock, MessagesSquare, Sparkles, TriangleAlert, UserRound } from 'lucide-react';
import { apiFetch } from '../../lib/shell/net';
import { useT } from '../../hooks/useT';
import { Select } from '../Shared/Select';
import { useChannelTitles } from '../../state/agentGroups';
import { DANGER_TEXT } from '../../lib/popoverStyles';
import { PALLINO_ATTESA, PALLINO_OK, SEGNALE_ATTESA, SEGNALE_OK } from '../Sidebar/chromeSignals';

import type { Registry } from '../../state/agentRegistry';
type Agent = Registry['agents'][number];
type Chat = Agent['chats'][number];
type Job = Agent['jobs'][number];
type Post = (kind: string, body: object) => Promise<boolean>;

const FIELD = 'w-full rounded border border-app-border-light bg-surface px-2 py-1 text-mini text-app-text';
const BTN = 'rounded px-2 py-1 text-mini text-app-text-secondary hover:bg-app-hover';
const SAVE = 'rounded bg-primary px-2 py-1 text-mini text-white disabled:opacity-40';

function ChatEditor({ c, post, close }: { c: Chat; post: Post; close: () => void }) {
  const tr = useT();
  const [system, setSystem] = useState(c.system);
  const [senders, setSenders] = useState(c.senders.join(', '));
  const save = async () => {
    const ok = await post('chat', { channel: c.channel, chat: c.chat, account: c.account, system, senders: senders.split(/[\s,]+/).filter(Boolean) });
    if (ok) close();
  };
  return (
    <div data-testid="agent-chat-editor" className="space-y-2 rounded border border-app-border-light p-2">
      <label className="block text-mini text-app-text-secondary">{tr('agentConfig.chatSystem')}
        <textarea data-testid="agent-chat-system" value={system} onChange={(e) => setSystem(e.target.value)} rows={5} className={`mt-1 font-mono ${FIELD}`} />
      </label>
      <label className="block text-mini text-app-text-secondary">{tr('agentConfig.chatSenders')}
        <input data-testid="agent-chat-senders" value={senders} onChange={(e) => setSenders(e.target.value)} placeholder={tr('agentConfig.chatSendersHint')} className={`mt-1 ${FIELD}`} />
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={close} className={BTN}>{tr('agentConfig.undo')}</button>
        <button type="button" data-testid="agent-chat-save" onClick={() => void save()} className={SAVE}>{tr('agentConfig.save')}</button>
      </div>
    </div>
  );
}

function JobEditor({ j, post, close }: { j: Job; post: Post; close: () => void }) {
  const tr = useT();
  const s = j.rawSchedule;
  const [kind, setKind] = useState<'cron' | 'every' | 'at'>(s?.kind === 'every' ? 'every' : s?.kind === 'at' ? 'at' : 'cron');
  const [expr, setExpr] = useState(s?.expr ?? '0 9 * * *');
  const [minutes, setMinutes] = useState(String(s?.minutes ?? 30));
  const [at, setAt] = useState(s?.at ?? '');
  const save = async () => {
    const schedule = kind === 'cron' ? { kind, expr: expr.trim(), tz: s?.tz ?? 'Europe/Rome' } : kind === 'every' ? { kind, minutes: Number(minutes) } : { kind, at };
    if (await post('job', { id: j.id, schedule })) close();
  };
  return (
    <div data-testid="agent-job-editor" className="flex flex-wrap items-center gap-2 rounded border border-app-border-light p-2">
      <Select<'cron' | 'every' | 'at'>
        value={kind}
        onChange={setKind}
        ariaLabel={tr('agentConfig.editWhen')}
        options={[{ value: 'cron', label: tr('agentConfig.when.cron') }, { value: 'every', label: tr('agentConfig.when.every') }, { value: 'at', label: tr('agentConfig.when.at') }]}
      />
      {kind === 'cron' && <input data-testid="agent-job-cron" value={expr} onChange={(e) => setExpr(e.target.value)} className={`w-40 font-mono ${FIELD}`} />}
      {kind === 'every' && <input type="number" min={1} value={minutes} onChange={(e) => setMinutes(e.target.value)} className={`w-20 ${FIELD}`} />}
      {kind === 'every' && <span className="text-mini text-app-text-muted">{tr('agentConfig.when.minutes')}</span>}
      {kind === 'at' && <input value={at} onChange={(e) => setAt(e.target.value)} placeholder="2026-11-12T09:00" className={`w-48 ${FIELD}`} />}
      <span className="ml-auto flex gap-2">
        <button type="button" onClick={close} className={BTN}>{tr('agentConfig.undo')}</button>
        <button type="button" data-testid="agent-job-save" onClick={() => void save()} className={SAVE}>{tr('agentConfig.save')}</button>
      </span>
    </div>
  );
}

function Switch({ on, label, onChange, testId }: { on: boolean; label: string; onChange: (v: boolean) => void; testId?: string }) {
  return (
    <button
      type="button" role="switch" aria-checked={on} aria-label={label} title={label} data-testid={testId}
      onClick={() => onChange(!on)}
      className={`relative h-4 w-7 flex-shrink-0 rounded-full transition-colors ${on ? 'bg-primary' : 'bg-app-text-muted/40'}`}
    >
      <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
    </button>
  );
}

function Section({ icon: Icon, title, aside, children }: { icon: typeof Bot; title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mt-4 rounded-lg border border-app-border-light">
      <header className="flex items-center gap-2 border-b border-app-border-light px-3 py-2">
        <Icon size={14} className="text-app-text-secondary" aria-hidden="true" />
        <h3 className="text-body font-semibold text-app-text">{title}</h3>
        <span className="ml-auto text-mini text-app-text-muted">{aside}</span>
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

export function AgentProfiles({ reg, reload }: { reg: Registry; reload: () => void }) {
  const tr = useT();
  const titles = useChannelTitles();
  const [sel, setSel] = useState(reg.agents[0]?.id ?? 'main');
  const [note, setNote] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [file, setFile] = useState('IDENTITY.md');
  const [editing, setEditing] = useState<string | null>(null);
  const agent = reg.agents.find((a) => a.id === sel) ?? reg.agents[0];
  // A draft belongs to one agent and one file: changing either starts again from the saved text.
  const [edit, setEdit] = useState<{ key: string; text: string } | null>(null);
  const draftKey = `${agent?.id}:${file}:${agent?.persona[file] ?? ''}`;
  const draft = edit?.key === draftKey ? edit.text : agent?.persona[file] ?? '';
  const setDraft = (text: string) => setEdit({ key: draftKey, text });

  const post = async (kind: string, body: object) => {
    const r = await apiFetch(`/api/agent-config/${kind}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const b = await r.json().catch(() => ({}));
    setNote(r.ok ? tr(`agentConfig.saved.${b.service ?? 'live'}`) : `${tr('agentConfig.error')}: ${b.error ?? r.status}`);
    reload();
    return r.ok;
  };

  const chats = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (agent?.chats ?? []).filter((c) => !q || `${titles[c.chat] ?? ''} ${c.chat} ${c.channel}`.toLowerCase().includes(q));
  }, [agent, filter, titles]);
  if (!agent) return null;
  const issues = reg.issues.filter((i) => i.agent === agent.id || i.agent === null);
  const chatName = (c: Chat) => (c.chat === '*' ? tr('agentConfig.allChats', { channel: c.channel }) : titles[c.chat] ?? `${c.channel} ${c.chat}`);
  const models = Object.entries(agent.model.perChannel);

  return (
    <div data-testid="agent-profiles" className="mt-6">
      <div className="flex items-center gap-1 border-b border-app-border-light" role="tablist">
        {reg.agents.map((a) => (
          <button
            key={a.id} type="button" role="tab" aria-selected={a.id === agent.id} data-testid="agent-tab"
            onClick={() => { setSel(a.id); setNote(null); }}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-body ${a.id === agent.id ? 'border-primary font-semibold text-app-text' : 'border-transparent text-app-text-secondary hover:text-app-text'}`}
          >
            <Bot size={14} aria-hidden="true" />{a.name}
          </button>
        ))}
        {reg.health && (
          <span data-testid="agent-health" title={reg.health.text} className={`ml-auto flex items-center gap-1.5 text-mini ${reg.health.ok ? SEGNALE_OK : SEGNALE_ATTESA}`}>
            <span className={`h-2 w-2 rounded-full ${reg.health.ok ? PALLINO_OK : PALLINO_ATTESA}`} aria-hidden="true" />
            <span className="max-w-[22rem] truncate">{reg.health.ok ? tr('agentConfig.healthy') : reg.health.text.replace(/^⚠️?\s*/, '')}</span>
          </span>
        )}
      </div>

      {note && <p data-testid="agent-note" className="mt-3 text-mini text-app-text-secondary">{note}</p>}

      {issues.length > 0 && (
        <Section icon={TriangleAlert} title={tr('agentConfig.issues')} aside={String(issues.length)}>
          <ul data-testid="agent-issues" className="space-y-1">
            {issues.slice(0, 4).map((i) => <li key={i.text} className={`text-mini ${DANGER_TEXT}`}>{i.text.replace(/^discord:(\d+)/, (_m, id) => titles[id] ?? `discord ${id}`)}</li>)}
            {issues.length > 4 && <li className="text-mini text-app-text-muted">{tr('agentConfig.moreIssues', { n: issues.length - 4 })}</li>}
          </ul>
        </Section>
      )}

      <Section icon={UserRound} title={tr('agentConfig.persona')} aside={agent.workspace.replace(/^\/Users\/[^/]+/, '~')}>
        <div className="mb-2 flex gap-1">
          {Object.keys(agent.persona).map((f) => (
            <button key={f} type="button" onClick={() => setFile(f)}
              className={`rounded px-2 py-0.5 text-mini ${f === file ? 'bg-app-hover text-app-text' : 'text-app-text-secondary hover:bg-app-hover'}`}>{f.replace('.md', '')}</button>
          ))}
        </div>
        <textarea
          data-testid="agent-persona" value={draft} onChange={(e) => setDraft(e.target.value)} rows={7}
          className="w-full resize-y rounded border border-app-border-light bg-surface p-2 font-mono text-mini text-app-text"
        />
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" disabled={draft === agent.persona[file]} onClick={() => setDraft(agent.persona[file] ?? '')}
            className="rounded px-2 py-1 text-mini text-app-text-secondary hover:bg-app-hover disabled:opacity-40">{tr('agentConfig.undo')}</button>
          <button type="button" data-testid="agent-persona-save" disabled={draft === agent.persona[file]} onClick={() => void post('persona', { agent: agent.id, file, text: draft })}
            className="rounded bg-primary px-2 py-1 text-mini text-white disabled:opacity-40">{tr('agentConfig.save')}</button>
        </div>
      </Section>

      <Section icon={Sparkles} title={tr('agentConfig.model')}>
        <p className="text-mini text-app-text-secondary">{tr('agentConfig.engine')}: <span className="text-app-text">{agent.model.engine ?? '—'}</span></p>{/* allow-emdash: placeholder for a missing value */}
        {models.map(([ch, m]) => (
          <p key={ch} className="text-mini text-app-text-secondary">{ch}: <span className="text-app-text">{Object.entries(m).map(([k, v]) => `${k === '*' ? tr('agentConfig.everyone') : k} → ${v.replace('anthropic/', '')}`).join(' · ')}</span></p>
        ))}
        <p className="mt-2 text-mini text-app-text-muted">{agent.accounts.map((a) => `${a.channel}${a.account !== 'default' ? ` (${a.account})` : ''}: ${a.token}`).join(' · ')}</p>
      </Section>

      <Section icon={MessagesSquare} title={tr('agentConfig.chats')} aside={tr('agentConfig.chatsAside', { n: agent.chats.length })}>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={tr('agentConfig.filter')}
          className="mb-2 w-full rounded border border-app-border-light bg-surface px-2 py-1 text-mini" />
        <div className="mb-1 flex gap-3 px-1 text-mini text-app-text-muted"><span className="flex-1" /><span className="w-14 text-center">{tr('agentConfig.active')}</span><span className="w-14 text-center">{tr('agentConfig.mention')}</span></div>
        <ul className="max-h-80 overflow-y-auto">
          {chats.map((c) => (
            <Fragment key={`${c.channel}:${c.chat}:${c.account}`}>
            <li data-testid="agent-chat" className="flex items-center gap-3 rounded px-1 py-1 hover:bg-app-hover">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-prose text-app-text">{chatName(c)}</span>
                <span className="block truncate text-mini text-app-text-muted">
                  {c.channel}{c.senders.length ? ` · ${tr('agentConfig.senders', { n: c.senders.length })}` : ''}{c.denied.length ? ` · ${tr('agentConfig.denied', { n: c.denied.length })}` : ''}{c.hasSystem ? ` · ${tr('agentConfig.ownRules')}` : ''}
                </span>
                {c.twoAgents && <span data-testid="agent-chat-two" className="mt-0.5 inline-flex items-center gap-1 rounded bg-app-hover px-1.5 text-mini text-app-text-secondary"><Users size={10} aria-hidden="true" />{tr('agentConfig.twoAgents')}</span>}
              </span>
              <span className="flex w-14 justify-center"><Switch on={c.active} label={tr('agentConfig.active')} testId="agent-chat-active" onChange={(v) => void post('chat', { channel: c.channel, chat: c.chat, account: c.account, active: v })} /></span>
              <span className="flex w-14 justify-center"><Switch on={c.mention} label={tr('agentConfig.mention')} onChange={(v) => void post('chat', { channel: c.channel, chat: c.chat, account: c.account, mention: v })} /></span>
              <button type="button" data-testid="agent-chat-edit" aria-label={tr('agentConfig.edit')} title={tr('agentConfig.edit')} onClick={() => setEditing(editing === `c:${c.channel}:${c.chat}:${c.account}` ? null : `c:${c.channel}:${c.chat}:${c.account}`)} className="rounded p-1 text-app-text-muted hover:bg-app-hover hover:text-app-text"><Pencil size={12} aria-hidden="true" /></button>
            </li>
            {editing === `c:${c.channel}:${c.chat}:${c.account}` && <li className="px-1 pb-2"><ChatEditor c={c} post={post} close={() => setEditing(null)} /></li>}
            </Fragment>
          ))}
        </ul>
      </Section>

      <Section icon={CalendarClock} title={tr('agentConfig.jobs')} aside={tr('agentConfig.jobsAside', { on: agent.jobs.filter((j) => !j.paused).length, n: agent.jobs.length })}>
        <ul className="max-h-80 overflow-y-auto">
          {agent.jobs.map((j) => (
            <Fragment key={j.id}>
            <li data-testid="agent-job" className="flex items-center gap-3 rounded px-1 py-1 hover:bg-app-hover">
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-prose ${j.paused ? 'text-app-text-muted' : 'text-app-text'}`}>{j.name}</span>
                <span className="block truncate text-mini text-app-text-muted">{j.schedule}{j.kind === 'agent' ? ` · ${tr('agentConfig.agentJob')}` : ''}{j.model ? ` · ${j.model}` : ''}</span>
              </span>
              <Switch on={!j.paused} label={tr('agentConfig.jobOn')} testId="agent-job-on" onChange={(v) => void post('job', { id: j.id, paused: !v })} />
              <button type="button" data-testid="agent-job-edit" aria-label={tr('agentConfig.editWhen')} title={tr('agentConfig.editWhen')} onClick={() => setEditing(editing === `j:${j.id}` ? null : `j:${j.id}`)} className="rounded p-1 text-app-text-muted hover:bg-app-hover hover:text-app-text"><Pencil size={12} aria-hidden="true" /></button>
            </li>
            {editing === `j:${j.id}` && <li className="px-1 pb-2"><JobEditor j={j} post={post} close={() => setEditing(null)} /></li>}
            </Fragment>
          ))}
        </ul>
      </Section>
      <p className="mt-3 flex items-center gap-1 text-mini text-app-text-muted"><Activity size={11} aria-hidden="true" />{tr('agentConfig.footer')}</p>
    </div>
  );
}
