/**
 * The number shown next to each prompt the person typed: «#50».
 *
 * The server stamps `promptNumber` on the history it sends, counted on the
 * WHOLE thread (`shared/prompt-number.ts`), because the page the client holds
 * may be only the tail. A prompt sent from this window since that load has no
 * stamp yet: it gets the previous stamped number plus one per person prompt in
 * between. Before the first stamp nothing is invented, the count starts at the
 * top of what is loaded only when the whole thread is here.
 */
import type { ChatMessage } from '../../types';
import { isMachineRow } from './machineRow';

const CONTEXT_PREFIX = '[Chat messages since your last reply';

function isPersonPrompt(m: ChatMessage): boolean {
  if (m.role !== 'user') return false;
  if ((m.content ?? '').startsWith(CONTEXT_PREFIX)) return false;
  return !isMachineRow(m.blocks);
}

export function resolvePromptNumbers(
  messages: readonly ChatMessage[],
  historyComplete: boolean,
): Map<string, number> {
  const out = new Map<string, number>();
  let last: number | null = historyComplete ? 0 : null;
  for (const m of messages) {
    if (!isPersonPrompt(m)) continue;
    const stamped = m.promptNumber;
    if (typeof stamped === 'number' && stamped > 0) {
      last = stamped;
    } else if (last !== null) {
      last += 1;
    } else {
      continue;
    }
    out.set(m.id, last);
  }
  return out;
}
