/**
 * The chat twin of the terminal "finished" banner: every gate between a clean
 * `stream:end` and an OS banner, the edge that raises and drops the chat's
 * 'done' mark, and the claim key that keeps two windows at one banner.
 *
 * @covers CHAT-DONE-01, CHAT-DONE-02
 */
import { describe, expect, it } from 'bun:test';
import {
  CHAT_FINISHED_REPEAT_WINDOW_MS,
  chatFinishedEdge,
  decideChatFinishedBanner,
  isChatPaneSelected,
  turnEndClaimKey,
  type ChatFinishedBannerInput,
} from './chatFinished';
import { bannerClaimKey, claimBannerIn, type ClaimStorage } from './messageBannerClaim';
import { isCleanChatTurnEnd } from '../../../../shared/chat-turn-end';

// The case that MUST banner. Every test below changes one field, so what it
// measures is that gate and not the sum of the gates.
function passing(over: Partial<ChatFinishedBannerInput> = {}): ChatFinishedBannerInput {
  return {
    topicId: 't1',
    notificationsEnabled: true,
    topicName: 'Parser',
    archived: false,
    muted: false,
    agentWorking: false,
    isFocusedAndVisible: false,
    notifyEvenWhenFocused: false,
    lastFiredAt: undefined,
    now: 1_000_000,
    ...over,
  };
}

describe('isCleanChatTurnEnd: the same gates as the server reply push', () => {
  it('a clean end of a human chat turn counts', () => {
    expect(isCleanChatTurnEnd({ topicId: 't1', completed: true })).toBe(true);
  });

  it('no `completed` marker: an error, a cancel or the SSE finally', () => {
    expect(isCleanChatTurnEnd({ topicId: 't1' })).toBe(false);
    expect(isCleanChatTurnEnd({ topicId: 't1', completed: false })).toBe(false);
  });

  it('a board agent turn is not a chat that finished for you', () => {
    expect(isCleanChatTurnEnd({ topicId: 't1', completed: true, dispatched: true })).toBe(false);
  });

  it('a stop by the user, the watchdog or a cancel is not a finish', () => {
    expect(isCleanChatTurnEnd({ topicId: 't1', completed: true, reason: 'user_abort' })).toBe(false);
    expect(isCleanChatTurnEnd({ topicId: 't1', completed: true, stopCause: 'watchdog' })).toBe(false);
    expect(isCleanChatTurnEnd({ topicId: 't1', completed: true, stopReason: 'cancelled' })).toBe(false);
  });

  it('without a topic there is nothing to name nor to open', () => {
    expect(isCleanChatTurnEnd({ completed: true })).toBe(false);
    expect(isCleanChatTurnEnd({ topicId: '', completed: true })).toBe(false);
  });
});

describe('decideChatFinishedBanner', () => {
  it('banners with the topic name and the same sentence as the hook path', () => {
    expect(decideChatFinishedBanner(passing())).toEqual({
      title: 'Parser',
      body: 'In attesa di te',
      cooldownKey: 't1',
    });
  });

  it('the cooldown key is the bare topic id, shared with the session:state chat path', () => {
    // A hook chat publishes awaiting-user a few hundred ms before stream:end:
    // one finished turn must stay one banner.
    expect(decideChatFinishedBanner(passing())!.cooldownKey).toBe('t1');
  });

  it('master switch off → silent', () => {
    expect(decideChatFinishedBanner(passing({ notificationsEnabled: false }))).toBeNull();
  });

  it('unknown topic → silent (no title to show)', () => {
    expect(decideChatFinishedBanner(passing({ topicName: undefined }))).toBeNull();
    expect(decideChatFinishedBanner(passing({ topicName: '' }))).toBeNull();
  });

  it('archived or muted topic → silent, like the server push', () => {
    expect(decideChatFinishedBanner(passing({ archived: true }))).toBeNull();
    expect(decideChatFinishedBanner(passing({ muted: true }))).toBeNull();
  });

  it('a board agent working the topic → silent (task:review-ready speaks)', () => {
    expect(decideChatFinishedBanner(passing({ agentWorking: true }))).toBeNull();
  });

  it('looking at this chat in a focused window → silent, unless notifyEvenWhenFocused', () => {
    expect(decideChatFinishedBanner(passing({ isFocusedAndVisible: true }))).toBeNull();
    expect(decideChatFinishedBanner(passing({ isFocusedAndVisible: true, notifyEvenWhenFocused: true }))).not.toBeNull();
  });

  it('within the cooldown → silent; after it → banners again', () => {
    const now = 1_000_000;
    expect(decideChatFinishedBanner(passing({ lastFiredAt: now - 1, now }))).toBeNull();
    expect(decideChatFinishedBanner(passing({ lastFiredAt: now - CHAT_FINISHED_REPEAT_WINDOW_MS, now }))).not.toBeNull();
  });
});

describe('isChatPaneSelected', () => {
  it('a top-level chat pane is its bare topic id or `chat:<id>`', () => {
    expect(isChatPaneSelected('t1', 't1')).toBe(true);
    expect(isChatPaneSelected('t1', 'chat:t1')).toBe(true);
    expect(isChatPaneSelected('t1', 't2')).toBe(false);
    expect(isChatPaneSelected('t1', null)).toBe(false);
  });

  it('a chat inside a project counts only when it is that project\'s active inner pane', () => {
    const focused = `project:${encodeURIComponent('/p/app')}`;
    expect(isChatPaneSelected('t1', focused, { '/p/app': 'chat:t1' })).toBe(true);
    expect(isChatPaneSelected('t1', focused, { '/p/app': 'terminal:x' })).toBe(false);
    expect(isChatPaneSelected('t1', focused, { '/p/other': 'chat:t1' })).toBe(false);
  });

  it('never a substring match', () => {
    expect(isChatPaneSelected('t1', 'chat:t10')).toBe(false);
    expect(isChatPaneSelected('t1', 'browser:t1')).toBe(false);
  });
});

describe('chatFinishedEdge: what a stream frame does to the chat mark', () => {
  it('a clean end raises it', () => {
    expect(chatFinishedEdge({ type: 'stream:end', topicId: 't1', completed: true })).toEqual({ op: 'mark', topicId: 't1' });
  });

  it('an end that is not a finish leaves it alone: agent turn, stop, error', () => {
    expect(chatFinishedEdge({ type: 'stream:end', topicId: 't1', completed: true, dispatched: true })).toBeNull();
    expect(chatFinishedEdge({ type: 'stream:end', topicId: 't1', reason: 'user_abort' })).toBeNull();
    expect(chatFinishedEdge({ type: 'stream:end', topicId: 't1' })).toBeNull();
  });

  it('a new turn drops it', () => {
    expect(chatFinishedEdge({ type: 'stream:start', topicId: 't1' })).toEqual({ op: 'clear', topicId: 't1' });
    expect(chatFinishedEdge({ type: 'stream:start' })).toBeNull();
  });

  it('any other frame leaves it alone', () => {
    expect(chatFinishedEdge({ type: 'stream:delta', topicId: 't1', completed: true })).toBeNull();
  });
});

describe('turnEndClaimKey: one banner per turn across windows', () => {
  function memoryStorage(): ClaimStorage {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); } };
  }

  it('is the key `message:new` claims for the reply of the same turn', () => {
    // The server stamps `message:new` and `stream:end` of a turn with the id of
    // the same assistant row (server/routes/chat.ts).
    expect(turnEndClaimKey({ topicId: 't1', messageId: 'm-42' }))
      .toBe(bannerClaimKey({ topicId: 't1', role: 'assistant', messageId: 'm-42', content: 'done' }));
  });

  it('window B (hidden) claims on message:new, window A (visible) on stream:end: one wins', () => {
    const shared = memoryStorage();
    const now = 1_000_000;
    const hiddenB = claimBannerIn(shared, bannerClaimKey({ topicId: 't1', role: 'assistant', messageId: 'm-42' }), 'win-B', now);
    const visibleA = claimBannerIn(shared, turnEndClaimKey({ topicId: 't1', messageId: 'm-42' }), 'win-A', now + 5);
    expect([hiddenB, visibleA]).toEqual([true, false]);
  });

  it('two turns of the same chat are two claims', () => {
    const shared = memoryStorage();
    expect(claimBannerIn(shared, turnEndClaimKey({ topicId: 't1', messageId: 'm-1' }), 'win-A', 1)).toBe(true);
    expect(claimBannerIn(shared, turnEndClaimKey({ topicId: 't1', messageId: 'm-2' }), 'win-A', 2)).toBe(true);
  });

  it('without a messageId the key is still per turn end, shared by every window', () => {
    expect(turnEndClaimKey({ topicId: 't1', latencyMs: 4200 })).toBe('turn-end:t1:4200');
  });
});
