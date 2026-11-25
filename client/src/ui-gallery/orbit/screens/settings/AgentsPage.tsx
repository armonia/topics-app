/**
 * Settings · Agents: the one place that says what an agent never does (sign,
 * approve, send, write in a program on its own), each action with who may do
 * it today (from the permissions as they are, or the people who confirm in
 * the programs) and the way to change it; and how the agents are doing now,
 * from the live cards, with how many of the cards closed in the last 7 days
 * went through a person.
 */
import { ArrowRight, Plug, ShieldCheck } from 'lucide-react';
import type { Permission } from '../../../../ui/fixtures/org/people';
import { world } from '../../world';
import type { OrbitPrincipleAction } from '../../../../ui/copy/orbit-admin';
import { Button } from '../../../../ui/primitives/Button';
import { Chip } from '../../../../ui/primitives/Chip';
import { Block, Callout } from '../../../../ui/settings/Block';
import type { ScreenCtx } from '../../../app/kit';
import { rolePermissions } from '../../../app/store/permissions';
import { ActorChip, StatTile } from '../../admin-parts';
import { agentsInHand } from '../../model/flows';
import { openDaFare } from '../../model/dafare';
import { agentShare } from '../../model/stages';
import { liveCards, stageOf } from '../../model/live';
import { passedCheck, waitingCount } from '../../model/team';
import { SP } from '../../paths';
import { SettingsFrame } from './frame';

/** Who may do an action: the roles holding a permission, or the people who confirm a write in some programs. */
type Holder = { kind: 'permission'; permission: Permission } | { kind: 'programs'; programs: string[] } | { kind: 'flows'; flow: string };

const ALL_ACTIONS: Array<[OrbitPrincipleAction, Holder]> = [
  ['sign', { kind: 'permission', permission: 'sign:contracts' }],
  ['approveContract', { kind: 'permission', permission: 'approve:contracts' }],
  ['approve', { kind: 'permission', permission: 'approve' }],
  ['send', { kind: 'programs', programs: world().programRoles.send }],
  ['registry', { kind: 'programs', programs: world().programRoles.registry }],
  ['tender', { kind: 'flows', flow: world().flowRoles.tender ?? '' }],
  ['programs', { kind: 'programs', programs: world().programRoles.writes }],
];

/** An organization with no tender flow has no rule about tenders to show. */
const ACTIONS = ALL_ACTIONS.filter(([key]) => key !== 'tender' || world().flowRoles.tender);

/** The people who confirm a write in these programs. */
const confirmersOf = (ids: string[]) => [...new Set(world().programs.filter((p) => ids.includes(p.id)).flatMap((p) => p.writes.map((w) => w.confirmedBy)))];

/** The people at the steps of a flow. */
function peopleOfFlow(flowId: string): string[] {
  return [...new Set(world().opsFlows.filter((f) => f.id === flowId).flatMap((f) => f.steps.flatMap((s) => (s.actor.kind === 'person' ? [s.actor.id] : []))))];
}

export function AgentsPage({ ctx }: { ctx: ScreenCtx }) {
  const p = ctx.copy.orbitAdmin.settings.agents;
  const cards = liveCards(ctx.state);
  /* The same counts as the sidebar («al lavoro»), «Flussi» and the stage view. (allow-italian: quotes the Italian interface) */
  const atWork = agentsInHand(cards).length;
  const waiting = waitingCount(cards);
  const { agent: byAgent, person: byPerson } = agentShare(cards);
  const done = cards.filter((c) => stageOf(c) === 'fatto'); // allow-italian: stage id, compared by value
  const checked = done.filter(passedCheck).length;

  const holders = (h: Holder) => {
    if (h.kind === 'permission') {
      const roles = world().people.roles.filter((r) => rolePermissions(ctx.state, r.id).has(h.permission));
      return {
        chips: roles.length ? roles.map((r) => <Chip key={r.id}>{r.label}</Chip>) : [<span key="none" className="text-mini text-app-text-tertiary">{p.nobody}</span>],
        link: <Button size="sm" icon={ShieldCheck} onClick={ctx.allow('view:team', () => ctx.go(SP.teamPermissions()))} title={ctx.deniedTitle('view:team')}>{p.openPermissions}</Button>,
      };
    }
    const people = h.kind === 'programs' ? confirmersOf(h.programs) : peopleOfFlow(h.flow);
    return {
      chips: people.map((id) => <ActorChip key={id} id={id} ctx={ctx} />),
      link: h.kind === 'programs'
        ? <Button size="sm" icon={Plug} onClick={ctx.allow('view:programs', () => ctx.go(h.programs.length === 1 ? SP.program(h.programs[0]) : SP.programs()))} title={ctx.deniedTitle('view:programs')}>{p.openProgram}</Button>
        : <Button size="sm" icon={ArrowRight} onClick={() => openDaFare(ctx, { view: 'list', flow: h.flow })}>{ctx.copy.orbitWork.flows.openInDaFare}</Button>,
    };
  };

  return (
    <SettingsFrame ctx={ctx} section="agenti">
      <div className="flex flex-col gap-4">
        <Block title={p.numbersTitle}>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label={p.numbers.preparing} value={atWork} onOpen={() => ctx.go(SP.inbox())} />
            <StatTile label={p.numbers.waiting} value={waiting} tone={waiting ? 'amber' : undefined} onOpen={() => ctx.go(SP.inbox())} />
            <StatTile label={p.numbers.closedByAgent} value={byAgent} />
            <StatTile label={p.numbers.closedByPerson} value={byPerson} />
          </div>
          <div className="mt-3">
            <Callout icon={ShieldCheck} tone={checked === done.length ? 'green' : 'amber'}>{p.passed(checked, done.length)}</Callout>
          </div>
        </Block>

        <Block title={p.neverTitle} description={p.neverBody}>
          <div className="flex flex-col">
            {ACTIONS.map(([key, holder]) => {
              const h = holders(holder);
              return (
                <div key={key} data-action={key} className="flex flex-col gap-2 border-t border-app-border py-3 first:border-t-0 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <div className="text-prose font-medium leading-5 text-app-text">{p.actions[key].title}</div>
                    <p className="text-mini leading-4 text-app-text-tertiary">{p.actions[key].body}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-mini font-medium text-app-text-secondary">{p.whoCan}</span>
                    {h.chips}
                    <span className="ml-auto">{h.link}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </Block>
      </div>
    </SettingsFrame>
  );
}
