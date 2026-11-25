/**
 * The owner chip's data: tone, name and sentence for each owner
 * (`cardOrigin.ts`). Pure, so the card, the drawer, the filter bar and the
 * group headers say the same words; `OriginChipView.tsx` draws it.
 */
import { MAIN_AGENT, agentName } from '../../../../shared/agent-home';
import type { BoardTask } from '../../lib/board';
import { cardOwner, ownerKindOfKey, type OwnerKey, type OwnerKind } from './cardOrigin';

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** The tone of each owner: the main agent wears the one accent, other agents violet, the rest stays neutral. */
export function ownerTone(key: OwnerKey): string {
  const kind = ownerKindOfKey(key);
  if (kind === 'agent') return key === `agent:${MAIN_AGENT}` ? 'bg-blue-500/15 text-blue-800 dark:text-blue-300' : 'bg-violet-500/15 text-violet-800 dark:text-violet-300';
  if (kind === 'scheduled') return 'bg-sky-500/15 text-sky-800 dark:text-sky-300';
  return 'bg-slate-500/15 text-slate-700 dark:text-slate-300';
}

/** The owner's name for a filter or a group header («Tu», «Board», «Jarvis»...). */
export function ownerLabel(key: OwnerKey, tr: Translate): string {
  const kind = ownerKindOfKey(key);
  return kind === 'agent' ? agentName(key.slice('agent:'.length)) : tr(`board.owner.${kind}`);
}

export interface OwnerChip {
  key: OwnerKey;
  kind: OwnerKind;
  /** The text on the chip; empty for the person and the board (icon only). */
  label: string;
  /** The whole sentence, for the tooltip and the accessible name. */
  title: string;
  /** The chat to open on click, when there is one. */
  openTopicId: string | null;
}

export function ownerChip(
  task: Pick<BoardTask, 'createdBy' | 'scheduled' | 'assignedTo' | 'channel' | 'openerAgent' | 'openerTopicId' | 'openerName'>,
  tr: Translate,
  personName: string | null,
): OwnerChip {
  const owner = cardOwner(task, personName);
  const opener = task.openerTopicId ?? null;
  switch (owner.kind) {
    case 'me': return { key: owner.key, kind: owner.kind, label: '', title: tr('board.owner.meTitle'), openTopicId: null };
    case 'board': return { key: owner.key, kind: owner.kind, label: '', title: tr('board.owner.boardTitle'), openTopicId: null };
    case 'agent': {
      const name = agentName(owner.agentId!);
      return { key: owner.key, kind: owner.kind, label: name, title: tr('board.owner.agentTitle', { name }), openTopicId: task.channel?.topicId ? null : opener };
    }
    case 'session': {
      const name = task.openerName?.trim() || tr('board.owner.sessionUnnamed');
      return { key: owner.key, kind: owner.kind, label: name, title: tr('board.owner.sessionTitle', { name }), openTopicId: opener };
    }
    case 'scheduled': {
      const who = task.scheduled?.by?.trim() || task.createdBy?.replace(/^cron:/, '') || '';
      const title = who ? tr('board.owner.scheduledTitle', { who }) : tr('board.owner.scheduledTitleAnon');
      return { key: owner.key, kind: owner.kind, label: tr('board.owner.scheduledChip'), title, openTopicId: null };
    }
  }
}
