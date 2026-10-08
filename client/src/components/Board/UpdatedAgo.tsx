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
 * A `task:updated` frame re-renders its card and hands this a new `iso`; when
 * the text would come out the same ("ora" before, "ora" after) it is skipped,
 * so a frame costs the renders it cost before the clock.
 */
export const UpdatedAgo = memo(
  UpdatedAgoText,
  (prev, next) => prev.iso === next.iso || fmtUpdatedAt(prev.iso) === fmtUpdatedAt(next.iso),
);
