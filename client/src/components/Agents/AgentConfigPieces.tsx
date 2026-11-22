/**
 * BUILDING BLOCKS OF AN AGENT'S REGISTRY CARD: switches, row editors and the
 * Model/Jobs sections, read from and written to jarvis-channels through
 * `/api/agent-config`. The Agents navigation (AGENTS-NAV-01) places these
 * pieces into the Configure page's own sections instead of stacking them all
 * on one screen — the flat multi-agent view this file used to export alone
 * is gone, retired with the popovers it replaced.
 * Switches follow Bruno Delorence's «Weekly hours» pattern: one switch per
 * row. A row opens into its fields where it stands («Row editor»): a chat's
 * own instructions and who may write, a job's schedule.
 */
import { Fragment, useState } from 'react';
import { Bot, CalendarClock, Pencil, Sparkles } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { Select } from '../Shared/Select';
import { modelName } from './displayNames';

import type { Registry } from '../../state/agentRegistry';
type Agent = Registry['agents'][number];
type Chat = Agent['chats'][number];
type Job = Agent['jobs'][number];
export type Post = (kind: string, body: object) => Promise<boolean>;

export const FIELD = 'w-full rounded border border-app-border-light bg-surface px-2 py-1 text-mini text-app-text';
export const BTN = 'rounded px-2 py-1 text-mini text-app-text-secondary hover:bg-app-hover';
export const SAVE = 'rounded bg-primary px-2 py-1 text-mini text-white disabled:opacity-40';

export function ChatEditor({ c, post, close }: { c: Chat; post: Post; close: () => void }) {
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

export function JobEditor({ j, post, close }: { j: Job; post: Post; close: () => void }) {
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

export function Switch({ on, label, onChange, testId }: { on: boolean; label: string; onChange: (v: boolean) => void; testId?: string }) {
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

export function Section({ icon: Icon, title, aside, children }: { icon: typeof Bot; title: string; aside?: React.ReactNode; children: React.ReactNode }) {
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

/** Configure › Modello e account: the fallback model, the per-channel overrides, and every
 *  channel's own account — Discord, WhatsApp, Telegram or whatever else `config.json` declares
 *  (not Discord-only: the account list already comes from the server filtered to this agent). */
export function AgentModelSection({ agent }: { agent: Agent }) {
  const tr = useT();
  const models = Object.entries(agent.model.perChannel);
  return (
    <Section icon={Sparkles} title={tr('agentConfig.model')}>
      <p className="text-mini text-app-text-secondary">{tr('agentConfig.engine')}: <span className="text-app-text">{agent.model.engine ? modelName(agent.model.engine) : '—'}</span></p>{/* allow-emdash: placeholder for a missing value */}
      {models.map(([ch, m]) => (
        <p key={ch} className="text-mini text-app-text-secondary">{ch}: <span className="text-app-text">{Object.entries(m).map(([k, v]) => `${k === '*' ? tr('agentConfig.everyone') : k} → ${modelName(v)}`).join(' · ')}</span></p>
      ))}
      <ul data-testid="agent-accounts" className="mt-2 space-y-1">
        {agent.accounts.map((a) => (
          <li key={`${a.channel}:${a.account}`} className="flex items-center justify-between text-mini text-app-text-secondary">
            <span className="text-app-text">{a.channel}{a.account !== 'default' ? ` (${a.account})` : ''}</span>
            <span data-testid="agent-account-status" className={a.token ? 'text-app-text-muted' : 'text-amber-500'}>
              {a.token ? tr('agentConfig.accountConfigured') : tr('agentConfig.accountMissing')}
            </span>
          </li>
        ))}
        {agent.accounts.length === 0 && <li className="text-mini text-app-text-muted">{tr('agentConfig.noAccounts')}</li>}
      </ul>
    </Section>
  );
}

/** Configure › Lavori a orario: the agent's scheduled jobs, each opening its own schedule editor. */
export function AgentJobsSection({ agent, post }: { agent: Agent; post: Post }) {
  const tr = useT();
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <Section icon={CalendarClock} title={tr('agentConfig.jobs')} aside={tr('agentConfig.jobsAside', { on: agent.jobs.filter((j) => !j.paused).length, n: agent.jobs.length })}>
      <ul className="max-h-80 overflow-y-auto">
        {agent.jobs.map((j) => (
          <Fragment key={j.id}>
            <li data-testid="agent-job" className="flex items-center gap-3 rounded px-1 py-1 hover:bg-app-hover">
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-prose ${j.paused ? 'text-app-text-muted' : 'text-app-text'}`}>{j.name}</span>
                <span className="block truncate text-mini text-app-text-muted">{j.schedule}{j.kind === 'agent' ? ` · ${tr('agentConfig.agentJob')}` : ''}{j.model ? ` · ${modelName(j.model)}` : ''}</span>
              </span>
              <Switch on={!j.paused} label={tr('agentConfig.jobOn')} testId="agent-job-on" onChange={(v) => void post('job', { id: j.id, paused: !v })} />
              <button type="button" data-testid="agent-job-edit" aria-label={tr('agentConfig.editWhen')} title={tr('agentConfig.editWhen')} onClick={() => setEditing(editing === j.id ? null : j.id)} className="rounded p-1 text-app-text-muted hover:bg-app-hover hover:text-app-text"><Pencil size={12} aria-hidden="true" /></button>
            </li>
            {editing === j.id && <li className="px-1 pb-2"><JobEditor j={j} post={post} close={() => setEditing(null)} /></li>}
          </Fragment>
        ))}
        {agent.jobs.length === 0 && <li className="text-mini text-app-text-muted">{tr('agentConfig.noJobs')}</li>}
      </ul>
    </Section>
  );
}
