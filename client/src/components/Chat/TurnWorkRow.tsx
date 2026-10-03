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

export function TurnWorkRow({ tools, children, messageId, foldedTexts }: {
  tools: ToolCall[];
  children: ReactNode;
  /** For the chat find bar: the message, and the text and reasoning folded. */
  messageId?: string;
  foldedTexts?: readonly string[];
}) {
  return (
    <TaskWorkAccordion tools={tools} testId="turn-work-fold" messageId={messageId} foldedTexts={foldedTexts}>
      {children}
    </TaskWorkAccordion>
  );
}
