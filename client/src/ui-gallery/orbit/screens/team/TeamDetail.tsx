/**
 * sarim-team-of: one team on its own page: its leader, the numbers, its
 * people, the flows it works on and its permissions in brief. The agents are
 * a team too: their page lists the flows they prepare instead of permissions.
 */
import { ArrowLeft, ShieldCheck, Users, type LucideIcon } from 'lucide-react';
import { teamById, world } from '../../world';
import { Button } from '../../../../ui/primitives/Button';
import { Chip } from '../../../../ui/primitives/Chip';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { Block } from '../../../../ui/settings/Block';
import { PaneHeader } from '../../../../ui/shell/PaneHeader';
import type { Tone } from '../../../../ui/types';
import type { ScreenCtx } from '../../../app/kit';
import { StatTile } from '../../admin-parts';
import { ACCESS_ACTIONS, teamValue, type AccessLevel, type AccessSection } from '../../model/access';
import { flowIcon, flowLabel, opsFlowById } from '../../model/flows';
import { liveCards } from '../../model/live';
import { teamFlows, teamMembers } from '../../model/team';
import { orgCrumbs } from '../../crumbs';
import { SP } from '../../paths';
import { TeamFrame } from './TeamFrame';
import { LinkLine, MemberLine } from './parts';
import { teamLabel } from './labels';

const SECTIONS: AccessSection[] = ['inbox', 'flows', 'documents', 'contracts', 'data', 'rules', 'programs'];

/** The icon of a flow, the same on every screen; handed in as a prop, so no component is picked while rendering. */
function FlowGlyph({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon size={14} className="text-app-text-tertiary" aria-hidden="true" />;
}

const LEVEL_TONE: Record<AccessLevel, Tone> = { none: 'neutral', view: 'blue', work: 'green', manage: 'violet' };

export function TeamDetail({ ctx, id }: { ctx: ScreenCtx; id: string }) {
  const c = ctx.copy.sarimTeam;
  const team = teamById(id);
  const agents = id === world().people.agentsTeam.id;
  if (!team && !agents) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PaneHeader crumbs={orgCrumbs(ctx, [{ label: c.title }])} />
        <EmptyState icon={Users} title={c.page.notFound} action={<Button icon={ArrowLeft} onClick={() => ctx.go(SP.team())}>{c.page.back}</Button>}>
          {c.page.notFoundBody}
        </EmptyState>
      </div>
    );
  }
  const cards = liveCards(ctx.state);
  const members = teamMembers(cards).filter((m) => m.team === id);
  const n = { inHand: members.reduce((s, m) => s + m.inHand, 0), waiting: members.reduce((s, m) => s + m.waiting, 0) };
  const flows = team ? teamFlows(ctx.state, team) : [];
  const label = teamLabel(ctx, id);

  return (
    <TeamFrame ctx={ctx} place="team" crumbs={orgCrumbs(ctx, [{ label: c.title, to: SP.team() }, { label }])}>
      <div data-team={id} className="flex flex-col gap-4">
        <h1 className="text-title font-semibold leading-7 text-app-text">{label}</h1>
        {team && <p className="text-prose leading-5 text-app-text-secondary">{team.does}</p>}

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile label={(agents ? c.page.stats.agents : c.page.stats.people)(members.length)} value={members.length} />
          <StatTile label={c.page.stats.inHand} value={n.inHand} onOpen={n.inHand ? () => ctx.go(SP.inbox()) : undefined} />
          <StatTile label={c.page.stats.waiting} value={n.waiting} tone={n.waiting ? 'amber' : undefined} onOpen={n.waiting ? () => ctx.go(SP.inbox()) : undefined} />
          <StatTile label={c.page.stats.flows} value={agents ? world().opsFlows.length : flows.length} />
        </div>

        <Block title={agents ? c.page.agentsTitle : c.page.peopleTitle}>
          <div className="flex flex-col">{members.map((m) => <MemberLine key={m.id} ctx={ctx} m={m} hideNumbers={members.length === 1} />)}</div>
        </Block>

        <Block title={c.page.flowsTitle} description={agents ? c.page.flowsAgents : undefined}>
          {agents ? (
            <div className="flex flex-col">
              {world().opsFlows.map((f) => (
                <LinkLine
                  key={f.id}
                  data-flow={f.id}
                  icon={<FlowGlyph icon={flowIcon(f.id)} />}
                  title={flowLabel(f.id)}
                  sub={world().people.agents.find((a) => a.id === f.agent)?.name}
                  onOpen={() => ctx.go(SP.flow(f.id))}
                />
              ))}
            </div>
          ) : flows.length === 0 ? (
            <p className="text-prose text-app-text-tertiary">{c.page.flowsNone}</p>
          ) : (
            <div className="flex flex-col">
              {flows.map((f) => (
                <LinkLine
                  key={f.id}
                  data-flow={f.id}
                  icon={<FlowGlyph icon={flowIcon(f.id)} />}
                  title={flowLabel(f.id)}
                  sub={world().people.areaLabel[opsFlowById(f.id)?.area ?? world().people.managerTeam]}
                  chips={<Chip tone={LEVEL_TONE[f.level]}>{c.levels[f.level].label}</Chip>}
                  onOpen={() => ctx.go(SP.flow(f.id))}
                />
              ))}
            </div>
          )}
        </Block>

        {team ? (
          <Block
            title={c.page.permissionsTitle}
            actions={<Button size="sm" icon={ShieldCheck} onClick={() => ctx.go(SP.teamPermissions())}>{c.page.openPermissions}</Button>}
          >
            <div className="flex flex-col gap-3">
              <div>
                <div className="mb-1 text-mini font-medium text-app-text-secondary">{c.page.sectionsLabel}</div>
                <div className="flex flex-wrap gap-1.5">
                  {SECTIONS.map((s) => {
                    const level = teamValue(ctx.state, team.id, { kind: 'section', id: s }) as AccessLevel;
                    return <span key={s} data-section={s} data-level={level}><Chip tone={LEVEL_TONE[level]}>{`${c.permissions.sections[s]}: ${c.levels[level].label}`}</Chip></span>;
                  })}
                </div>
              </div>
              <div>
                <div className="mb-1 text-mini font-medium text-app-text-secondary">{c.page.actionsLabel}</div>
                <div className="flex flex-wrap gap-1.5">
                  {ACCESS_ACTIONS.filter((a) => teamValue(ctx.state, team.id, { kind: 'action', id: a }) === true).map((a) => <Chip key={a} tone="blue">{c.permissions.actions[a].label}</Chip>)}
                  {ACCESS_ACTIONS.every((a) => teamValue(ctx.state, team.id, { kind: 'action', id: a }) !== true) && <span className="text-prose text-app-text-tertiary">{c.page.actionsNone}</span>}
                </div>
              </div>
            </div>
          </Block>
        ) : (
          <Block title={c.page.permissionsTitle}>
            <p className="text-prose leading-5 text-app-text-secondary">{c.permissions.agentsRow.does} {c.permissions.agentsRow.never}</p>
          </Block>
        )}
      </div>
    </TeamFrame>
  );
}
