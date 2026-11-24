/**
 * ONE AGENT'S PAGE (AGENTS-02): Activity by default, Configure on its own
 * tab — never both stacked on the same screen, which is what the old
 * `AgentProfiles` view did and what this page replaces.
 */
import { useMemo } from 'react';
import { ArrowLeft, Bot } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { DANGER_TEXT } from '../../lib/popoverStyles';
import { AgentConfigure } from './AgentConfigure';
import { channelBrand } from './channelBrand';
import { ChannelMark } from './ChannelMark';
import { CONFIGURE_SECTIONS, type ConfigureSection } from './configureSections';
import { useConfigSummary } from './configSummary';
import { scheduleWords } from './scheduleWords';
import { useAgentActivity, type ActivityTurn } from './useAgentActivity';
import { useStoppedLog } from './useStoppedLog';
import type { Registry } from '../../state/agentRegistry';

type Agent = Registry['agents'][number];
type Post = (kind: string, body: object) => Promise<boolean>;

function Block({ title, testId, children }: { title: string; testId: string; children: React.ReactNode }) {
  return (
    <section data-testid={testId} className="space-y-1">
      <h2 className="text-body font-semibold text-app-text">{title}</h2>
      {children}
    </section>
  );
}

function TurnRow({ t }: { t: ActivityTurn }) {
  const tr = useT();
  return (
    <li data-testid="agent-activity-turn" className="rounded border border-app-border-light px-2 py-1 text-mini text-app-text-secondary">
      <span className="flex items-center gap-2">
        <ChannelMark channel={t.channel} />
        <span className="min-w-0 flex-1 truncate text-app-text">{t.title ?? tr('agents.untitledChat')}</span>
        <span className="flex-shrink-0">{channelBrand(t.channel)}</span>
      </span>
      {t.error && <span className={`block break-words ${DANGER_TEXT}`}>{t.error}</span>}
    </li>
  );
}

function Activity({ agent, onSection }: { agent: Agent; onSection: (s: ConfigureSection) => void }) {
  const tr = useT();
  const { rows, turns } = useAgentActivity();
  const { rows: stopped } = useStoppedLog({ agent: agent.id, pageSize: 5 });
  const summary = useConfigSummary(agent);
  const own = turns.filter((t) => t.agent === agent.id);
  const working = own.filter((t) => t.state === 'working');
  const failed = own.filter((t) => t.state === 'failed').slice(0, 10);
  const counts = rows.filter((r) => r.agent === agent.id);
  const upcoming = agent.jobs.filter((j) => !j.paused);
  return (
    <div data-testid="agent-activity" className="space-y-5">
      <Block title={tr('agents.now')} testId="agent-activity-now">
        {working.length === 0 ? <p className="text-mini text-app-text-muted">{tr('agents.nowNone')}</p> : <ul className="space-y-1">{working.map((t, i) => <TurnRow key={`${t.created}:${i}`} t={t} />)}</ul>}
      </Block>
      <Block title={tr('agents.inError')} testId="agent-activity-errors">
        {failed.length === 0 ? <p className="text-mini text-app-text-muted">{tr('agents.inErrorNone')}</p> : <ul className="space-y-1">{failed.map((t, i) => <TurnRow key={`${t.created}:${i}`} t={t} />)}</ul>}
      </Block>
      <Block title={tr('agents.upcoming')} testId="agent-activity-upcoming">
        {upcoming.length === 0 && <p className="text-mini text-app-text-muted">{tr('agentConfig.noJobs')}</p>}
        <ul className="space-y-1">
          {upcoming.map((j) => {
            const w = scheduleWords(j.rawSchedule);
            const when = tr(w.key, w.key === 'agents.when.weekly' ? { ...w.params, day: tr(`agents.day.${w.params.day}` as 'agents.day.0') } : w.params);
            return (
              <li key={j.id} data-testid="agent-activity-job" className="flex items-center justify-between gap-2 rounded border border-app-border-light px-2 py-1 text-mini text-app-text-secondary">
                <span className="min-w-0 truncate text-app-text">{j.name}</span>
                <span data-testid="agent-activity-job-when" className="flex-shrink-0">{when}</span>
              </li>
            );
          })}
        </ul>
      </Block>
      <Block title={tr('agents.activity.title')} testId="agent-activity-turns">
        {counts.length === 0 && <p className="text-mini text-app-text-muted">{tr('agents.activity.none')}</p>}
        <ul className="space-y-1">
          {counts.map((r) => (
            <li key={r.channel} data-testid="agent-activity-row" className="flex items-center gap-2 rounded border border-app-border-light px-2 py-1 text-mini text-app-text-secondary">
              <ChannelMark channel={r.channel} />
              <span className="font-semibold text-app-text">{channelBrand(r.channel)}</span>
              <span>{tr('agents.activity.counts', { handled: r.handled, failed: r.failed, quota: r.quota, merged: r.merged })}</span>
            </li>
          ))}
        </ul>
        <p className="text-mini text-app-text-muted">{tr('agents.activity.noCost')}</p>
      </Block>
      <Block title={tr('agentConfig.permissions.stopped.title')} testId="agent-activity-stopped">
        {stopped.length === 0 ? <p className="text-mini text-app-text-muted">{tr('agentConfig.permissions.stopped.none')}</p> : (
          <ul className="space-y-1">
            {stopped.map((s, i) => (
              <li key={`${s.created}:${i}`} data-testid="agent-activity-stopped-row" className="flex min-w-0 flex-wrap items-center gap-1.5 rounded border border-app-border-light px-2 py-1 text-mini text-app-text-secondary">
                <ChannelMark channel={s.channel ?? ''} />
                <span className="min-w-0 flex-1 truncate text-app-text">{s.chatTitle ?? s.chat}</span>
                <span className="w-full basis-full truncate sm:w-auto sm:basis-auto">{tr(`agentConfig.permissions.reason.${s.reason}`) || s.reason}</span>
              </li>
            ))}
          </ul>
        )}
        <button type="button" data-testid="agent-activity-stopped-seeall" onClick={() => onSection('permissions')} className="text-mini text-app-text-secondary hover:text-app-text">{tr('agentConfig.permissions.stopped.seeAll')}</button>
      </Block>
      <Block title={tr('agents.madeOf')} testId="agent-made-of">
        <ul className="divide-y divide-app-border-light rounded border border-app-border-light">
          {CONFIGURE_SECTIONS.map((s) => (
            <li key={s}>
              <button type="button" data-testid="agent-made-of-row" onClick={() => onSection(s)} className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-mini hover:bg-app-hover">
                <span className="min-w-0 flex-1 truncate text-app-text">{tr(`agentConfig.section.${s}` as 'agentConfig.section.identity')}</span>
                <span className="flex-shrink-0 text-app-text-muted">{summary[s] ?? ''}</span>
              </button>
            </li>
          ))}
        </ul>
      </Block>
    </div>
  );
}

export function AgentDetail({
  agent, allAgents, issues, note, post, tab, section, onTab, onSection, onBack,
}: {
  agent: Agent; allAgents: { id: string; name: string }[]; issues: { agent: string | null; text: string }[]; note: string | null; post: Post;
  tab: 'activity' | 'configure'; section: ConfigureSection;
  onTab: (t: 'activity' | 'configure') => void; onSection: (s: ConfigureSection) => void; onBack: () => void;
}) {
  const tr = useT();
  const safeSection = useMemo(() => (CONFIGURE_SECTIONS.includes(section) ? section : 'identity'), [section]);
  const ownIssues = issues.filter((i) => i.agent === agent.id || i.agent === null);
  return (
    <div data-testid="agent-detail">
      <button type="button" data-testid="agent-detail-back" onClick={onBack} className="mb-2 flex items-center gap-1 text-mini text-app-text-secondary hover:text-app-text">
        <ArrowLeft size={12} aria-hidden="true" />{tr('agents.back')}
      </button>
      <h1 className="flex items-center gap-2 text-title font-semibold text-app-text"><Bot size={18} className="text-app-text-secondary" aria-hidden="true" />{agent.name}</h1>
      {agent.job && <p className="text-prose text-app-text-secondary">{agent.job}</p>}
      {ownIssues.length > 0 && (
        <ul data-testid="agent-issues" className="mt-2 space-y-0.5">
          {ownIssues.map((i) => <li key={i.text} className={`text-mini ${DANGER_TEXT}`}>{i.text}</li>)}
        </ul>
      )}
      {note && <p data-testid="agent-note" className="mt-2 text-mini text-app-text-secondary">{note}</p>}
      <div className="mt-3 flex items-center gap-1 border-b border-app-border-light" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'activity'} data-testid="agent-detail-tab-activity" onClick={() => onTab('activity')}
          className={`-mb-px border-b-2 px-3 py-1.5 text-body ${tab === 'activity' ? 'border-primary font-semibold text-app-text' : 'border-transparent text-app-text-secondary hover:text-app-text'}`}>
          {tr('agents.tab.activity')}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'configure'} data-testid="agent-detail-tab-configure" onClick={() => onTab('configure')}
          className={`-mb-px border-b-2 px-3 py-1.5 text-body ${tab === 'configure' ? 'border-primary font-semibold text-app-text' : 'border-transparent text-app-text-secondary hover:text-app-text'}`}>
          {tr('agents.tab.configure')}
        </button>
      </div>
      <div className="mt-4">
        {tab === 'activity'
          ? <Activity agent={agent} onSection={onSection} />
          : <AgentConfigure agent={agent} allAgents={allAgents} post={post} section={safeSection} onSection={onSection} />}
      </div>
    </div>
  );
}
