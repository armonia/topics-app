import type { BoardTask } from '../../lib/board';

/** The translator the card already has: key plus params in, a sentence out. */
type Translate = (key: string, params?: Record<string, string | number>) => string;

/** The chip for a card still open that lacks what lets it finish by itself. */
export function incompleteChip(
  task: Pick<BoardTask, 'createdMissing' | 'status'>,
  tr: Translate,
): { label: string; title: string } | null {
  if (task.status === 'done' || !task.createdMissing?.length) return null;
  const names = task.createdMissing.map((g) => tr(`board.card.missing.${g}`)).join(', ');
  return { label: tr('board.card.incomplete'), title: tr('board.card.incompleteTitle', { missing: names }) };
}
