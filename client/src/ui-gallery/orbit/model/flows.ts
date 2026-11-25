/**
 * The flows of the ORBIT edition as the reader changed them, and how the live
 * cards sit on their steps:
 *  · a flow can be paused and resumed (who, when), and every screen that names
 *    the flow says so: the list, its page, the stage view; (allow-italian: quotes the Italian interface)
 *  · the last try of a flow on yesterday's cases, with the outcome per card;
 *  · the step a card stands at now, which follows the kanban: a card moved by
 *    hand to another column sits at the first step of that column.
 * Pure functions over `liveCards(state)`, so the counts per step, per flow and
 * per flow come from the same cards the kanban draws.
 */
import { CalendarClock, Clock, Droplets, FilePen, FileText, Gavel, Headset, Landmark, Leaf, Map as MapIcon, Receipt, Truck, Users, Wallet, Workflow, Wrench, type LucideIcon } from 'lucide-react';
import type { DemoState } from '../../app/store/state';
import type { OpsFlow, OpsFlowStep, OrbitCard } from '../../../ui/fixtures/orbit-org/types';
import type { FlowIconName } from '../../../ui/fixtures/world-types';
import { world } from '../world';
import { addDays } from '../../../ui/fixtures/org/clock';
import { stageOf } from './live';

export const FLOWS_SLICE = 'orbit.flows';

/** Under this confidence a value read by an agent goes to a person (the rule of the cards). */
export const LOW_CONFIDENCE = 85;

export interface FlowTryCase {
  card: string;
  /** The values the agent read under `LOW_CONFIDENCE` on this case: a person looks at it. */
  low: Array<{ label: string; confidence: number }>;
}

export interface FlowTry {
  at: string;
  by: string;
  /** The day whose cases were taken (`YYYY-MM-DD`). */
  day: string;
  /** No case that day: the try took the most recent ones of the flow. */
  fallback: boolean;
  cases: FlowTryCase[];
}

export interface FlowsSlice {
  paused: Record<string, { at: string; by: string }>;
  tries: Record<string, FlowTry>;
}

export const FLOWS_INITIAL: FlowsSlice = { paused: {}, tries: {} };

export function flowsSlice(state: DemoState): FlowsSlice {
  return { ...FLOWS_INITIAL, ...((state.slices[FLOWS_SLICE] as Partial<FlowsSlice> | undefined) ?? {}) };
}

export function opsFlowById(id: string): OpsFlow | undefined {
  return world().opsFlows.find((f) => f.id === id);
}

export function isPaused(state: DemoState, flowId: string): boolean {
  return Boolean(flowsSlice(state).paused[flowId]);
}

/** The flows that run now: active and not paused. The sidebar and the list of «Flussi» print this count. (allow-italian: quotes the Italian interface) */
export function runningFlows(state: DemoState): OpsFlow[] {
  return world().opsFlows.filter((f) => f.status === 'attivo' && !isPaused(state, f.id)); // allow-italian: status code, compared by value
}

/** The name of a flow on every screen: the one short name (its outcome, if any, is a subtitle only in the list and the page of the flows). */
export function flowLabel(flowId: string): string {
  return opsFlowById(flowId)?.name ?? flowId;
}

export function flowCards(cards: OrbitCard[], flowId: string): OrbitCard[] {
  return cards.filter((c) => c.flow === flowId);
}

/**
 * The step a card stands at now: its own step while the column agrees, else
 * the first step of the flow in the column the card was moved to.
 */
export function liveStep(card: OrbitCard, flow: OpsFlow): OpsFlowStep | undefined {
  const stage = stageOf(card);
  const own = flow.steps.find((s) => s.id === card.step);
  if (own && own.stage === stage) return own;
  return flow.steps.find((s) => s.stage === stage) ?? own;
}

export function cardsAtStep(cards: OrbitCard[], flow: OpsFlow, stepId: string): OrbitCard[] {
  return flowCards(cards, flow.id).filter((c) => liveStep(c, flow)?.id === stepId);
}

/** Cards not yet in «Fatto». (allow-italian: quotes the Italian interface) */
export function openCards(cards: OrbitCard[]): OrbitCard[] {
  return cards.filter((c) => stageOf(c) !== 'fatto'); // allow-italian: stage id, compared by value
}

/** How many steps of a flow an agent does. */
export function agentStepCount(flow: OpsFlow): number {
  return flow.steps.filter((s) => s.actor.kind === 'agent').length;
}

/** The agents a flow uses, in step order, each once. */
export function flowAgents(flow: OpsFlow): string[] {
  return [...new Set(flow.steps.flatMap((s) => (s.actor.kind === 'agent' ? [s.actor.id] : [])))];
}

/** The first step after `stepId` that a person does: who checks what this step did. */
export function personAfter(flow: OpsFlow, stepId: string): OpsFlowStep | undefined {
  const at = flow.steps.findIndex((s) => s.id === stepId);
  return flow.steps.slice(at + 1).find((s) => s.actor.kind === 'person');
}

/**
 * The cases a try of the flow runs on: the cards of the flow that moved on
 * the day before `today`; when there were none, the two that moved last.
 */
export function yesterdayCases(cards: OrbitCard[], flowId: string, today: string): { day: string; fallback: boolean; cases: OrbitCard[] } {
  const day = addDays(today, -1);
  const own = flowCards(cards, flowId);
  const moved = own.filter((c) => c.history.some((h) => h.at.startsWith(day)));
  if (moved.length) return { day, fallback: false, cases: moved };
  const last = (c: OrbitCard) => c.history[c.history.length - 1]?.at ?? '';
  return { day, fallback: true, cases: [...own].sort((a, b) => last(b).localeCompare(last(a))).slice(0, 2) };
}

/** What a try finds on one case: the values the agent reads under the threshold. */
export function tryCase(card: OrbitCard): FlowTryCase {
  return { card: card.id, low: card.values.filter((v) => v.confidence < LOW_CONFIDENCE).map((v) => ({ label: v.label, confidence: v.confidence })) };
}

/** The drawing of each icon name a world can give a flow. */
const ICON_OF: Record<FlowIconName, LucideIcon> = {
  headset: Headset,
  leaf: Leaf,
  truck: Truck,
  receipt: Receipt,
  gavel: Gavel,
  'calendar-clock': CalendarClock,
  clock: Clock,
  'file-pen': FilePen,
  workflow: Workflow,
  users: Users,
  landmark: Landmark,
  'file-text': FileText,
  wallet: Wallet,
  map: MapIcon,
  droplets: Droplets,
  wrench: Wrench,
};

/** The icon of each flow, the same on every screen (the to-do list, the table per stage, the flows, a team, a program, a card). */
export function flowIcon(flowId: string): LucideIcon {
  const name = world().flowIcons[flowId];
  return name ? ICON_OF[name] : Workflow;
}

/** Whether an agent holds the card now and it is not in «Fatto»: the one definition of «In mano agli agenti». (allow-italian: quotes the Italian interface) */
export function isInAgentHand(card: OrbitCard): boolean {
  return stageOf(card) !== 'fatto' && card.worker.kind === 'agent'; // allow-italian: stage id, compared by value
}

/** Open cards an agent holds now, in any stage: the saved filter «In mano agli agenti» in Da fare (it reads `isInAgentHand` as a field), the agents' count in the sidebar and the box of Flussi. (allow-italian: quotes the Italian interface) */
export function agentsInHand(cards: OrbitCard[]): OrbitCard[] {
  return cards.filter(isInAgentHand);
}
