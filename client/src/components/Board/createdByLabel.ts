import { splitCreatedBy } from '../../../../shared/created-by';

/** The translator the card already has: key plus params in, a sentence out. */
type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * The words on the card for `Task.createdBy`: "opened by you" / "opened by
 * jarvis" / "opened by schedule x". `null` when the card has no author (born
 * before the field, or from an internal path): no chip beats a made-up one.
 */
export function openedByLabel(createdBy: string | null | undefined, tr: Translate): string | null {
  const parts = splitCreatedBy(createdBy);
  if (!parts) return null;
  if (parts.kind === 'human') return tr('board.card.createdByHuman');
  if (parts.kind === 'cron') return tr('board.card.createdByCron', { name: parts.name ?? '' });
  return tr('board.card.createdByAgent', { name: parts.name ?? '' });
}
