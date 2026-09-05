/**
 * @covers LINK-TAB-02
 *
 * Where a link-opened tab lands. The interesting case is the second click: it
 * must join the strip the first one created, not tile another cell.
 */
import { test, expect } from 'bun:test';
import { resolveOpenTabTarget, insertPaneAfter } from './openTabTarget';

const chatGroup = { id: 'g1', paneIds: ['chat:t1', 'terminal:s1'], activePaneId: 'chat:t1' };
const browserGroup = { id: 'g2', paneIds: ['browser:a'], activePaneId: 'browser:a' };
const panes = [
  { id: 'chat:t1', type: 'chat' },
  { id: 'terminal:s1', type: 'terminal' },
  { id: 'browser:a', type: 'browser' },
];

test('no browser anywhere: the focused group, split out beside the chat', () => {
  const t = resolveOpenTabTarget({
    panes: panes.slice(0, 2),
    groups: [chatGroup],
    focusedGroupId: 'g1',
  });
  expect(t).toEqual({ groupId: 'g1', split: true, afterPaneId: 'chat:t1' });
});

test('a browser already open: the tab joins ITS strip, no new cell', () => {
  const t = resolveOpenTabTarget({ panes, groups: [chatGroup, browserGroup], focusedGroupId: 'g1' });
  expect(t).toEqual({ groupId: 'g2', split: false, afterPaneId: 'browser:a' });
});

test('the click came from a terminal: beside that terminal, not where focus is', () => {
  const other = { id: 'g3', paneIds: ['chat:t9'], activePaneId: 'chat:t9' };
  const t = resolveOpenTabTarget({
    nearPaneId: 'terminal:s1',
    panes: [...panes.slice(0, 2), { id: 'chat:t9', type: 'chat' }],
    groups: [chatGroup, other],
    focusedGroupId: 'g3',
  });
  expect(t).toEqual({ groupId: 'g1', split: true, afterPaneId: 'chat:t1' });
});

test('the click came from a browser pane: a sibling tab in the same strip', () => {
  const t = resolveOpenTabTarget({
    nearPaneId: 'browser:a',
    panes,
    groups: [chatGroup, browserGroup],
    focusedGroupId: 'g1',
  });
  expect(t).toEqual({ groupId: 'g2', split: false, afterPaneId: 'browser:a' });
});

test('two strips: the one the user is looking at grows', () => {
  const second = { id: 'g4', paneIds: ['browser:b'], activePaneId: 'browser:b' };
  const t = resolveOpenTabTarget({
    panes: [...panes, { id: 'browser:b', type: 'browser' }],
    groups: [chatGroup, browserGroup, second],
    focusedGroupId: 'g4',
  });
  expect(t.groupId).toBe('g4');
});

test('a window with no group at all still answers (the caller creates one)', () => {
  const t = resolveOpenTabTarget({ panes: [], groups: [], focusedGroupId: null });
  expect(t).toEqual({ groupId: undefined, split: false, afterPaneId: undefined });
});

test('the new tab sits right after the active one', () => {
  expect(insertPaneAfter(['a', 'b', 'c', 'new'], 'new', 'a')).toEqual(['a', 'new', 'b', 'c']);
  expect(insertPaneAfter(['a', 'b'], 'new', 'b')).toEqual(['a', 'b', 'new']);
});

test('a vanished anchor appends instead of throwing', () => {
  expect(insertPaneAfter(['a', 'new'], 'new', 'gone')).toEqual(['a', 'new']);
  expect(insertPaneAfter(['a', 'new'], 'new')).toEqual(['a', 'new']);
});
