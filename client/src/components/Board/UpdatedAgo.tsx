import { memo, useSyncExternalStore } from 'react';
import { getMinuteClockSnapshot, subscribeMinuteClock } from '../../lib/minuteClock';
import { fmtUpdatedAt } from './format';

/**
 * The age of a card ("ora", "3m fa"), and the only part of it that listens to
 * the minute clock: a tick redraws this text, not the card around it.
 */
function UpdatedAgoText({ iso }: { iso: string }) {
  // Subscription only: the tick count says "render again", the text is
  // computed from the real time, as the card always did.
  useSyncExternalStore(subscribeMinuteClock, getMinuteClockSnapshot);
  return fmtUpdatedAt(iso);
}

/**
 * Skipped when the card re-renders with the same `iso`. NOT when the text
 * would merely come out the same ("ora" before, "ora" after a new update):
 * a skipped render leaves the OLD props on the component, and the next tick
 * would count the age from the old update, a minute ahead for good (defect D2
 * of `cloud-quality-pass` T2b, `board-card-updated-ago.spec.ts`).
 */
export const UpdatedAgo = memo(UpdatedAgoText);
