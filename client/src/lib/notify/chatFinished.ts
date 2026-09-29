// The chat twin of the terminal "finished" banner, pure so it is testable.
//
// A terminal banners when its turn ends whatever its runtime: the pty goes quiet
// and the server sends `terminal:activity { finished: true }`, hooks or not. A
// chat had no such edge on the client. It bannered only through `session:state`
// (which exists only for runtimes that report Claude Code hooks) or through
// `message:new` (which requires a HIDDEN window, while a Topics window behind
// another app is `visible`). Chats on provider `topics`, Topics routing, codex,
// jcode or ACP therefore finished in silence: 49 of 57 chat turn ends between
// 27/09 and 29/09 raised no banner anywhere.
//
// The edge every runtime does send is `stream:end { completed: true }`. The
// server already announces it as the reply push; this module decides the
// in-page banner for the same fact.

import { statusBody } from './terminalNotify';
import { createPaneId } from '../../state/pane/adapters/paneConfig';
import { bannerClaimKey } from './messageBannerClaim';
import { isCleanChatTurnEnd, type ChatTurnEnd } from '../../../../shared/chat-turn-end';

export interface ChatFinishedBannerInput {
  topicId: string;
  /** Settings → Notifications master switch. */
  notificationsEnabled: boolean;
  /** Topic name, or null/undefined when this window cannot resolve it. */
  topicName: string | null | undefined;
  /** Archived chats do not announce: the server push skips them too. */
  archived: boolean;
  /** Per-topic or per-project mute (muteGate.ts). */
  muted: boolean;
  /** A board agent is working this topic now: `task:review-ready` speaks. */
  agentWorking: boolean;
  /** This chat is the selected pane AND the window has OS focus. */
  isFocusedAndVisible: boolean;
  notifyEvenWhenFocused: boolean;
  /** Last banner for this topic on any "turn ended" path, or undefined. */
  lastFiredAt: number | undefined;
  now: number;
}

export interface ChatFinishedBannerDecision {
  title: string;
  body: string;
  /** The bare topic id: the same key the `session:state` chat path writes, so a
   *  hook chat (whose awaiting-user frame arrives just before `stream:end`)
   *  still gets ONE banner per finished turn. */
  cooldownKey: string;
}

export const CHAT_FINISHED_REPEAT_WINDOW_MS = 10_000;

export function decideChatFinishedBanner(i: ChatFinishedBannerInput): ChatFinishedBannerDecision | null {
  if (!i.notificationsEnabled) return null;
  if (!i.topicName) return null;
  if (i.archived || i.muted) return null;
  if (i.agentWorking) return null;
  if (i.isFocusedAndVisible && !i.notifyEvenWhenFocused) return null;
  if (i.lastFiredAt !== undefined && i.now - i.lastFiredAt < CHAT_FINISHED_REPEAT_WINDOW_MS) return null;
  return {
    title: i.topicName,
    // Same sentence as the hook path for the same fact: the turn ended, your turn.
    body: statusBody('awaiting-user'),
    cooldownKey: i.topicId,
  };
}

/**
 * Is the chat `topicId` the pane the user has selected? The App-level focused
 * pane of a chat is its bare topic id (or `chat:<id>`); a chat inside a project
 * leaves the App-level id on `project:<path>` and publishes its inner pane in
 * `activePaneByProject`, the same two levels `isTerminalPaneSelected` reads.
 * Exact comparisons only: a pane whose id merely contains this id must not
 * silence someone else's banner.
 */
export function isChatPaneSelected(
  topicId: string,
  focusedPanelId: string | null | undefined,
  activePaneByProject: Record<string, string | null> = {},
): boolean {
  if (!focusedPanelId) return false;
  const chatPaneId = createPaneId('chat', topicId);
  if (focusedPanelId === topicId || focusedPanelId === chatPaneId) return true;
  if (!focusedPanelId.startsWith('project:')) return false;
  for (const [projectPath, activePaneId] of Object.entries(activePaneByProject)) {
    if (activePaneId !== chatPaneId && activePaneId !== topicId) continue;
    if (createPaneId('project', projectPath) === focusedPanelId) return true;
  }
  return false;
}

/**
 * The claim key of a turn-end banner: the SAME key `message:new` claims for the
 * reply of that turn. The server stamps both frames with the id of the one
 * assistant row (`server/routes/chat.ts`), so a window that banners on
 * `message:new` (hidden) and one that banners on `stream:end` (visible, behind
 * another app) compete for one claim and raise ONE banner. With a key of its own
 * each path won its own claim and the turn rang twice.
 *
 * Without a `messageId` the fallback cannot meet the `message:new` key, and it
 * stays per turn end so two windows still share it.
 */
export function turnEndClaimKey(end: { topicId: string; messageId?: string; latencyMs?: number }): string {
  if (end.messageId) return bannerClaimKey({ messageId: end.messageId, topicId: end.topicId, role: 'assistant' });
  return `turn-end:${end.topicId}:${end.latencyMs ?? ''}`;
}

/**
 * What a stream frame does to the chat "finished" mark, the twin of what
 * `terminal:activity` does to the terminal one: a clean turn end raises it (the
 * same rule the banner and the server push read), a new turn drops it. Anything
 * else leaves it alone: an aborted or failed turn is not "finished, your turn".
 *
 * `inFront` says whether the person is looking at the chat right now
 * (`isChatInFront`): a turn that ends there raises no mark, decided here and
 * not by clearing it a commit later, which reached the Dock number.
 */
export function chatFinishedEdge(
  frame: { type: string; topicId?: unknown } & ChatTurnEnd,
  inFront: (topicId: string) => boolean = () => false,
): { op: 'mark' | 'clear'; topicId: string } | null {
  if (frame.type === 'stream:end') {
    return isCleanChatTurnEnd(frame) && !inFront(frame.topicId) ? { op: 'mark', topicId: frame.topicId } : null;
  }
  if (frame.type === 'stream:start' && typeof frame.topicId === 'string' && frame.topicId) {
    return { op: 'clear', topicId: frame.topicId };
  }
  return null;
}
