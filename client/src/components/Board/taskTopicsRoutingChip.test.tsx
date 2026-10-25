/** @covers AICTRL-01, MSEL-06 */
import { afterAll, describe, expect, test, mock } from 'bun:test';
import type { ComponentProps } from 'react';
import { readFileSync } from 'node:fs';
import { DndContext } from '@dnd-kit/core';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardSettings, BoardTask } from '../../lib/board';
import type { ProvidersSnapshot } from '../../types';

const {
  getProvidersSnapshotState,
  subscribeProvidersSnapshot,
  refreshProvidersSnapshot,
  reloadProvidersSnapshot,
} = await import('../../lib/providersSnapshotStore');
const realProvidersSnapshotStore = {
  getProvidersSnapshotState,
  subscribeProvidersSnapshot,
  refreshProvidersSnapshot,
  reloadProvidersSnapshot,
};

const {
  POPOVER_MARGIN,
  Z_POPOVER,
  Z_CONTEXT_MENU,
  Z_POPOVER_SCRIM,
  Z_MODAL,
  POPOVER_SURFACE,
  POPOVER_PANEL,
  POPOVER_LOOK,
  POPOVER_ITEM,
  DANGER_TEXT,
  WARNING_TEXT,
  SUCCESS_TEXT,
  ACTIVE_TEXT,
  POPOVER_ITEM_DANGER,
  POPOVER_DIVIDER,
  POPOVER_SHEET,
} = await import('../../lib/popoverStyles');
const realPopoverStyles = {
  POPOVER_MARGIN,
  Z_POPOVER,
  Z_CONTEXT_MENU,
  Z_POPOVER_SCRIM,
  Z_MODAL,
  POPOVER_SURFACE,
  POPOVER_PANEL,
  POPOVER_LOOK,
  POPOVER_ITEM,
  DANGER_TEXT,
  WARNING_TEXT,
  SUCCESS_TEXT,
  ACTIVE_TEXT,
  POPOVER_ITEM_DANGER,
  POPOVER_DIVIDER,
  POPOVER_SHEET,
};

const realExitGhost = await import('../../lib/exitGhost');
const realPopoverPosition = await import('../../lib/popoverPosition');
const realFixedFrame = await import('../../lib/fixedFrame');
const realContextMenuOrigin = await import('../../lib/contextMenuOrigin');

// Bun starts from the repo root and does not load the client tsconfig `@/*` paths:
// register the real modules first, so the captured component never sees the fakes.
mock.module('@/lib/popoverStyles', () => realPopoverStyles);
mock.module('@/lib/exitGhost', () => realExitGhost);
mock.module('@/lib/popoverPosition', () => realPopoverPosition);
mock.module('@/lib/fixedFrame', () => realFixedFrame);
mock.module('@/lib/contextMenuOrigin', () => realContextMenuOrigin);

const { ContextMenuPortal } = await import('../Shared/ContextMenuPortal');
const realContextMenuPortal = { ContextMenuPortal };

const snapshot: ProvidersSnapshot = {
  providers: [
    { name: 'topics', label: 'Topics', status: 'ready', isDefault: false, models: ['claude-sonnet-5'], requirements: [], fetchedAt: '2026-10-25T00:00:00Z' },
    { name: 'claude-code', label: 'Claude Code', status: 'ready', isDefault: true, models: ['claude-sonnet-5'], requirements: [], fetchedAt: '2026-10-25T00:00:00Z' },
  ],
  defaultProvider: 'claude-code',
  generatedAt: '2026-10-25T00:00:00Z',
};

mock.module('../../lib/providersSnapshotStore', () => ({
  ...realProvidersSnapshotStore,
  getProvidersSnapshotState: () => ({ snapshot, error: null }),
  subscribeProvidersSnapshot: () => () => {},
}));
mock.module('@/lib/popoverStyles', () => ({
  ...realPopoverStyles,
  POPOVER_DIVIDER: 'my-1 h-px',
  POPOVER_ITEM: 'w-full',
  POPOVER_ITEM_DANGER: 'w-full text-red-600',
}));
mock.module('../../lib/popoverStyles', () => ({
  ...realPopoverStyles,
  POPOVER_DIVIDER: 'my-1 h-px',
  POPOVER_ITEM: 'w-full',
  POPOVER_ITEM_DANGER: 'w-full text-red-600',
}));
mock.module('../Shared/ContextMenuPortal', () => ({
  ...realContextMenuPortal,
  ContextMenuPortal: () => null,
}));

afterAll(() => {
  mock.module('../../lib/providersSnapshotStore', () => realProvidersSnapshotStore);
  mock.module('@/lib/popoverStyles', () => realPopoverStyles);
  mock.module('@/lib/exitGhost', () => realExitGhost);
  mock.module('@/lib/popoverPosition', () => realPopoverPosition);
  mock.module('@/lib/fixedFrame', () => realFixedFrame);
  mock.module('@/lib/contextMenuOrigin', () => realContextMenuOrigin);
  mock.module('../../lib/popoverStyles', () => realPopoverStyles);
  mock.module('../Shared/ContextMenuPortal', () => realContextMenuPortal);
});

const { Column } = await import('./Card');

const task = {
  id: 'route-chip-card',
  projectId: 'board-1',
  text: 'Check the Topics routing chip',
  status: 'review',
  priority: 0,
  kanbanOrder: 0,
  assignedTo: null,
  createdAt: '2026-10-25T00:00:00Z',
  updatedAt: '2026-10-25T00:00:00Z',
  assignedTopicId: null,
  dispatchState: null,
  dispatchAttempts: 0,
  dispatchError: null,
  dispatchDeferredUntil: null,
  waitStreak: 0,
  waitReason: null,
  waitSince: null,
  parentTaskId: null,
  urlProbeStatus: null,
  previewImage: null,
  previewRetiredAt: null,
  previewRetiredReason: null,
  planFirst: false,
  agentMs: 0,
  agentTokens: 0,
  agentCacheReadTokens: 0,
  agentCostCents: 0,
  subtaskCount: 0,
  subtaskDoneCount: 0,
  userCommentCount: 0,
  labels: [],
  model: 'claude-code:claude-sonnet-5',
  topicsRouting: null,
  machineId: null,
  blockedByTaskId: null,
  blockedBy: null,
  subtaskWork: null,
  waitingOnCount: 0,
} as unknown as BoardTask;

const settings = { dispatchTopicsRouting: false } as BoardSettings;
const props = {
  status: 'review',
  tasks: [task],
  onOpen: () => {},
  onCreate: () => {},
  canCreate: false,
  showProject: false,
  onRefetch: () => {},
  cardError: null,
  onCardError: () => {},
  paneBoardId: 'board-1',
  paneSettings: settings,
  tasksById: new Map([[task.id, task]]),
  projectPathById: new Map(),
  liveById: new Map(),
  awaitingHuman: new Set(),
  justMoved: new Map(),
  justCreated: new Set(),
} satisfies ComponentProps<typeof Column>;

describe('the card routing chip in its board column', () => {
  test('renders the direct Claude Code route from the board OFF default', () => {
    const paneSource = readFileSync(new URL('./KanbanBoardPane.tsx', import.meta.url), 'utf8');
    const columnsStart = paneSource.indexOf('{TASK_STATUSES.map((status) => (');
    const columnsEnd = paneSource.indexOf('))}', columnsStart);
    const columns = paneSource.slice(columnsStart, columnsEnd);
    expect(columns).toMatch(/paneBoardId=\{projectId\}[\s\S]{0,80}paneSettings=\{settings\}/);

    const html = renderToStaticMarkup(
      <DndContext>
        <Column {...props} />
      </DndContext>,
    );
    expect(html).toContain('Sonnet 5 · via Claude Code');
    expect(html).not.toContain('Sonnet 5 · via Topics');
  });
});
