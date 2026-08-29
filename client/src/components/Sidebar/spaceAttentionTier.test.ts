/**
 * THE GROUP CARD MUST GO QUIET WHEN YOU READ THE CHAT.
 *
 * What was on the board: a chat inside a group finishes its turn, the card
 * takes the blue dot. You open that chat and read it, the row and the tab go
 * neutral, and the dot on the card STAYS lit until the next message. Open the
 * card and you see a lit header over rows that are all calm.
 *
 * The cause was one missing line: `spaceAttentionTier` read the raw signal sets
 * with no `seenSubjects` gate, while the very same rollup for a PROJECT pane,
 * two branches below, has had that gate for a while. A Claude phase such as
 * `awaiting-user` does not clear by itself: it stays until the next turn, so
 * nothing but the seen mark can turn that dot off.
 *
 * Why here and not in a browser: the rule is a pure function of the signal
 * sets. The e2e (`tests/e2e/space-card-seen.spec.ts`) proves the pixel, this
 * proves the rule, and it is the one that will still be here when the markup
 * moves.
 *
 * Run: `bun test client/src/components/Sidebar/spaceAttentionTier.test.ts`
 */
import { describe, it, expect } from 'bun:test';
import { spaceAttentionTier } from './useSpaceCards';
import { DEFAULT_SPACE_ID, type Pane, type SpaceMeta } from '../../state/pane/types';
import type { Topic, TerminalSessionInfo } from '../../types';

const SPACE = 'space:alpha';

const spaces: Record<string, SpaceMeta> = {
  [SPACE]: { id: SPACE, name: 'Alpha', order: 0, updatedAt: 0 },
};

function chatPane(id: string, topicId: string, spaceId: string): Pane {
  return { id, type: 'chat', topicId, spaceId } as Pane;
}

interface Sets {
  awaitingInputTopics: Set<string>;
  awaitingFeedbackTopics: Set<string>;
  claudePhaseAwaitingInputTermIds: Set<string>;
  claudePhaseAwaitingTermIds: Set<string>;
  terminalFinishedIds: Set<string>;
  seenSubjects: ReadonlySet<string>;
}

function sets(over: Partial<Sets> = {}): Sets {
  return {
    awaitingInputTopics: new Set(),
    awaitingFeedbackTopics: new Set(),
    claudePhaseAwaitingInputTermIds: new Set(),
    claudePhaseAwaitingTermIds: new Set(),
    terminalFinishedIds: new Set(),
    seenSubjects: new Set(),
    ...over,
  };
}

const noTopics: Record<string, Topic> = {};
const noTerminals: TerminalSessionInfo[] = [];

function tierOf(panes: Pane[], sig: Sets, spaceId = SPACE) {
  const byId: Record<string, Pane> = {};
  for (const p of panes) byId[p.id] = p;
  return spaceAttentionTier(spaceId, byId, spaces, sig, noTopics, noTerminals);
}

describe('spaceAttentionTier: the chat branch', () => {
  it('lights the card when a chat in the group finished and nobody read it', () => {
    const tier = tierOf(
      [chatPane('p1', 't1', SPACE)],
      sets({ awaitingFeedbackTopics: new Set(['t1']) }),
    );
    expect(tier).toBe('done');
  });

  it('turns the card off once that chat has been seen', () => {
    const tier = tierOf(
      [chatPane('p1', 't1', SPACE)],
      sets({ awaitingFeedbackTopics: new Set(['t1']), seenSubjects: new Set(['t1']) }),
    );
    expect(tier).toBeNull();
  });

  it('keeps the card lit for a SECOND chat that is still unread', () => {
    const tier = tierOf(
      [chatPane('p1', 't1', SPACE), chatPane('p2', 't2', SPACE)],
      sets({ awaitingFeedbackTopics: new Set(['t1', 't2']), seenSubjects: new Set(['t1']) }),
    );
    expect(tier).toBe('done');
  });

  it('lights it again on the next turn, when the seen mark is dropped', () => {
    // `resetSeenOnNewAttention` drops the mark on the rising edge: same sets,
    // minus the seen subject, is exactly the state of the turn after.
    const tier = tierOf(
      [chatPane('p1', 't1', SPACE)],
      sets({ awaitingFeedbackTopics: new Set(['t1']) }),
    );
    expect(tier).toBe('done');
  });

  it('still asks for input on a seen chat: a pending question is not silenced', () => {
    // `awaitingInputTopics` carries `askWaitingTopics`, which never passes
    // through `applyNewAttention`: gating it on the seen mark would mute the
    // card for good on a question still waiting for its answer.
    const tier = tierOf(
      [chatPane('p1', 't1', SPACE)],
      sets({ awaitingInputTopics: new Set(['t1']), seenSubjects: new Set(['t1']) }),
    );
    expect(tier).toBe('input');
  });

  it('says nothing when no chat of the group has a signal', () => {
    const tier = tierOf(
      [chatPane('p1', 't1', SPACE)],
      sets({ awaitingFeedbackTopics: new Set(['other']) }),
    );
    expect(tier).toBeNull();
  });

  it('ignores a finished chat that lives in ANOTHER group', () => {
    const tier = tierOf(
      [chatPane('p1', 't1', 'space:beta')],
      sets({ awaitingFeedbackTopics: new Set(['t1']) }),
    );
    expect(tier).toBeNull();
  });
});

describe('spaceAttentionTier: the terminal branch is untouched', () => {
  it('keeps lighting a finished hook-less terminal even when marked seen', () => {
    // The twin note in the source: `terminalFinishedIds` covers sessions with
    // no known phase and the seen reset rides on `claudePhaseAwaitingTermIds`,
    // so a gate here would mute the second finished turn for good.
    const pane = { id: 'term:s1', type: 'terminal', terminalSessionId: 's1', spaceId: SPACE } as Pane;
    const tier = tierOf(
      [pane],
      sets({ terminalFinishedIds: new Set(['s1']), seenSubjects: new Set(['s1']) }),
    );
    expect(tier).toBe('done');
  });
});

describe('spaceAttentionTier: the main group is a card like the others', () => {
  it('goes quiet on a read chat that sits outside every group', () => {
    const pane = { id: 'p1', type: 'chat', topicId: 't1' } as Pane;
    const lit = tierOf([pane], sets({ awaitingFeedbackTopics: new Set(['t1']) }), DEFAULT_SPACE_ID);
    const read = tierOf(
      [pane],
      sets({ awaitingFeedbackTopics: new Set(['t1']), seenSubjects: new Set(['t1']) }),
      DEFAULT_SPACE_ID,
    );
    expect(lit).toBe('done');
    expect(read).toBeNull();
  });
});
