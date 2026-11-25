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
import { sessionWeight, taskCountdown, type EstimateBasis, type RunningSummary } from '../../../shared/task-countdown';
import type { WorkWeight } from '../../../shared/live-work';
import { fmtTok } from '../components/Board/format';
import { countdownText, etaText } from './etaText';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

export interface WorkLineInput {
  /** What the estimate is read from; absent or null = none. */
  basis?: EstimateBasis | null;
  elapsedMs: number;
  stepsDone?: number;
  stepsTotal?: number;
  weight?: WorkWeight | null;
}

/** A sub-agent row's estimate as the wire carries it: the departure figure and, when sent, the durations behind it. */
export function childBasis(estimateMs: number | undefined, historyMs: number[] | undefined): EstimateBasis | null {
  return estimateMs && estimateMs > 0 ? { departureMs: estimateMs, historyMs: historyMs ?? [] } : null;
}

export function workLine(tr: Translate, i: WorkLineInput): string {
  const parts: string[] = [];
  const c = taskCountdown({ basis: i.basis ?? null, elapsedMs: i.elapsedMs, stepsDone: i.stepsDone, stepsTotal: i.stepsTotal });
  if (c) parts.push(countdownText(tr, c));
  if (i.weight) {
    const w = sessionWeight({ ...i.weight });
    if (w.percent != null && w.usedTokens != null) parts.push(tr('workLine.context', { approx: w.estimated ? '≈ ' : '', pct: w.percent, used: fmtTok(w.usedTokens) }));
    if (w.billableTokens > 0) parts.push(tr('workLine.tokens', { n: fmtTok(w.billableTokens) }));
  }
  return parts.join(' · ');
}

/** What a count of work in progress says about time: when the first should be done, how many were re-estimated. Empty when nothing is known. */
export function runningLine(tr: Translate, s: RunningSummary): string {
  const parts: string[] = [];
  if (s.soonestLeftMs !== null) parts.push(tr('board.countdown.left', { time: etaText(tr, s.soonestLeftMs) }));
  if (s.revised > 0) parts.push(tr('workLine.revised', { n: s.revised }));
  return parts.join(' · ');
}
