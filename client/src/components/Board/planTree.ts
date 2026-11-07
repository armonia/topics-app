/** Pure part of the Plan view: no React, testable on its own. */
import type { PlanArea, PlanProject, PlanSignal } from './planApi';

/** Whole-number progress percentage; 0 when there are no cards. */
export function progressPct(p: { total: number; done: number }): number {
  return p.total === 0 ? 0 : Math.round((p.done / p.total) * 100);
}

/** Short "3/8" label next to the bar. */
export function progressLabel(p: { total: number; done: number }): string {
  return `${p.done}/${p.total}`;
}

/** Cards still open in a group: what is left to do, not its history. */
export function openOf(p: { total: number; done: number }): number {
  return p.total - p.done;
}

/** i18n key of a signal badge. */
export const SIGNAL_KEY: Record<PlanSignal, string> = {
  duplicate: 'plan.signal.duplicate',
  delivered_but_open: 'plan.signal.deliveredOpen',
  no_owner: 'plan.signal.noOwner',
  stale: 'plan.signal.stale',
};

/** The milestones a card of this project can move to, in tree order. */
export function milestoneChoices(project: PlanProject): { id: string; label: string }[] {
  return project.areas.flatMap((a: PlanArea) => a.milestones.map((m) => ({ id: m.id, label: `${a.name} / ${m.title}` })));
}

/** Expansion keys, one shape for every level. */
export const nodeKey = (kind: 'project' | 'area' | 'milestone' | 'unplaced', id: string) => `${kind}:${id}`;

/** Distinct signals of a set of milestones, to keep them visible on a closed node. */
export function branchSignals(milestones: readonly { signals: readonly PlanSignal[] }[]): PlanSignal[] {
  return [...new Set(milestones.flatMap((m) => m.signals))];
}
