/**
 * THE ACTIVITY LIST OF THE AGENTS OVERVIEW (AGENTS-01): the channel bridge's
 * turns of the last 7 days with the filters At work / In error / All, by
 * agent and by channel. The title is the chat's own (`meta.chat_title`);
 * a pending turn is "at work", a failed one "in error".
 */
import { useMemo, useState } from 'react';
import { useT } from '../../hooks/useT';
import { DANGER_TEXT } from '../../lib/popoverStyles';
import { Select } from '../Shared/Select';
import { PALLINO_ATTESA, PALLINO_OK } from '../Sidebar/chromeSignals';
import { channelBrand } from './channelBrand';
import { splitTurnTitle } from './displayNames';
import type { ActivityTurn } from './useAgentActivity';

type StateFilter = 'all' | 'working' | 'failed';
const STATE_FILTERS: StateFilter[] = ['working', 'failed', 'all'];
const ALL = '';

export function ActivityList({ turns, agents }: { turns: ActivityTurn[]; agents: { id: string; name: string }[] }) {
  const tr = useT();
  const [state, setState] = useState<StateFilter>('all');
  const [agent, setAgent] = useState(ALL);
  const [channel, setChannel] = useState(ALL);
  const channels = useMemo(() => [...new Set(turns.map((t) => t.channel.split(':')[0]))], [turns]);
  const shown = turns.filter((t) => (state === 'all' || t.state === state) && (!agent || t.agent === agent) && (!channel || t.channel.split(':')[0] === channel));
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  return (
    <section data-testid="agent-overview-activity-list" className="mt-6">
      <h2 className="text-body-lg font-semibold text-app-text">{tr('agents.activityTitle')}</h2>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <div className="flex gap-1" role="group" aria-label={tr('agents.activityTitle')}>
          {STATE_FILTERS.map((f) => (
            <button
              key={f} type="button" data-testid={`agent-activity-filter-${f}`} aria-pressed={state === f} onClick={() => setState(f)}
              className={`rounded px-2 py-1 text-mini ${state === f ? 'bg-app-hover font-semibold text-app-text' : 'text-app-text-secondary hover:bg-app-hover'}`}
            >{tr(`agents.filter.${f}` as 'agents.filter.all')}</button>
          ))}
        </div>
        <Select
          value={agent} onChange={setAgent} ariaLabel={tr('agents.activityFilterAgent')}
          options={[{ value: ALL, label: `${tr('agents.activityFilterAgent')}: ${tr('agents.activityFilterAll')}` }, ...agents.map((a) => ({ value: a.id, label: a.name }))]}
        />
        <Select
          value={channel} onChange={setChannel} ariaLabel={tr('agents.activityFilterChannel')}
          options={[{ value: ALL, label: `${tr('agents.activityFilterChannel')}: ${tr('agents.activityFilterAll')}` }, ...channels.map((c) => ({ value: c, label: channelBrand(c) }))]}
        />
      </div>
      {shown.length === 0 ? (
        <p className="mt-2 text-prose text-app-text-muted">{tr('agents.activity.none')}</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {shown.map((t, i) => {
            const split = t.title ? splitTurnTitle(t.title) : null;
            return (
            <li key={`${t.created}:${i}`} data-testid="agent-activity-turn" data-state={t.state} className="flex items-center gap-2 rounded border border-app-border-light px-2 py-1 text-mini text-app-text-secondary">
              <span className={`h-2 w-2 flex-shrink-0 rounded-full ${t.state === 'failed' ? 'bg-red-500' : t.state === 'working' ? PALLINO_ATTESA : PALLINO_OK}`} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-app-text">
                {split?.title ?? tr('agents.untitledChat')}
                {split?.channel && <span data-testid="agent-activity-turn-channel" className="ml-2 text-app-text-muted">{split.channel}</span>}
              </span>
              <span className="flex-shrink-0">{nameOf(t.agent)} · {channelBrand(t.channel)}</span>
              {t.state === 'failed' && t.error && <span className={`hidden truncate sm:inline ${DANGER_TEXT}`}>{t.error}</span>}
            </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
