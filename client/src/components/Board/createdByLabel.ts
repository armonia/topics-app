import { API_CALLER_CREATED_BY, splitCreatedBy } from '../../../../shared/created-by';

/** The translator the card already has: key plus params in, a sentence out. */
type Translate = (key: string, params?: Record<string, string | number>) => string;

export type CreatorKind = 'human' | 'agent' | 'cron';

/** Who opened the card, as a kind: drives the chip colour and the "mine" filter. `null` = born before the field. */
export function creatorKind(createdBy: string | null | undefined): CreatorKind | null {
  return splitCreatedBy(createdBy)?.kind ?? null;
}

/**
 * The words on the card for `Task.createdBy`, always: "opened by you" for a
 * person, "opened by jarvis" for a named agent, "opened from a session" for a
 * chat agent (`agent:session`; the chip links to that chat). Nothing for a
 * closed card or when there is no author (cards born before the field stay
 * readable and carry no made-up chip).
 */
export function openedByLabel(createdBy: string | null | undefined, status: string, tr: Translate, openerName?: string | null): string | null {
  if (status === 'done') return null;
  const parts = splitCreatedBy(createdBy);
  if (!parts) return null;
  if (parts.kind === 'human') return tr('board.card.createdByHuman');
  // The anonymous fallback names nobody: no chip beats a made-up one.
  if (createdBy === API_CALLER_CREATED_BY) return null;
  if (parts.kind === 'cron') return tr('board.card.createdByCron', { name: parts.name ?? '' });
  // The chat's own name beats «a chat»: it says WHICH one.
  if (parts.name === 'session' && openerName) return tr('board.card.createdByChat', { name: openerName });
  if (parts.name === 'session') return tr('board.card.createdBySession');
  return tr('board.card.createdByAgent', { name: parts.name ?? '' });
}
