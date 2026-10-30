import { API_CALLER_CREATED_BY, splitCreatedBy } from '../../../../shared/created-by';

/** The translator the card already has: key plus params in, a sentence out. */
type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * The words on the card for `Task.createdBy`: "opened by jarvis" / "opened by
 * schedule x". The chip answers one question, «whose is this, who closes it»,
 * so it appears only where that has an answer worth reading: a card still open
 * (not `done`) that a NAMED agent or schedule opened. Nothing for a person's own
 * cards (the board is full of them: «opened by you» on every card is noise), for
 * the anonymous API fallback (`agent:api`, a script that named nobody), for a
 * closed card, or when there is no author (born before the field). No chip
 * beats a made-up one, and a card without a chip keeps the height it had.
 */
export function openedByLabel(createdBy: string | null | undefined, status: string, tr: Translate): string | null {
  if (status === 'done') return null;
  const parts = splitCreatedBy(createdBy);
  if (!parts || parts.kind === 'human' || createdBy === API_CALLER_CREATED_BY) return null;
  if (parts.kind === 'cron') return tr('board.card.createdByCron', { name: parts.name ?? '' });
  return tr('board.card.createdByAgent', { name: parts.name ?? '' });
}
