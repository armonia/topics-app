import { API_CALLER_CREATED_BY, splitCreatedBy } from '../../../../shared/created-by';
import type { BoardTask } from '../../lib/board';

/** The translator the card already has: key plus params in, a sentence out. */
type Translate = (key: string, params?: Record<string, string | number>) => string;

/** `human` = a person's card, `other` = an agent or a schedule, `unknown` = born before the field. */
export function creatorKind(createdBy: string | null | undefined): 'human' | 'other' | 'unknown' {
  const parts = splitCreatedBy(createdBy);
  if (!parts) return 'unknown';
  return parts.kind === 'human' ? 'human' : 'other';
}

export interface CreatorChip {
  kind: 'human' | 'other';
  /** The short text on the chip: the chat or agent name, or «you». */
  label: string;
  /** The avatar letter for an agent that has a name; null means draw the icon. */
  initial: string | null;
  /** The whole sentence, for the tooltip. */
  title: string;
  /** The chat to open on click, only when it exists and is an ordinary chat. */
  openTopicId: string | null;
}

/**
 * The creator chip: who opened the card, readable at a glance. A person's card
 * says «you»; an agent's card names the chat it came from (or the agent), with
 * the channel in the tooltip. Nothing for a card born before the field: no chip
 * beats a made-up one.
 */
export function creatorChip(
  task: Pick<BoardTask, 'createdBy' | 'createdSource' | 'openerName' | 'openerTopicId'>,
  tr: Translate,
): CreatorChip | null {
  const parts = splitCreatedBy(task.createdBy);
  if (!parts) return null;
  if (parts.kind === 'human') {
    const label = tr('board.card.createdByMe');
    return { kind: 'human', label, title: tr('board.card.createdByTitle', { who: label }), initial: null, openTopicId: null };
  }
  const fallback = task.createdBy === API_CALLER_CREATED_BY
    ? tr('board.card.createdByApi')
    : parts.kind === 'cron'
      ? tr('board.card.createdByCron', { name: parts.name ?? '' })
      : (parts.name ?? '');
  const label = task.openerName || fallback;
  const named = task.openerName || (task.createdBy === API_CALLER_CREATED_BY ? '' : fallback);
  const initial = named ? Array.from(named.trim())[0]?.toUpperCase() ?? null : null;
  const who = task.createdSource ? `${label} (${task.createdSource})` : label;
  // The coordinator lives in a drawer, not in a tab a click could open.
  const openTopicId = task.openerTopicId && task.createdBy !== 'agent:coordinator' ? task.openerTopicId : null;
  return { kind: 'other', label, title: tr('board.card.createdByTitle', { who }), initial, openTopicId };
}

/** The chip for a card still open that lacks what lets it finish by itself. */
export function incompleteChip(
  task: Pick<BoardTask, 'createdMissing' | 'status'>,
  tr: Translate,
): { label: string; title: string } | null {
  if (task.status === 'done' || !task.createdMissing?.length) return null;
  const names = task.createdMissing.map((g) => tr(`board.card.missing.${g}`)).join(', ');
  return { label: tr('board.card.incomplete'), title: tr('board.card.incompleteTitle', { missing: names }) };
}
