/**
 * The ONE number Topics paints on the operating system: the dock badge, the
 * macOS menu-bar tray glyph, and the PWA Badging API all project the value this
 * module computes, and nothing else computes it.
 *
 * One criterion: HOW MANY THINGS ARE ASKING A HUMAN FOR SOMETHING. That is
 *   - every non-archived chat that is unread or waiting for the user
 *     (`topicAttentionCount`, the same helper each sidebar row and tab uses);
 *   - every claude-code terminal whose turn finished and has not been opened
 *     (`terminalAttentionCount`, again the per-row helper);
 *   - every window-local pane badge (`paneCounts`, the notification layer's
 *     `extraCounts`, which the sidebar utility rows read through the same map);
 *   - every board card waiting for a decision (`trayBoardAttention`).
 *
 * Work that runs on its own asks nothing and does not count. An ARCHIVED topic
 * never counts: it has no row to open, so nothing could ever switch it off.
 *
 * Pure, no React, no I/O: the parity test computes its expectation from the very
 * per-row helpers the sidebar calls, so a criterion that changes on one surface
 * and not the other turns the test red instead of quietly drifting.
 */
import type { Topic } from '../types';
import { rollupGlobalAttention } from './signals';
import { trayBoardAttention, type TrayGroup } from '../../../shared/tray-board';

export interface ChromeAttentionInput {
  topics: Record<string, Topic>;
  unread: Record<string, { unreadCount: number } | undefined>;
  claudeAttentionTopics: Set<string>;
  terminalFinishedIds: Set<string>;
  boardGroups: readonly TrayGroup[];
  paneCounts: ReadonlyMap<string, number>;
}

/** Sum of the window-local pane badges (agents pane, session viewer, ...). */
export function paneAttentionTotal(paneCounts: ReadonlyMap<string, number>): number {
  let sum = 0;
  for (const n of paneCounts.values()) sum += n;
  return sum;
}

/**
 * Chats + terminals (`rollupGlobalAttention`) + pane badges + board cards in
 * review. Every OS surface reads THIS and only this.
 */
export function chromeAttentionTotal(input: ChromeAttentionInput): number {
  return rollupGlobalAttention(input.topics, input.unread, input.claudeAttentionTopics, input.terminalFinishedIds)
    + paneAttentionTotal(input.paneCounts)
    + trayBoardAttention(input.boardGroups);
}
