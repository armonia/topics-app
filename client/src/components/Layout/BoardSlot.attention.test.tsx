/**
 * THE BOARD TAB AND THE BOARD ROW DRAW THE LIT CARDS (ATTN-16, CHROME-COUNT-01).
 *
 * `boardAttention` counts the lit `task:` subjects; these tests mount the two
 * surfaces that must draw it, the board tab and the sidebar's Board row. Before, the tab counted the cards whose column
 * is review from the board list (with a local cache), so a parked card lit the
 * inbox and the Dock and not the tab.
 *
 * @covers ATTN-16
 */
import { test, expect, beforeEach } from 'bun:test';
import { mount } from '../../test/reactHarness';
import { attentionActions, useAttentionStore } from '../../state/attention';
import { chromeAttentionTotal } from '../../state/attentionTotal';
import { inboxModel } from '../../lib/inboxModel';
import { BoardRowSummary } from '../Sidebar/BoardStatusCounts';
import { setBoardTasks, __resetBoardTasks } from '../../lib/boardTasksStore';
import { TabSlot } from './TabSlot';
import { PendingActionProvider } from '../../contexts/PendingActionContext';
import type { BoardTask } from '../../lib/board';

const row = (id: string, reason: string) => ({
  subject: `task:${id}`, state: 'needs-you', reason, outcome: null, detail: null, since: '2026-10-03T10:00:00.000Z',
  epoch: 1, seenEpoch: 0, lit: true, unread: 0, turnUnseen: false, lastTurnAt: null, background: [],
});

// The harness renders on the server, which reads zustand's initial state: point it at the live one.
(useAttentionStore as unknown as { getInitialState: unknown }).getInitialState = useAttentionStore.getState;

const tasks = [
  { id: 'r1', projectId: 'p1', status: 'review', text: 'Review me' },
  // A parked card is a backlog card whose dispatch failed.
  { id: 'k1', projectId: 'p1', status: 'backlog', text: 'Parked', dispatchState: 'failed' },
] as unknown as BoardTask[];

beforeEach(() => { attentionActions.reset(); __resetBoardTasks(); });

test('one card in review and one parked: the general board tab says 2, as the inbox and the Dock', () => {
  attentionActions.applyInit([row('r1', 'review'), row('k1', 'parked')]);
  setBoardTasks(tasks);
  const h = mount(<PendingActionProvider><TabSlot paneId="__board__" type={'board' as never} label="Board" selected={false} freeze={null} attention={0} onFill={false} closable={false} onClose={() => {}} /></PendingActionProvider>);
  const badge = h.last().hosts.find((n) => n.props['data-testid'] === 'tab-board-count-review');
  h.unmount();
  const rows = useAttentionStore.getState().rows;
  const inbox = inboxModel(rows, {}, [], [{ id: 'r1', text: 'Review me' }, { id: 'k1', text: 'Parked' }]).waiting.length;
  expect(String(badge?.props['data-notification-count'])).toBe('2');
  expect(inbox).toBe(2);
  expect(chromeAttentionTotal(rows, {}, [])).toBe(2);
});

/** The number the Board row draws on its first count (`board-count-review`), or null. */
function boardRowNumber(byStatus: unknown): string | null {
  const h = mount(<BoardRowSummary byStatus={byStatus as never} />);
  const host = h.last().hosts.find((n) => n.props['data-testid'] === 'board-count-review');
  h.unmount();
  if (!host) return null;
  const children = host.props.children;
  return String(Array.isArray(children) ? children[children.length - 1] : children);
}

test('the Board row in the sidebar says 2 too, and 1 once the parked card is put back in the queue', () => {
  attentionActions.applyInit([row('r1', 'review'), row('k1', 'parked')]);
  const byStatus = { review: [tasks[0]], backlog: [tasks[1]], in_progress: [], todo: [], done: [] };
  expect(boardRowNumber(byStatus)).toBe('2');
  attentionActions.applyUpdated({ ...row('k1', 'parked'), state: 'idle', reason: null, lit: false });
  expect(boardRowNumber(byStatus)).toBe('1');
});
