/**
 * orbit-person: one person or one agent of ORBIT.
 *
 * A person: what they have in hand, what waits for their check, the contracts
 * they follow or approve (with their step), the obligations of those
 * contracts that fall on them, their team and permissions in brief (the
 * exceptions they have, a link to the matrix) and their recent actions from
 * the log.
 *
 * An agent: its steps in the flows with the person who checks right after,
 * what it has in hand, what waits for a person, what was closed, who reviews
 * its work, the programs it uses and its recent actions. What an agent never
 * does is said once, in Settings > Agents.
 */
import type { ReactNode } from 'react';
import { ArrowLeft, Bot, CalendarClock, FileSignature, History, Kanban, Plug, ShieldCheck, UserRound } from 'lucide-react';
import clsx from 'clsx';
import type { ApprovalStep, Contract, OpsFlow, OpsFlowStep } from '../../../../ui/fixtures/orbit-org/types';
import { agentById, personaById, teamById, teamIdOfPerson, world } from '../../world';
import type { OrbitAgent, OrbitPersona } from '../../../../ui/fixtures/orbit-org/people';
import { Button } from '../../../../ui/primitives/Button';
import { Chip } from '../../../../ui/primitives/Chip';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { PanelSection, SidePanel } from '../../../../ui/primitives/Panel';
import { Timeline } from '../../../../ui/primitives/Timeline';
import { ProgramTile } from '../../../../ui/programs/Shared';
import { Block } from '../../../../ui/settings/Block';
import { PaneHeader } from '../../../../ui/shell/PaneHeader';
import { Avatar } from '../../../../ui/shell/SidebarRows';
import type { Tone } from '../../../../ui/types';
import type { ScreenCtx } from '../../../app/kit';
import { canDo } from '../../../app/store/permissions';
import { linesOf } from '../../model/audit-log';
import { actionLabel, dayLabel, statusLabel } from '../../model/contracts';
import { liveCards, liveContracts, waitingFor } from '../../model/live';
import { ACCESS_ACTIONS, accessSlice, handRows } from '../../model/access';
import { SP } from '../../paths';
import { flowIcon, flowLabel } from '../../model/flows';
import { orgCrumbs } from '../../crumbs';
import { openDaFare } from '../../model/dafare';
import { ActorChip, CardLine, Lines, StatTile } from '../../admin-parts';
import { STAGE_TONE, stageLabel, when } from '../../model/words';
import {
  agentClosed,
  agentFlowOpen,
  agentInHand,
  agentWaiting,
  approvalsWaiting,
  contractsOf,
  flowsOf,
  inHandOf,
  openObligations,
} from '../../model/team';
import { LinkLine } from './parts';
import { accessRowLabel, accessValueLabel, teamLabel } from './labels';

const RECENT_SHOWN = 8;

const STEP_TONE: Record<ApprovalStep['state'], Tone> = { fatto: 'green', 'in-attesa': 'amber', 'da-fare': 'neutral' }; // allow-italian: state ids of the data

export function PersonPage({ ctx, id }: { ctx: ScreenCtx; id: string }) {
  const t = ctx.copy.orbitAdmin.team;
  const person = personaById(id);
  const agent = person ? undefined : agentById(id);
  if (person) return <PersonView ctx={ctx} person={person} />;
  if (agent) return <AgentView ctx={ctx} agent={agent} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PaneHeader crumbs={orgCrumbs(ctx, [{ label: ctx.copy.orbitTeam.title }])} />
      <EmptyState icon={UserRound} title={t.person.notFound} action={<Button icon={ArrowLeft} onClick={() => ctx.go(SP.team())}>{t.person.back}</Button>}>
        {t.person.notFoundBody}
      </EmptyState>
    </div>
  );
}

/** The frame both views share: the header with the way back, the page, and the side panel (under the page on a phone). */
function personFrame(ctx: ScreenCtx, teamId: string, name: string, main: ReactNode, side: ReactNode) {
  const label = teamLabel(ctx, teamId);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PaneHeader crumbs={orgCrumbs(ctx, [{ label: ctx.copy.orbitTeam.title, to: SP.team() }, { label, to: SP.teamOf(teamId) }, { label: name }])}>
        <Button size="sm" icon={ArrowLeft} onClick={() => ctx.go(SP.teamOf(teamId))}>{label}</Button>
      </PaneHeader>
      {ctx.phone ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {main}
          <div className="border-t border-app-border bg-surface">{side}</div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">{main}</div>
          <SidePanel width={340}>{side}</SidePanel>
        </div>
      )}
    </div>
  );
}

/** The recent actions of one actor, from the same lines as the Registro. (allow-italian: quotes the Italian interface) */
function recentSection(ctx: ScreenCtx, actorId: string, title: string) {
  const p = ctx.copy.orbitAdmin.team.person;
  const lines = linesOf(ctx.state, ctx.copy.orbitAdmin.log, actorId).slice(0, RECENT_SHOWN);
  const [, setLogPerson] = ctx.ui<string>('orbit.log.person', '');
  const openLog = () => {
    setLogPerson(actorId);
    ctx.go(SP.settings('registro'));
  };
  return (
    <PanelSection label={title}>
      {lines.length === 0 ? <p className="text-prose text-app-text-tertiary">{p.recentEmpty}</p> : (
        <Timeline
          ariaLabel={title}
          items={lines.map((l) => ({ id: l.id, at: when(ctx, l.at), title: l.what, detail: l.subject || undefined, tone: l.live ? 'blue' as const : 'neutral' as const, onOpen: l.path === ctx.path ? undefined : () => ctx.go(l.path) }))}
        />
      )}
      <Button size="sm" icon={History} className="mt-3" onClick={ctx.allow('view:settings', openLog)} title={ctx.deniedTitle('view:settings')}>{p.openLog}</Button>
    </PanelSection>
  );
}

const glyph = (Icon: typeof Bot, tone: 'violet' | 'blue' | 'amber' | 'neutral' = 'neutral') => (
  <span
    className={clsx(
      'inline-flex h-6 w-6 items-center justify-center rounded-md',
      tone === 'violet' && 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
      tone === 'blue' && 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
      tone === 'amber' && 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
      tone === 'neutral' && 'bg-black/[0.05] text-app-text-secondary dark:bg-white/[0.08]',
    )}
  >
    <Icon size={13} aria-hidden="true" />
  </span>
);

/* ---------- a person ---------- */

function PersonView({ ctx, person }: { ctx: ScreenCtx; person: OrbitPersona }) {
  const t = ctx.copy.orbitAdmin.team;
  const p = t.person;
  const common = ctx.copy.orbitAdmin.common;
  const cards = liveCards(ctx.state);
  const contracts = liveContracts(ctx.state);
  const inHand = inHandOf(cards, person.id);
  const waiting = waitingFor(cards, person.id);
  const followed = contractsOf(contracts, person.id);
  const approvals = approvalsWaiting(contracts, person.id);
  const obligations = openObligations(contracts, person.id);
  const self = person.id === ctx.persona.id;
  const teamId = teamIdOfPerson(person.id) ?? person.area;
  const team = teamById(teamId);
  const may = ACCESS_ACTIONS.filter((x) => canDo(ctx.state, person, x));
  const exceptions = handRows(accessSlice(ctx.state), { person: person.id });

  const stepOf = (c: Contract) => {
    const steps = c.approvals.filter((s) => s.who === person.id);
    return steps.map((s) => (
      <Chip key={s.id} tone={STEP_TONE[s.state]}>{p.step(actionLabel[s.action], p.stepStates[s.state])}</Chip>
    ));
  };

  const main = (
    <div className="flex w-full max-w-[860px] flex-col gap-4 px-4 py-5">
      <div className="flex items-start gap-3">
        <Avatar text={person.monogram} color={person.color} size={44} />
        <div className="min-w-0 flex-1">
          <h1 className="text-title font-semibold leading-7 text-app-text">{person.name}</h1>
          <div className="flex flex-wrap items-center gap-1.5 text-prose text-app-text-secondary">
            <Chip>{teamLabel(ctx, teamId)}</Chip>
            {team?.lead === person.id && <Chip tone="violet">{ctx.copy.orbitTeam.lead}</Chip>}
            {self && <Chip tone="blue">{common.you}</Chip>}
          </div>
          {team && <p className="mt-1 text-prose leading-5 text-app-text-secondary">{team.does}</p>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label={p.stats.inHand} value={inHand.length} />
        <StatTile label={p.stats.waiting(waiting.length)} value={waiting.length} tone={waiting.length ? 'amber' : undefined} onOpen={waiting.length ? () => ctx.go(SP.inbox()) : undefined} />
        <StatTile label={p.stats.contracts} value={followed.length} onOpen={followed.length ? () => ctx.go(SP.contracts()) : undefined} />
        <StatTile label={p.stats.approvals} value={approvals.length} tone={approvals.length ? 'violet' : undefined} onOpen={approvals[0] ? () => ctx.go(SP.signatures(approvals[0].contract.id)) : undefined} />
      </div>

      <Block title={p.inHandTitle}>
        <Lines empty={p.inHandEmpty}>{inHand.map((c) => <CardLine key={c.id} card={c} ctx={ctx} note={c.worker.doing} />)}</Lines>
      </Block>

      <Block title={p.waitingTitle}>
        <Lines empty={p.waitingEmpty}>{waiting.map((c) => <CardLine key={c.id} card={c} ctx={ctx} />)}</Lines>
      </Block>

      <Block title={p.contractsTitle}>
        <Lines empty={p.contractsEmpty}>
          {followed.map((c) => (
            <LinkLine
              key={c.id}
              icon={glyph(FileSignature, 'blue')}
              title={c.title}
              sub={`${c.counterparty} · ${statusLabel[c.status]}`}
              chips={<>{c.owner === person.id && <Chip tone="blue">{p.owns}</Chip>}{stepOf(c)}</>}
              onOpen={() => ctx.go(approvals.some((a) => a.contract.id === c.id) ? SP.signatures(c.id) : SP.contract(c.id))}
            />
          ))}
        </Lines>
      </Block>

      <Block title={p.obligationsTitle}>
        <Lines empty={p.obligationsEmpty}>
          {obligations.map(({ contract, o }) => (
            <LinkLine
              key={`${contract.id}-${o.id}`}
              icon={glyph(CalendarClock, 'amber')}
              title={o.what}
              sub={contract.title}
              chips={o.due ? <Chip tone="amber">{p.due(dayLabel(o.due))}</Chip> : o.every ? <Chip>{p.every(o.every)}</Chip> : undefined}
              onOpen={() => ctx.go(SP.clause(contract.id, o.clause))}
            />
          ))}
        </Lines>
      </Block>
    </div>
  );

  const side = (
    <>
      <PanelSection label={ctx.copy.orbitTeam.person.permissionsTitle}>
        <div className="flex flex-col gap-3">
          <div>
            <div className="mb-1 text-mini font-medium text-app-text-secondary">{ctx.copy.orbitTeam.person.team}</div>
            <button
              type="button"
              onClick={() => ctx.go(SP.teamOf(teamId))}
              className="rounded-md text-prose text-app-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              {teamLabel(ctx, teamId)}
            </button>
          </div>
          <div>
            <div className="mb-1 text-mini font-medium text-app-text-secondary">{ctx.copy.orbitTeam.person.can}</div>
            <div className="flex flex-wrap gap-1">
              {may.length
                ? may.map((x) => <Chip key={x} tone="blue">{ctx.copy.orbitTeam.permissions.actions[x].label}</Chip>)
                : <span className="text-prose text-app-text-tertiary">{ctx.copy.orbitTeam.page.actionsNone}</span>}
            </div>
          </div>
          <div data-exceptions="person">
            <div className="mb-1 text-mini font-medium text-app-text-secondary">{ctx.copy.orbitTeam.person.exceptions}</div>
            {exceptions.length === 0 ? <p className="text-prose text-app-text-tertiary">{ctx.copy.orbitTeam.person.noExceptions}</p> : (
              <div className="flex flex-wrap gap-1">
                {exceptions.map(({ row, value }) => <Chip key={`${row.kind}:${row.id}`} tone="amber">{`${accessRowLabel(ctx, row)}: ${accessValueLabel(ctx, value)}`}</Chip>)}
              </div>
            )}
          </div>
        </div>
        <Button size="sm" icon={ShieldCheck} className="mt-3" onClick={() => ctx.go(SP.teamPermissions())}>{ctx.copy.orbitTeam.person.open}</Button>
      </PanelSection>
      {recentSection(ctx, person.id, p.recentTitle)}
    </>
  );

  return personFrame(ctx, teamId, person.name, main, side);
}

/* ---------- an agent ---------- */

/** The agent's steps in the flows, each with the next step done by a person (who checks it). */
function stepsOf(agentId: string): Array<{ flow: OpsFlow; step: OpsFlowStep; checker?: string }> {
  return world().opsFlows.flatMap((flow) => flow.steps.flatMap((step, i) => {
    if (step.actor.kind !== 'agent' || step.actor.id !== agentId) return [];
    const next = flow.steps.slice(i + 1).find((s) => s.actor.kind === 'person');
    return [{ flow, step, checker: next && next.actor.kind === 'person' ? next.actor.id : undefined }];
  }));
}

function AgentView({ ctx, agent }: { ctx: ScreenCtx; agent: OrbitAgent }) {
  const t = ctx.copy.orbitAdmin.team;
  const a = t.agent;
  const cards = liveCards(ctx.state);
  const flows = flowsOf(agent.id);
  const flow = flows[0];
  const steps = stepsOf(agent.id);
  const inHand = agentInHand(cards, agent.id);
  const waiting = agentWaiting(cards, agent.id);
  const closed = agentClosed(cards, agent.id);
  const open = agentFlowOpen(cards, agent.id);
  const reviewers = [...new Set(open.map((c) => c.reviewer))].map((id) => ({ id, n: open.filter((c) => c.reviewer === id).length }));
  const flowIds = new Set(steps.map((s) => s.flow.id));
  const names = new Set(world().opsFlows.filter((f) => flowIds.has(f.id)).flatMap((f) => f.programs));
  const programs = world().programs.filter((p) => names.has(p.flowName));

  const main = (
    <div className="flex w-full max-w-[860px] flex-col gap-4 px-4 py-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-violet-500/15 text-violet-700 dark:text-violet-300">
          <Bot size={22} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-title font-semibold leading-7 text-app-text">{agent.name}</h1>
          <div className="flex flex-wrap items-center gap-1.5 text-prose text-app-text-secondary">
            <Chip tone="violet" icon={Bot}>{a.kind}</Chip>
            <span>{world().people.areaLabel[agent.area]}{flows.length ? ` · ${flows.map((x) => flowLabel(x.id)).join(', ')}` : ''}</span>
          </div>
        </div>
        {flow && <Button icon={Kanban} onClick={() => openDaFare(ctx, { view: 'kanban', flow: flow.id })}>{ctx.copy.orbitTeam.page.openInHand}</Button>}
      </div>
      <p className="text-prose leading-6 text-app-text">{agent.does}</p>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label={a.stats.inHand} value={inHand.length} onOpen={flow ? () => openDaFare(ctx, { view: 'list', flow: flow.id }) : undefined} />
        <StatTile label={a.stats.waiting(waiting.length)} value={waiting.length} tone={waiting.length ? 'amber' : undefined} />
        <StatTile label={a.stats.closed} value={closed.length} tone={closed.length ? 'green' : undefined} />
        <StatTile label={a.stats.steps} value={steps.length} />
      </div>

      <Block title={a.stepsTitle} description={a.stepsBody}>
        <Lines empty={a.stepsEmpty}>
          {steps.map(({ flow, step, checker }) => (
            <LinkLine
              key={`${flow.id}-${step.id}`}
              icon={glyph(flowIcon(flow.id), 'violet')}
              title={step.title}
              sub={flow.name}
              chips={<>
                <Chip tone={STAGE_TONE[step.stage]}>{stageLabel(step.stage)}</Chip>
                {checker && <ActorChip id={checker} ctx={ctx} />}
              </>}
              onOpen={() => ctx.go(SP.flowStep(flow.id, step.id))}
            />
          ))}
        </Lines>
      </Block>

      <Block title={a.inHandTitle}>
        <Lines empty={a.inHandEmpty}>{inHand.map((c) => <CardLine key={c.id} card={c} ctx={ctx} note={c.worker.doing} />)}</Lines>
      </Block>

      <Block title={a.waitingTitle}>
        <Lines empty={a.waitingEmpty}>{waiting.map((c) => <CardLine key={c.id} card={c} ctx={ctx} />)}</Lines>
      </Block>

      <Block title={a.closedTitle}>
        <Lines empty={a.closedEmpty}>{closed.map((c) => <CardLine key={c.id} card={c} ctx={ctx} />)}</Lines>
      </Block>
    </div>
  );

  const side = (
    <>
      <PanelSection label={a.reviewersTitle}>
        {reviewers.length === 0 ? <p className="text-prose text-app-text-tertiary">{a.reviewersEmpty}</p> : (
          <div className="flex flex-col gap-1">
            {reviewers.map((r) => (
              <div key={r.id} className="flex min-w-0 items-center justify-between gap-2">
                <ActorChip id={r.id} ctx={ctx} short={false} />
                <span className="shrink-0 text-mini text-app-text-tertiary">{a.reviewersBody(r.n)}</span>
              </div>
            ))}
          </div>
        )}
      </PanelSection>
      <PanelSection label={a.programsTitle}>
        {programs.length === 0 ? <p className="text-prose text-app-text-tertiary">{a.programsEmpty}</p> : (
          <div className="flex flex-col">
            {programs.map((p) => (
              <LinkLine key={p.id} icon={<ProgramTile initial={p.monogram} color={p.color} size={24} />} title={p.name} sub={p.sub} onOpen={() => ctx.go(SP.program(p.id))} />
            ))}
          </div>
        )}
        <Button size="sm" icon={Plug} className="mt-3" onClick={ctx.allow('view:programs', () => ctx.go(SP.programs()))} title={ctx.deniedTitle('view:programs')}>
          {ctx.copy.orbitAdmin.programs.title}
        </Button>
      </PanelSection>
      {recentSection(ctx, `agent:${agent.id}`, a.recentTitle)}
    </>
  );

  return personFrame(ctx, world().people.agentsTeam.id, agent.name, main, side);
}
