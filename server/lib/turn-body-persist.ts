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
  updateLastMessage: (sessionKey: string, updates: Partial<StoredMessage>) => unknown;
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
  /** Drop a write still owed. Every caller rewrites the row whole right after. */
  dispose(): void;
}

export function createTurnBodyPersist(opts: TurnBodyPersistOptions): TurnBodyPersist {
  const { sessionKey, updateLastMessage, blocks } = opts;

  const writeNow = (withText: boolean) => {
    const timeline = blocks.length > 0 ? blocks : undefined;
    const snapshot = opts.reattachSnapshot();
    if (!snapshot) {
      updateLastMessage(sessionKey, withText
        ? { content: opts.content(), thinking: opts.thinking() || undefined, blocks: timeline }
        : { blocks: timeline });
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
    });
  };

  // Sticky: a periodic save that gets deferred and then rides a later tool
  // event must not lose its `content` on the way.
  let owesText = false;
  const throttle = createBlockPersistThrottle({
    write: () => { const withText = owesText; owesText = false; writeNow(withText); },
  });

  return {
    request(withText: boolean, sizeBytes: number, force = false) {
      if (withText) owesText = true;
      throttle.persist(sizeBytes, force);
    },
    dispose() { throttle.dispose(); },
  };
}
