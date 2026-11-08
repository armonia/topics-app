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

/** Where a status stands when a tile shows only the first few cards: what moves first, what waits last. */
const STATUS_RANK: Record<string, number> = { in_progress: 0, review: 1, todo: 2, backlog: 3, done: 4 };

/** Cards in tile order: in progress and to approve first, then to do, backlog, done; stable inside a status. */
export function sortForPlan<T extends { status: string }>(cards: readonly T[]): T[] {
  return cards
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (STATUS_RANK[a.c.status] ?? 3) - (STATUS_RANK[b.c.status] ?? 3) || a.i - b.i)
    .map((x) => x.c);
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
