/**
 * THE GROUP CARD MUST GO QUIET WHEN YOU READ THE CHAT.
 *
 * What was on the board: a chat inside a group finishes its turn, the card
 * takes the blue dot. You open that chat and read it, the row and the tab go
 * neutral, and the dot on the card STAYS lit until the next message. Open the
 * card and you see a lit header over rows that are all calm.
 *
 * Since notifications-redesign the card is `rollupAttention` of its panes'
 * subjects, read from the server's attention state: a chat seen in any window
 * is not lit, so the card goes quiet with its row and its tab, and a new
 * epoch lights it again.
 *
 * Why here and not in a browser: the rule is a pure function of the attention
 * rows. The e2e (`tests/e2e/space-card-seen.spec.ts`) proves the pixel, this
 * proves the rule, and it is the one that will still be here when the markup
 * moves.
 *
 * Run: `bun test client/src/components/Sidebar/spaceAttentionTier.test.ts`
 *
 * @covers SEEN-01
 * @covers SEEN-02
 * @covers SEEN-ANY-FOCUS-01
 */
import { describe, it, expect } from 'bun:test';
import { spaceAttentionTier } from './useSpaceCards';
import { DEFAULT_SPACE_ID, type Pane, type SpaceMeta } from '../../state/pane/types';
import type { Topic, TerminalSessionInfo } from '../../types';
import type { AttentionSnapshot } from '../../../../shared/attention';

const SPACE = 'space:alpha';

const spaces: Record<string, SpaceMeta> = {
  [SPACE]: { id: SPACE, name: 'Alpha', order: 0, updatedAt: 0 },
};

function chatPane(id: string, topicId: string, spaceId: string): Pane {
  return { id, type: 'chat', topicId, spaceId } as Pane;
}

type Lit = 'needs-you' | 'done' | 'error' | 'seen' | 'background';

/** Attention rows: `t1` a chat, `s:s1` a terminal. 'seen' is a finished
 *  subject whose epoch the person saw, in any window: not lit. */
function rows(entries: Record<string, Lit> = {}): Map<string, AttentionSnapshot> {
  return new Map(Object.entries(entries).map(([k, v]) => {
    const subject = k.startsWith('s:') ? `terminal:${k.slice(2)}` : `topic:${k}`;
    return [subject, {
      subject, state: v === 'needs-you' ? 'needs-you' : v === 'background' ? 'background' : 'finished',
      reason: v === 'needs-you' ? 'question' : null, outcome: v === 'error' ? 'error' : v === 'done' || v === 'seen' ? 'done' : null,
      detail: null, since: '', epoch: 1, seenEpoch: v === 'seen' ? 1 : 0, lit: v === 'needs-you' || v === 'done' || v === 'error',
      unread: 0, turnUnseen: false, lastTurnAt: null, background: [],
    } satisfies AttentionSnapshot];
  }));
}

const noTopics: Record<string, Topic> = {};
const noTerminals: TerminalSessionInfo[] = [];

function tierOf(panes: Pane[], sig: Map<string, AttentionSnapshot>, spaceId = SPACE) {
  const byId: Record<string, Pane> = {};
  for (const p of panes) byId[p.id] = p;
  return spaceAttentionTier(spaceId, byId, spaces, sig, noTopics, noTerminals);
}

describe('spaceAttentionTier: the chat branch', () => {
  it('lights the card when a chat in the group finished and nobody read it', () => {
    expect(tierOf([chatPane('p1', 't1', SPACE)], rows({ t1: 'done' }))).toBe('done');
  });

  it('turns the card off once that chat has been seen, in any window (the server\'s seen)', () => {
    expect(tierOf([chatPane('p1', 't1', SPACE)], rows({ t1: 'seen' }))).toBeNull();
  });

  it('keeps the card lit for a SECOND chat that is still unread', () => {
    expect(tierOf([chatPane('p1', 't1', SPACE), chatPane('p2', 't2', SPACE)], rows({ t1: 'seen', t2: 'done' }))).toBe('done');
  });

  it('lights it again on the next turn: a new epoch is lit', () => {
    expect(tierOf([chatPane('p1', 't1', SPACE)], rows({ t1: 'done' }))).toBe('done');
  });

  it('still asks on a chat with a question, seen or not: a pending question is not silenced', () => {
    expect(tierOf([chatPane('p1', 't1', SPACE)], rows({ t1: 'needs-you' }))).toBe('needs-you');
  });

  it('the loudest child wins: needs-you over error over done', () => {
    const panes = [chatPane('p1', 't1', SPACE), chatPane('p2', 't2', SPACE), chatPane('p3', 't3', SPACE)];
    expect(tierOf(panes, rows({ t1: 'done', t2: 'error' }))).toBe('error');
    expect(tierOf(panes, rows({ t1: 'done', t2: 'error', t3: 'needs-you' }))).toBe('needs-you');
  });

  it('a chat in the background lights nothing', () => {
    expect(tierOf([chatPane('p1', 't1', SPACE)], rows({ t1: 'background' }))).toBeNull();
  });

  it('says nothing when no chat of the group is lit', () => {
    expect(tierOf([chatPane('p1', 't1', SPACE)], rows({ other: 'done' }))).toBeNull();
  });

  it('ignores a finished chat that lives in ANOTHER group', () => {
    expect(tierOf([chatPane('p1', 't1', 'space:beta')], rows({ t1: 'done' }))).toBeNull();
  });
});

describe('spaceAttentionTier: the terminal branch', () => {
  it('a finished terminal lights the card, with or without hooks, until it is seen; its second turn lights it again', () => {
    const pane = { id: 'term:s1', type: 'terminal', terminalSessionId: 's1', spaceId: SPACE } as Pane;
    expect(tierOf([pane], rows({ 's:s1': 'done' }))).toBe('done');
    expect(tierOf([pane], rows({ 's:s1': 'seen' }))).toBeNull();
    expect(tierOf([pane], rows({ 's:s1': 'done' }))).toBe('done');
  });

  it('a permission keeps the card lit even when the terminal was looked at', () => {
    const pane = { id: 'term:s2', type: 'terminal', terminalSessionId: 's2', spaceId: SPACE } as Pane;
    expect(tierOf([pane], rows({ 's:s2': 'needs-you' }))).toBe('needs-you');
  });
});

describe('spaceAttentionTier: the main group is a card like the others', () => {
  it('goes quiet on a read chat that sits outside every group', () => {
    const pane = { id: 'p1', type: 'chat', topicId: 't1' } as Pane;
    expect(tierOf([pane], rows({ t1: 'done' }), DEFAULT_SPACE_ID)).toBe('done');
    expect(tierOf([pane], rows({ t1: 'seen' }), DEFAULT_SPACE_ID)).toBeNull();
  });
});
