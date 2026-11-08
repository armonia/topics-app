/**
 * The closed row that holds a finished turn's work, above its answer
 * (`turnFold.ts` decides what goes in). Same look and same summary line as the
 * board task's fold, so the two read as one language: how many actions, how
 * many failed, which files, how long. It opens onto exactly the rows that were
 * there before.
 */
import type { ReactNode } from 'react';
import type { ToolCall } from '../../types';
import { TaskWorkAccordion } from './TaskWorkAccordion';
import type { FoldableGroup } from './turnFold';

export function TurnWorkRow({ tools, work, children, messageId }: {
  tools: ToolCall[];
  /** The groups folded, for the chat find bar: their text and reasoning. */
  work: readonly FoldableGroup[];
  children: ReactNode;
  /** For the chat find bar: the message the turn belongs to. */
  messageId?: string;
}) {
  const foldedTexts = work.flatMap((g) => (g.kind === 'text' || g.kind === 'thinking' ? [g.text] : []));
  return (
    <TaskWorkAccordion tools={tools} testId="turn-work-fold" messageId={messageId} foldedTexts={foldedTexts}>
      {children}
    </TaskWorkAccordion>
  );
}
