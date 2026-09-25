/**
 * The one door through which the BODY of a turn reaches its row: the periodic
 * text save and the snapshots taken on every tool event both go through here.
 *
 * Two things live together in this file because they are two halves of the
 * same question. WHAT gets written is `writeNow` below, moved out of
 * `routes/chat.ts` unchanged. WHEN it gets written is
 * `createBlockPersistThrottle`, which is what stops a long turn from paying
 * the square of its own length in bytes.
 *
 * Inside a REATTACH it applies the rule of `reattachMerge.ts` to EVERY write,
 * not just the last one: whatever the replay has not re-emitted yet stays as
 * it was. The dangerous window is as long as the replay, not as long as the
 * finalize, and a restart (or a crash) caught in the middle used to leave the
 * row with half of what was there. Outside a reattach it is the write of
 * always, at no added cost.
 *
 * `withText` tells the two calls apart: the periodic save carries text and
 * blocks, the one after a tool event carries only the blocks.
 */

import type { ContentBlock, StoredMessage } from "../types";
import { mergeReattachedRow, type RowSnapshot } from "../routes/reattachMerge";
import { createBlockPersistThrottle } from "./block-persist-throttle";

export interface TurnBodyPersistOptions {
  sessionKey: string;
  updateLastMessage: (sessionKey: string, updates: Partial<StoredMessage>, opts?: { rowId?: string }) => unknown;
  /**
   * The turn's OWN row, which every write targets. Not "the last row of the
   * session": a notice written after the turn is the last row, and it got this
   * turn's body (card 1046df0b). A function for the same reason as
   * `reattachSnapshot`: the row is born further down the handler than this.
   */
  rowId: () => string;
  /** The live timeline of the turn: read at write time, never copied. */
  blocks: ContentBlock[];
  content: () => string;
  thinking: () => string;
  /** How many tool calls this handler has seen, for the reattach merge. */
  trackedTools: () => number;
  /**
   * The row as it was before the reattach started, null outside a reattach.
   * A function because the snapshot is read from the database further down the
   * handler than this: asking for the value here would read it before it exists.
   */
  reattachSnapshot: () => RowSnapshot | null;
}

export interface TurnBodyPersist {
  /**
   * Ask for the body to be persisted. `sizeBytes` is what the timeline is
   * worth, near enough (it decides when, never what). `force` writes now.
   */
  request(withText: boolean, sizeBytes: number, force?: boolean): void;
  /**
   * Write the whole body now, text included. For a reader that is about to
   * open the ROW instead of following the stream - see lib/turn-body-flush.ts.
   */
  flush(): void;
  /** Drop a write still owed. Every caller rewrites the row whole right after. */
  dispose(): void;
}

export function createTurnBodyPersist(opts: TurnBodyPersistOptions): TurnBodyPersist {
  const { sessionKey, updateLastMessage, blocks } = opts;

  // What the body looked like at the last write. Text and thinking only grow,
  // and every other change of the timeline goes through `request`, so these
  // lengths tell a flush whether there is anything new to write.
  const mark = () => `${opts.content().length}:${opts.thinking().length}:${blocks.length}`;
  let writtenMark = "";

  const writeNow = (withText: boolean) => {
    // Taken before the write and kept only once it went through, and only by a
    // write that carries the text: after a blocks-only write the row's text
    // columns are still behind, and a flush must still write them.
    const now = mark();
    const timeline = blocks.length > 0 ? blocks : undefined;
    const snapshot = opts.reattachSnapshot();
    const own = { rowId: opts.rowId() };
    if (!snapshot) {
      updateLastMessage(sessionKey, withText
        ? { content: opts.content(), thinking: opts.thinking() || undefined, blocks: timeline }
        : { blocks: timeline }, own);
      if (withText) writtenMark = now;
      return;
    }
    const merged = mergeReattachedRow(snapshot, {
      content: opts.content(),
      thinking: opts.thinking() || undefined,
      trackedTools: opts.trackedTools(),
      blocks,
    }, "progress");
    updateLastMessage(sessionKey, {
      content: merged.content,
      thinking: merged.thinking,
      blocks: (merged.blocks as ContentBlock[] | undefined) ?? timeline,
    }, own);
    writtenMark = now;
  };

  // Sticky: a periodic save that gets deferred and then rides a later tool
  // event must not lose its `content` on the way.
  let owesText = false;
  const throttle = createBlockPersistThrottle({
    write: () => { const withText = owesText; owesText = false; writeNow(withText); },
  });

  // The size of the last request: a forced write needs one, and it only
  // decides when the NEXT deferred write goes out.
  let lastSizeBytes = 0;

  return {
    request(withText: boolean, sizeBytes: number, force = false) {
      lastSizeBytes = sizeBytes;
      if (withText) owesText = true;
      throttle.persist(sizeBytes, force);
    },
    flush() {
      // What the throttle owes is not enough for a reader of the row: the text
      // reaches it only at every tenth chunk (`SAVE_INTERVAL` in
      // routes/chat.ts), so a turn of text alone had a row with no timeline for
      // its first ten chunks. A chat opened mid-turn drew that empty timeline,
      // appended the live chunks to it, and showed the turn without its start
      // (card 423e016f). So the reader gets the body as it is NOW, and only
      // when it changed since the last write: readers come at every socket open
      // and every history read, and the throttle exists to bound these writes.
      throttle.flush();
      if (mark() === writtenMark) return;
      owesText = true;
      throttle.persist(lastSizeBytes, true);
    },
    dispose() { throttle.dispose(); },
  };
}
