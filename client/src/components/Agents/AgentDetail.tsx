/**
 * ONE AGENT'S PAGE (AGENTS-02): Attività by default, Configura on its own
 * tab — never both stacked on the same screen, which is what the old
 * `AgentProfiles` view did and what this page replaces.
 */
import { useMemo } from 'react';
import { ArrowLeft, Bot } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { DANGER_TEXT } from '../../lib/popoverStyles';
import { AgentConfigure, CONFIGURE_SECTIONS, type ConfigureSection } from './AgentConfigure';
import type { Registry } from '../../state/agentRegistry';

type Agent = Registry['agents'][number];
type Post = (kind: string, body: object) => Promise<boolean>;

/** Attività's own numbers (messages, cost, turnaround) would come from the channel bridge's
 *  turns, which carry no timestamp or cost column this repo reads anywhere today — adding that
 *  would mean guessing an external schema, which is how a dashboard ends up showing an invented
 *  number. Until the bridge exposes one, this stays honest about what it shows: jobs and sessions,
 *  not messages/cost/7 days (named as the open gap in the delivery, not hidden behind a fake KPI). */
function Activity({ agent }: { agent: Agent }) {
  const tr = useT();
  const activeJobs = agent.jobs.filter((j) => !j.paused);
  return (
    <div data-testid="agent-activity" className="space-y-4">
      <p className="text-prose text-app-text-secondary">
        {tr('agentConfig.jobsAside', { on: activeJobs.length, n: agent.jobs.length })}
      </p>
      <ul className="space-y-1">
        {agent.jobs.map((j) => (
          <li key={j.id} className="flex items-center justify-between rounded border border-app-border-light px-2 py-1 text-mini text-app-text-secondary">
            <span className={j.paused ? 'text-app-text-muted' : 'text-app-text'}>{j.name}</span>
            <span>{j.schedule}</span>
          </li>
        ))}
        {agent.jobs.length === 0 && <li className="text-mini text-app-text-muted">{tr('agentConfig.noJobs')}</li>}
      </ul>
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
          ? <Activity agent={agent} />
          : <AgentConfigure agent={agent} allAgents={allAgents} post={post} section={safeSection} onSection={onSection} />}
      </div>
    </div>
  );
}
