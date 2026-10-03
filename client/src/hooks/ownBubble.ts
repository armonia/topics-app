import type { ChatMessage } from '../types';
import { isClientGeneratedMessageId } from './streamCatchupMerge';

/**
 * THE KEY IS THE IDENTITY OF THE BUBBLE THIS WINDOW DRAWS FOR A SEND.
 *
 * Every send leaves through `useChat` `performSend` with a key
 * (`clientMessageId`, minted once and kept by every resend of the same
 * message), the server writes the person's row with it and announces that row
 * with it (`server/routes/chat.ts`). The optimistic bubble carries the same
 * key, so the announcement finds its bubble by the key alone:
 *  - not by text: another device, another window or an agent may write the
 *    very same words, and their row is not this window's to rename or remove;
 *  - not by position: a row written beside the send can sit after the bubble;
 *  - not by whether this window still streams the turn: the announcement can
 *    arrive after the POST answered 500, after a Stop, after a network error
 *    (verifier, 03/10: two copies that survived every reload).
 *
 * A bubble that has taken its row's id is that row: from then on every merge
 * goes by identity, and nothing here touches it again.
 */

/** The bubble of the send that carried `key`, still waiting for its durable name. */
export function waitsForName(row: ChatMessage, key: string): boolean {
  return row.role === 'user' && row.clientMessageId === key && isClientGeneratedMessageId(row.id);
}

/** The server announced a row with this key: it holds that message, whatever the POST answered. */
export function namedByServer(rows: readonly ChatMessage[], key: string): boolean {
  return rows.some((m) => m.role === 'user' && m.clientMessageId === key && !isClientGeneratedMessageId(m.id));
}

/**
 * The thread with this send's bubble in it. The row that already is this
 * message (the bubble a resend from the outbound queue finds under the same
 * key, or the draft's first bubble, `reuseId`) takes the key and leaves its
 * queued state: the same message is never drawn twice.
 */
export function placeOwnBubble(rows: ChatMessage[], bubble: ChatMessage & { clientMessageId: string }, reuseId?: string): ChatMessage[] {
  const at = rows.findIndex((m) => m.role === 'user' && (m.clientMessageId === bubble.clientMessageId || (!!reuseId && m.id === reuseId)));
  if (at < 0) return [...rows, bubble];
  const { queued: _queued, ...held } = rows[at]!;
  const out = [...rows];
  out[at] = { ...held, clientMessageId: bubble.clientMessageId, partial: false };
  return out;
}

/**
 * THE REAL NAME OF THE BUBBLE YOU JUST WROTE: the row the server stored with
 * `key` takes the place of the bubble that waits for it. If that row is
 * already in the thread under its own id (it was drawn before the bubble was
 * renamed), the bubble is its double and goes.
 *
 * Returns the SAME array when there is nothing to adopt: no bubble waits for
 * this key (another window's row, a row with no key, a bubble already named).
 */
export function adoptDurableMessageId(rows: ChatMessage[], key: string, durableId: string): ChatMessage[] {
  if (!key || !durableId) return rows;
  const at = rows.findIndex((m) => waitsForName(m, key));
  if (at < 0) return rows;
  if (rows.some((m) => m.id === durableId)) return rows.filter((_, i) => i !== at);
  const { queued: _queued, ...bubble } = rows[at]!;
  const out = [...rows];
  out[at] = { ...bubble, id: durableId, partial: false };
  return out;
}

/**
 * What a send that did not complete leaves in the thread, by its key and its
 * placeholder's id, never by position:
 *  - `withdraw`: the message is the queue's again, or the server's (it
 *    answered `duplicate_message`): the bubble goes, unless the server already
 *    named it, and then it IS the stored row;
 *  - `queued`: it waits in the outbound queue: the bubble stays, marked;
 *  - `keep`: the bubble stays as it is (the server holds the row, or the
 *    person reads the error beside it).
 * The reply's placeholder goes in every case while it holds nothing worth
 * keeping (a few characters at most, no thinking).
 */
export function afterUnfinishedSend(
  rows: ChatMessage[],
  key: string,
  placeholderId: string | undefined,
  fate: 'withdraw' | 'queued' | 'keep',
): ChatMessage[] {
  let changed = false;
  const out: ChatMessage[] = [];
  for (const m of rows) {
    if (m.id === placeholderId && m.role === 'assistant' && (m.content ?? '').length < 10 && !m.thinking) {
      changed = true;
      continue;
    }
    if (fate !== 'keep' && waitsForName(m, key)) {
      changed = true;
      if (fate === 'queued') out.push({ ...m, partial: true, queued: true });
      continue;
    }
    out.push(m);
  }
  return changed ? out : rows;
}
