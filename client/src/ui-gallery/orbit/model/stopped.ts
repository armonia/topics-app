/**
 * How long a card has been stopped, from the one place the token «Ferma da N g» allow-italian: quotes the words on screen
 * of the card takes it: the moment it was blocked, else the moment it entered
 * its column. The palette, the chat and the suggestions all read it here, so
 * the same card never says two different ages.
 */
import type { OrbitCard } from '../../../ui/fixtures/orbit-org/types';
import { stageSince } from './live';
import { formatHours, hoursBetween } from './stages';

/** When the card stopped. */
export const stoppedSince = (card: OrbitCard): string => card.blocked?.since ?? stageSince(card);

/** Hours the card has been stopped at `now`. */
export const stoppedHours = (card: OrbitCard, now: string): number => hoursBetween(stoppedSince(card), now);

/** The age as the token writes it: `12 min`, `3 h 10`, `2 g`. */
export const stoppedAge = (card: OrbitCard, now: string): string => formatHours(stoppedHours(card, now));
