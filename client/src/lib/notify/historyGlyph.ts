/**
 * How a row of the notification history is drawn: its lucide icon, picked from
 * the row's `kind`, and its title as words only.
 *
 * The server titles used to open with an emoji (a pictograph as the icon). They
 * now carry words only (`server/push-triggers.ts`), and the icon is drawn here
 * from the kind, with the same glyphs the bell's "now" tab uses for the same
 * facts (`REASON_ICON` in `InboxPanel.tsx`). Rows written before that change
 * still hold the emoji in the database: `historyTitle` drops it on read.
 */
import { CircleX, GitPullRequest, MessageCircleQuestion, MessageSquare, PauseCircle, Server, SquareCheck, TerminalSquare, type LucideIcon } from 'lucide-react';
import type { NotificationRow } from '../../../../shared/notification-log';

const KIND_ICON: Partial<Record<NotificationRow['kind'], LucideIcon>> = {
  system: Server,
  terminal: TerminalSquare,
  'task-review': GitPullRequest,
  'task-parked': PauseCircle,
  'chat-error': CircleX,
  session: MessageCircleQuestion,
  'chat-message': MessageSquare,
};

/** The icon of a history row: by kind, then by where the click lands. */
export function historyRowIcon(row: Pick<NotificationRow, 'kind' | 'groupKey' | 'targetKind'>): LucideIcon {
  if (row.kind !== 'system' && row.groupKey?.startsWith('terminal:')) return TerminalSquare;
  return KIND_ICON[row.kind] ?? (row.targetKind === 'task' ? SquareCheck : MessageSquare);
}

const LEADING_PICTOGRAPHS = /^[\p{Extended_Pictographic}️‍\s]+/u;

/** The title without the emoji an older row opens with; unchanged otherwise. */
export function historyTitle(title: string): string {
  const words = title.replace(LEADING_PICTOGRAPHS, '');
  return words || title;
}
