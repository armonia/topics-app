/**
 * sarim-team: the teams of SARIM one under the other, each with how many
 * people it has, the cards they hold and what waits for them (a team of one
 * says it on the person's own line), and its members (a person with their
 * avatar and the «Responsabile» badge, the leader named there and nowhere
 * else, an agent with what it prepares). The six agents are a team of their own, last.
 * The filter bar narrows the members; the strip «Team · Permessi» is shared
 * with the permissions page (`TeamFrame`).
 */
import { useMemo } from 'react';
import { ChevronRight, Inbox, UserRound, Users } from 'lucide-react';
import { world } from '../../world';
import { FilterBar } from '../../../../ui/filters/FilterBar';
import { Button } from '../../../../ui/primitives/Button';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import type { ScreenCtx } from '../../../app/kit';
import { useListFilters, type FilterSchema, type SavedFilter } from '../../../app/filters';
import { liveCards } from '../../model/live';
import { orgCrumbs } from '../../crumbs';
import { SP } from '../../paths';
import { teamMembers, type TeamMember } from '../../model/team';
import { TeamFrame } from './TeamFrame';
import { AgentMark, MemberLine, TeamNumbers } from './parts';
import { teamLabel } from './labels';

/** Where the filters of the team list are kept (`ctx.ui`). */
export const TEAM_FILTERS_KEY = 'sarim.squadra.filters';

const TEAM_ORDER = [...world().people.teams.map((t) => t.id), world().people.agentsTeam.id];

export function TeamPage({ ctx }: { ctx: ScreenCtx }) {
  const c = ctx.copy.sarimTeam;
  const cards = liveCards(ctx.state);
  const members = useMemo(() => teamMembers(cards), [cards]);

  const copy = ctx.copy;
  const schema = useMemo((): FilterSchema<TeamMember> => {
    const f = copy.sarimTeam.filters;
    const nameOfMember = (id: string) => members.find((m) => m.id === id)?.name ?? id;
    return {
      text: (m) => `${m.name} ${m.short} ${m.team}`,
      fields: [
        { id: 'team', label: f.team, icon: Users, kind: 'choice', get: (m) => m.team, valueLabel: (id) => (id === world().people.agentsTeam.id ? copy.sarimTeam.agentsTeam : world().people.teams.find((t) => t.id === id)?.label ?? id), order: TEAM_ORDER, values: TEAM_ORDER },
        { id: 'person', label: f.person, icon: UserRound, kind: 'choice', get: (m) => m.id, valueLabel: nameOfMember, order: members.map((m) => m.id) },
        { id: 'inHand', label: f.inHand, icon: Inbox, kind: 'choice', get: (m) => (m.inHand > 0 ? 'yes' : 'no'), valueLabel: (v) => (v === 'yes' ? f.yes : f.no), order: ['yes', 'no'], suggest: false },
      ],
    };
  }, [copy, members]);
  const presets = useMemo((): SavedFilter[] => [
    { id: 'with-cards', name: copy.sarimTeam.filters.withCards, tokens: [{ id: 't1', field: 'inHand', op: 'is', value: 'yes' }] },
    { id: 'agents-only', name: copy.sarimTeam.filters.onlyAgents, tokens: [{ id: 't1', field: 'team', op: 'is', value: world().people.agentsTeam.id }] },
  ], [copy]);
  const filtered = useListFilters(ctx, { key: TEAM_FILTERS_KEY, items: members, schema, presets });

  const groups = TEAM_ORDER.map((id) => ({ id, all: members.filter((m) => m.team === id), shown: filtered.items.filter((m) => m.team === id) })).filter((g) => g.shown.length > 0);

  return (
    <TeamFrame ctx={ctx} place="team" crumbs={orgCrumbs(ctx, [{ label: c.title, to: SP.team() }, { label: c.nav.team, detail: `${c.people(members.filter((m) => m.kind === 'person').length)}, ${c.agents(members.filter((m) => m.kind === 'agent').length)}` }])}>
      <FilterBar copy={ctx.copy} {...filtered.bar} placeholder={ctx.copy.filters.on.people} phone={ctx.phone} />
      {groups.length === 0 ? (
        <EmptyState icon={Users} title={c.empty.title} className="min-h-0 py-6" action={<Button onClick={filtered.bar.onClear}>{c.empty.clear}</Button>}>
          {c.empty.body}
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((g) => (
            <section key={g.id} data-team={g.id} aria-label={teamLabel(ctx, g.id)} className="overflow-hidden rounded-lg border border-app-border bg-surface">
              <header className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => ctx.go(SP.teamOf(g.id))}
                  className="group inline-flex items-center gap-1 rounded-md text-body-lg font-semibold text-app-text hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                >
                  {g.id === world().people.agentsTeam.id && <AgentMark size={22} />}
                  <span className={g.id === world().people.agentsTeam.id ? 'ml-1' : undefined}>{teamLabel(ctx, g.id)}</span>
                  <ChevronRight size={14} className="text-app-text-faint group-hover:text-primary" aria-hidden="true" />
                </button>
                {g.all.length > 1 && <span className="ml-auto"><TeamNumbers ctx={ctx} members={g.all} /></span>}
              </header>
              <div className="border-t border-app-border px-2 py-0.5">
                {g.shown.map((m) => <MemberLine key={m.id} ctx={ctx} m={m} />)}
              </div>
            </section>
          ))}
        </div>
      )}
    </TeamFrame>
  );
}
