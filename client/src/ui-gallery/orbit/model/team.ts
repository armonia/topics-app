/**
 * The team of ORBIT as the screens read it: the teams with their leader, the
 * people and the agents with what each has in hand (from the live cards and
 * contracts), and the flows a team works on.
 */
import type { DemoState } from '../../app/store/state';
import type { Contract, Obligation, OrbitCard } from '../../../ui/fixtures/orbit-org/types';
import { teamMembers as membersOfTeam, world } from '../world';
import type { OrbitTeam } from '../../../ui/fixtures/orbit-org/people';
import { atLeast, teamValue, type AccessLevel } from './access';
import { stageCounts } from './stages';
import { openCards } from './flows';
import { stageOf, waitingFor } from './live';

const open = (c: OrbitCard) => stageOf(c) !== 'fatto'; // allow-italian: stage id, compared by value
const checking = (c: OrbitCard) => stageOf(c) === 'verifica' || stageOf(c) === 'approvazione'; // allow-italian: stage ids, compared by value

/* ---------- everyone ---------- */

/** Cards waiting for a person's check or approval: the two columns of the stage view, counted as it counts them. */
export function waitingCount(cards: OrbitCard[]): number {
  const counts = stageCounts(cards);
  return counts.verifica + counts.approvazione;
}

/* ---------- people ---------- */

export const inHandOf = (cards: OrbitCard[], id: string) => cards.filter((c) => open(c) && c.worker.kind === 'person' && c.worker.id === id);

export const contractsOf = (contracts: Contract[], id: string) => contracts.filter((c) => c.owner === id || c.approvals.some((s) => s.who === id));

export const approvalsWaiting = (contracts: Contract[], id: string) => contracts.flatMap((c) => c.approvals.filter((s) => s.who === id && s.state === 'in-attesa').map((s) => ({ contract: c, step: s }))); // allow-italian: state id, compared by value

/** The obligations of the contracts not done yet, the nearest first (those without a date last); `owner` keeps one person's. */
export function openObligations(contracts: Contract[], owner?: string): Array<{ contract: Contract; o: Obligation }> {
  return contracts
    .flatMap((contract) => contract.obligations.filter((o) => !o.done && (!owner || o.owner === owner)).map((o) => ({ contract, o })))
    .sort((a, b) => (a.o.due ?? '9999').localeCompare(b.o.due ?? '9999'));
}

/* ---------- agents ---------- */

/** The flows whose cards the agent prepares. */
export const flowsOf = (agentId: string) => world().opsFlows.filter((f) => f.agent === agentId);

/** The open cards of the agent's flows, whoever holds them now. */
export function agentFlowOpen(cards: OrbitCard[], id: string) {
  const flows = new Set(flowsOf(id).map((f) => f.id));
  return openCards(cards).filter((c) => flows.has(c.flow));
}

export const agentInHand = (cards: OrbitCard[], id: string) => cards.filter((c) => open(c) && c.worker.kind === 'agent' && c.worker.id === id);

/** Cards the agent worked on that now wait for a person's check or approval. */
export const agentWaiting = (cards: OrbitCard[], id: string) => cards.filter((c) => checking(c) && c.history.some((e) => e.by === `agent:${id}`));

/** Cards of the agent's flows closed in the last 7 days. */
export function agentClosed(cards: OrbitCard[], id: string) {
  const flows = new Set(flowsOf(id).map((f) => f.id));
  return cards.filter((c) => flows.has(c.flow) && !open(c));
}

/** Went through a person's check (a column «Da verificare» or «Da approvare») before closing. (allow-italian: quotes the Italian interface) */
export const passedCheck = (c: OrbitCard) => c.history.some((e) => e.stage === 'verifica' || e.stage === 'approvazione'); // allow-italian: stage ids, compared by value

/* ---------- teams ---------- */

/** A person or an agent as a line of the team list, with what they have in hand. */
export interface TeamMember {
  id: string;
  kind: 'person' | 'agent';
  /** The id of the team they belong to (`agenti` for the agents). */
  team: string;
  name: string;
  short: string;
  /** The line under the name: what the agent does; empty for a person. */
  does: string;
  monogram: string;
  color: string;
  lead: boolean;
  example: boolean;
  inHand: number;
  waiting: number;
}

/** Every person and every agent, with their team and numbers, in the order of the teams. */
export function teamMembers(cards: OrbitCard[]): TeamMember[] {
  const people = world().people.teams.flatMap((t) => membersOfTeam(t.id).map((p): TeamMember => ({
    id: p.id, kind: 'person', team: t.id, name: p.name, short: p.short, does: '', monogram: p.monogram, color: p.color,
    lead: t.lead === p.id, example: Boolean(p.example), inHand: inHandOf(cards, p.id).length, waiting: waitingFor(cards, p.id).length,
  })));
  const agents = world().people.agents.map((a): TeamMember => ({
    id: a.id, kind: 'agent', team: world().people.agentsTeam.id, name: a.name, short: a.name, does: a.does, monogram: '', color: '',
    lead: false, example: false, inHand: agentInHand(cards, a.id).length, waiting: agentWaiting(cards, a.id).length,
  }));
  return [...people, ...agents];
}

/** The numbers of a team: how many people, the cards its people hold, the cards that wait for a check or approval from them. */
export function teamNumbers(members: TeamMember[]) {
  return {
    count: members.length,
    inHand: members.reduce((n, m) => n + m.inHand, 0),
    waiting: members.reduce((n, m) => n + m.waiting, 0),
  };
}

/** The flows a team works on: those where its level is at least «Lavora», with that level. (allow-italian: quotes the Italian interface) */
export function teamFlows(state: DemoState, team: OrbitTeam): Array<{ id: string; level: AccessLevel }> {
  return world().opsFlows
    .map((f) => ({ id: f.id, level: teamValue(state, team.id, { kind: 'flow', id: f.id }) as AccessLevel }))
    .filter((f) => atLeast(f.level, 'work'));
}
