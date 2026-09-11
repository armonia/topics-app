/**
 * Who comes along with a zoomed conversation, and how wide the gesture went.
 *
 * The cases are split the way the functions are, because the last two are NOT
 * one function with two names: `resolveZoomCells` translates a scope into cells
 * and runs on every render, so no degradation may live in it; `resolveEntryScope`
 * runs once, at the gesture, and is the only place where a `derived` request can
 * come back as `cell`. The pair of tests that pins that difference is the one
 * that would go red if somebody merged them.
 *
 * @covers LAYOUT-34, LAYOUT-36, LAYOUT-40
 */
import { describe, test, expect } from 'bun:test';
import {
  computeZoomPaneIds,
  resolveEntryScope,
  resolveZoomAnchor,
  resolveZoomCells,
  type ZoomCellDeps,
  type ZoomPane,
} from './zoomScope';
import type { ZoomGridItem, ZoomRow } from './paneZoom';

const SESSION_A = 'topic:aaaa1111';

const PANES: ZoomPane[] = [
  { id: 'topic-a', type: 'chat' },
  { id: 'browser:topic-a', type: 'browser' },
  { id: 'terminal:sub1', type: 'terminal' },
  { id: 'topic-z', type: 'chat' },
];

/** Four live cells: the chat, its browser, its sub-agent terminal, another chat. */
const CELLS: Array<[string, string[]]> = [
  ['cell-chat', ['topic-a']],
  ['cell-browser', ['browser:topic-a']],
  ['cell-term', ['terminal:sub1']],
  ['cell-other', ['topic-z']],
];

function itemMap(entries: Array<[string, string[]]>): ReadonlyMap<string, ZoomGridItem> {
  return new Map(entries.map(([key, panelIds]) => [key, { key, panelIds }]));
}

function rowsOf(entries: Array<[string, string[]]>): ZoomRow[] {
  return [{ itemKeys: entries.map(([key]) => key) }];
}

function deps(over: Partial<ZoomCellDeps> = {}): ZoomCellDeps {
  return {
    openPanes: PANES,
    topics: { 'topic-a': { sessionKey: SESSION_A }, 'topic-z': {} },
    terminals: [
      { id: 'sub1', parentSessionKey: SESSION_A },
      { id: 'loner', parentSessionKey: null },
    ],
    spawnedBrowserByTopic: {},
    rows: rowsOf(CELLS),
    itemMap: itemMap(CELLS),
    ...over,
  };
}

/** A surface holding exactly `entries`, with panes to match. */
function surface(entries: Array<[string, string[]]>, over: Partial<ZoomCellDeps> = {}): ZoomCellDeps {
  return deps({ rows: rowsOf(entries), itemMap: itemMap(entries), ...over });
}

describe('resolveZoomAnchor', () => {
  test('a standalone chat tab anchors on its CONVERSATION', () => {
    expect(resolveZoomAnchor('topic-a', deps())).toEqual({ paneId: 'topic-a', topicId: 'topic-a' });
  });

  test('the topic the pane DECLARES wins over the one its id suggests', () => {
    // The two agree today (a project window mounts chats as `chat:<topicId>`),
    // and the order still has to be pinned: pane ids are surface-specific, the
    // declared topic is not.
    const declared = deps({ openPanes: [{ id: 'chat:alias-9', type: 'chat', topicId: 'topic-a' }] });
    expect(resolveZoomAnchor('chat:alias-9', declared))
      .toEqual({ paneId: 'chat:alias-9', topicId: 'topic-a' });
  });

  test('a chat the surface does not list still anchors on the topic its id encodes', () => {
    // `chat:<topicId>` is how a project window keys a chat; the standalone grid
    // keys it by the bare topic id. Both have to resolve to the conversation.
    expect(resolveZoomAnchor('chat:topic-a', deps({ openPanes: [] })))
      .toEqual({ paneId: 'chat:topic-a', topicId: 'topic-a' });
  });

  test('a tab that is NOT a chat anchors on itself: classic maximize', () => {
    expect(resolveZoomAnchor('browser:topic-a', deps()))
      .toEqual({ paneId: 'browser:topic-a', topicId: null });
  });

  test('a draft is not a conversation, even when the surface does not list it', () => {
    expect(resolveZoomAnchor('draft:1234', deps({ openPanes: [] })))
      .toEqual({ paneId: 'draft:1234', topicId: null });
  });
});

describe('computeZoomPaneIds', () => {
  const anchor = { paneId: 'topic-a', topicId: 'topic-a' } as const;

  test('the browser whose id IS the topic context comes along', () => {
    expect(computeZoomPaneIds(anchor, deps())).toEqual(['topic-a', 'browser:topic-a', 'terminal:sub1']);
  });

  test('the context recorded on the topic comes along too', () => {
    const withRecordedContext = deps({
      openPanes: [{ id: 'topic-a', type: 'chat' }, { id: 'browser:ctx-9', type: 'browser' }],
      topics: { 'topic-a': { sessionKey: SESSION_A, browserState: { contextId: 'ctx-9' } } },
    });
    expect(computeZoomPaneIds(anchor, withRecordedContext)).toEqual(['topic-a', 'browser:ctx-9']);
  });

  test('sub-agent terminals come along by parent session, and other terminals do not', () => {
    const withLoner = deps({
      openPanes: [...PANES, { id: 'terminal:loner', type: 'terminal' }],
    });
    expect(computeZoomPaneIds(anchor, withLoner)).not.toContain('terminal:loner');
    expect(computeZoomPaneIds(anchor, withLoner)).toContain('terminal:sub1');
  });

  test('the spawner registry enters in UNION, and an empty one leaves the chat alone', () => {
    // The registry lives in sessionStorage: after an app restart it is empty and
    // the set gets SMALLER, never wrong. This pair is the whole claim.
    const onlyRegistryKnows = deps({
      openPanes: [{ id: 'topic-a', type: 'chat' }, { id: 'browser:new-7', type: 'browser' }],
    });
    expect(computeZoomPaneIds(anchor, onlyRegistryKnows)).toEqual(['topic-a']);

    const registryFilled = deps({
      openPanes: [{ id: 'topic-a', type: 'chat' }, { id: 'browser:new-7', type: 'browser' }],
      spawnedBrowserByTopic: { 'topic-a': 'new-7' },
    });
    expect(computeZoomPaneIds(anchor, registryFilled)).toEqual(['topic-a', 'browser:new-7']);
  });

  test('a candidate that is not open here is not in the set', () => {
    const chatAlone = deps({ openPanes: [{ id: 'topic-a', type: 'chat' }] });
    expect(computeZoomPaneIds(anchor, chatAlone)).toEqual(['topic-a']);
  });
});

describe('resolveZoomCells', () => {
  test("scope 'derived' reveals the conversation and the tabs it opened", () => {
    const cells = resolveZoomCells({ anchorPaneId: 'topic-a', scope: 'derived' }, deps());
    expect([...cells]).toEqual(['cell-chat', 'cell-browser', 'cell-term']);
  });

  test("scope 'cell' reveals the anchor's cell alone, derived set IGNORED", () => {
    const cells = resolveZoomCells({ anchorPaneId: 'topic-a', scope: 'cell' }, deps());
    expect([...cells]).toEqual(['cell-chat']);
  });

  test("scope 'derived' covering every live cell still reveals them ALL", () => {
    // No degradation lives here: this function runs on every render, and
    // degrading inside it would move the scope under the user's hands each time
    // a pane opens or closes. The narrowing happens once, at entry.
    const packed = surface(CELLS.slice(0, 3));
    const cells = resolveZoomCells({ anchorPaneId: 'topic-a', scope: 'derived' }, packed);
    expect([...cells]).toEqual(['cell-chat', 'cell-browser', 'cell-term']);
  });
});

describe('resolveEntryScope', () => {
  test("a live cell outside the set keeps the simple gesture on 'derived'", () => {
    expect(resolveEntryScope('topic-a', 'derived', deps())).toBe('derived');
  });

  test('the set covering every live cell DEGRADES the simple gesture to the cell', () => {
    // chat + its browser + its sub-agent terminal fill the grid: the old
    // predicate made the command vanish exactly here, on the layout the feature
    // exists for. It degrades instead, and never no-ops.
    expect(resolveEntryScope('topic-a', 'derived', surface(CELLS.slice(0, 3)))).toBe('cell');
  });

  test("the modifier asks for 'cell' and gets it, whatever the set would cover", () => {
    expect(resolveEntryScope('topic-a', 'cell', deps())).toBe('cell');
    expect(resolveEntryScope('topic-a', 'cell', surface(CELLS.slice(0, 3)))).toBe('cell');
  });

  test('a single live cell offers no gesture at all, with or without the modifier', () => {
    // Same layout on which the availability predicate is false: both read
    // `liveCellKeys`, so they agree by construction.
    const alone = surface([CELLS[0]]);
    expect(resolveEntryScope('topic-a', 'derived', alone)).toBeNull();
    expect(resolveEntryScope('topic-a', 'cell', alone)).toBeNull();
  });

  test('a cell the item map does not know does not count as a second cell', () => {
    const ghosted = deps({
      rows: [{ itemKeys: ['cell-chat', 'cell-ghost'] }],
      itemMap: itemMap([CELLS[0]]),
    });
    expect(resolveEntryScope('topic-a', 'derived', ghosted)).toBeNull();
  });
});
