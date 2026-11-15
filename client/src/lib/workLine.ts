/**
 * Countdown and weight of work in progress as one plain line, for the places
 * that have only text: a tab's tooltip, the rows of the lists, the tray menu.
 * The same two calculations the components draw (`taskCountdown`,
 * `sessionWeight`), so a line and a chip cannot disagree.
 *
 * Each part is present only if it is known: no estimate, no countdown; no
 * context from the provider, no percent; nothing spent, no tokens. With
 * nothing known the line is empty.
 */
import { sessionWeight, taskCountdown, type RunningSummary } from '../../../shared/task-countdown';
import type { WorkWeight } from '../../../shared/live-work';
import { fmtTok } from '../components/Board/format';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

export interface WorkLineInput {
  /** Departure estimate, ms; absent or null = none. */
  estimateMs?: number | null;
  elapsedMs: number;
  stepsDone?: number;
  stepsTotal?: number;
  weight?: WorkWeight | null;
}

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

export function workLine(tr: Translate, i: WorkLineInput): string {
  const parts: string[] = [];
  const c = taskCountdown({ estimateMs: i.estimateMs ?? null, elapsedMs: i.elapsedMs, stepsDone: i.stepsDone, stepsTotal: i.stepsTotal });
  if (c) parts.push(c.kind === 'over' ? tr('board.countdown.over', { min: minutes(c.overMs) }) : tr('board.countdown.left', { min: minutes(c.remainingMs) }));
  if (i.weight) {
    const w = sessionWeight({ ...i.weight });
    if (w.percent != null && w.usedTokens != null) parts.push(tr('workLine.context', { approx: w.estimated ? '≈ ' : '', pct: w.percent, used: fmtTok(w.usedTokens) }));
    if (w.billableTokens > 0) parts.push(tr('workLine.tokens', { n: fmtTok(w.billableTokens) }));
  }
  return parts.join(' · ');
}

/** What a count of work in progress says about time: when the first should be done, how many are late. Empty when nothing is known. */
export function runningLine(tr: Translate, s: RunningSummary): string {
  const parts: string[] = [];
  if (s.soonestLeftMs !== null) parts.push(tr('board.countdown.left', { min: minutes(s.soonestLeftMs) }));
  if (s.over > 0) parts.push(tr('workLine.late', { n: s.over }));
  return parts.join(' · ');
}
