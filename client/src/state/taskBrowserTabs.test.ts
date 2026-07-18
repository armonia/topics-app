/**
 * Tests for the task-owned browser tab group's pure reducer ops. No I/O — the
 * ui-state persistence / React hook layers are exercised only in the app.
 */
import { describe, test, expect } from 'bun:test';
import {
  EMPTY_TASK_TABS,
  mintTaskContextId,
  isTaskContextId,
  addTab,
  upsertTab,
  closeTab,
  setActiveTab,
  reorderTabs,
  updateTab,
  sanitizeTaskTabs,
} from './taskBrowserTabs';

const TASK = '125aafd5-0e15-4aa0-ab25-f00000000000';

describe('mintTaskContextId / isTaskContextId', () => {
  test('mints task-<id8>-<seq>', () => {
    expect(mintTaskContextId(TASK, 0)).toBe('task-125aafd5-0');
    expect(mintTaskContextId(TASK, 3)).toBe('task-125aafd5-3');
  });
  test('isTaskContextId recognizes task- ctx and rejects others', () => {
    expect(isTaskContextId('task-125aafd5-0')).toBe(true);
    expect(isTaskContextId('term-abc')).toBe(false);
    expect(isTaskContextId('125aafd5-...')).toBe(false);
    expect(isTaskContextId('')).toBe(false);
  });
});

describe('addTab', () => {
  test('appends a minted tab and activates it, bumping nextSeq', () => {
    const s1 = addTab(EMPTY_TASK_TABS, TASK, 'https://a.test', 'A');
    expect(s1.tabs).toHaveLength(1);
    expect(s1.tabs[0]).toEqual({ contextId: 'task-125aafd5-0', url: 'https://a.test', title: 'A', seq: 0 });
    expect(s1.activeContextId).toBe('task-125aafd5-0');
    expect(s1.nextSeq).toBe(1);
    const s2 = addTab(s1, TASK, 'https://b.test');
    expect(s2.tabs.map((t) => t.contextId)).toEqual(['task-125aafd5-0', 'task-125aafd5-1']);
    expect(s2.activeContextId).toBe('task-125aafd5-1');
    expect(s2.nextSeq).toBe(2);
  });
});

describe('upsertTab', () => {
  test('adds an externally-minted ctx and advances nextSeq', () => {
    const s = upsertTab(EMPTY_TASK_TABS, 'task-125aafd5-agent', 'https://x.test', 'X');
    expect(s.tabs).toHaveLength(1);
    expect(s.activeContextId).toBe('task-125aafd5-agent');
    expect(s.nextSeq).toBe(1);
  });
  test('is idempotent: same ctx refreshes url/title + activates, no dup', () => {
    const s1 = upsertTab(EMPTY_TASK_TABS, 'task-1-a', 'https://x.test', 'X');
    const s2 = setActiveTab(addTab(s1, TASK, 'https://b.test'), 'task-1-a'); // move active away then back
    const s3 = upsertTab(s2, 'task-1-a', 'https://x2.test', 'X2');
    expect(s3.tabs.filter((t) => t.contextId === 'task-1-a')).toHaveLength(1);
    expect(s3.tabs.find((t) => t.contextId === 'task-1-a')).toMatchObject({ url: 'https://x2.test', title: 'X2' });
    expect(s3.activeContextId).toBe('task-1-a');
  });
});

describe('closeTab', () => {
  const base = addTab(addTab(addTab(EMPTY_TASK_TABS, TASK, 'a'), TASK, 'b'), TASK, 'c'); // seq 0,1,2 active=2
  test('closing the active tab focuses the neighbour that slides into its slot', () => {
    const s = closeTab(base, 'task-125aafd5-2'); // close last active → prev
    expect(s.tabs.map((t) => t.seq)).toEqual([0, 1]);
    expect(s.activeContextId).toBe('task-125aafd5-1');
  });
  test('closing a middle active tab focuses the same index (now next)', () => {
    const mid = setActiveTab(base, 'task-125aafd5-1');
    const s = closeTab(mid, 'task-125aafd5-1');
    expect(s.tabs.map((t) => t.seq)).toEqual([0, 2]);
    expect(s.activeContextId).toBe('task-125aafd5-2'); // idx 1 clamps to the tab now at 1
  });
  test('closing a non-active tab leaves the active one', () => {
    const s = closeTab(base, 'task-125aafd5-0');
    expect(s.activeContextId).toBe('task-125aafd5-2');
  });
  test('closing the last tab clears active', () => {
    const one = addTab(EMPTY_TASK_TABS, TASK, 'a');
    expect(closeTab(one, 'task-125aafd5-0').activeContextId).toBeNull();
  });
  test('unknown ctx is a no-op', () => {
    expect(closeTab(base, 'nope')).toBe(base);
  });
});

describe('setActiveTab / reorderTabs / updateTab', () => {
  const base = addTab(addTab(EMPTY_TASK_TABS, TASK, 'a'), TASK, 'b');
  test('setActiveTab ignores unknown ctx', () => {
    expect(setActiveTab(base, 'nope')).toBe(base);
  });
  test('reorderTabs moves a tab', () => {
    const s = reorderTabs(base, 0, 1);
    expect(s.tabs.map((t) => t.seq)).toEqual([1, 0]);
  });
  test('reorderTabs is a no-op for same/out-of-range indices', () => {
    expect(reorderTabs(base, 0, 0)).toBe(base);
    expect(reorderTabs(base, 5, 0)).toBe(base);
  });
  test('updateTab merges url/title, no-op when unchanged', () => {
    const s = updateTab(base, 'task-125aafd5-0', { url: 'https://a2.test', title: 'A2' });
    expect(s.tabs[0]).toMatchObject({ url: 'https://a2.test', title: 'A2' });
    expect(updateTab(s, 'task-125aafd5-0', { url: 'https://a2.test' })).toBe(s);
  });
});

describe('sanitizeTaskTabs', () => {
  test('rejects non-objects and missing tabs', () => {
    expect(sanitizeTaskTabs(null)).toBeNull();
    expect(sanitizeTaskTabs({})).toBeNull();
    expect(sanitizeTaskTabs({ tabs: 'x' })).toBeNull();
  });
  test('drops malformed tab entries and derives active + nextSeq', () => {
    const s = sanitizeTaskTabs({
      tabs: [
        { contextId: 'task-1-0', url: 'a', title: 'A', seq: 0 },
        { url: 'no-ctx' },
        { contextId: 'task-1-4', seq: 4 },
      ],
      activeContextId: 'gone',
    });
    expect(s?.tabs.map((t) => t.contextId)).toEqual(['task-1-0', 'task-1-4']);
    expect(s?.tabs[1]).toEqual({ contextId: 'task-1-4', url: '', title: '', seq: 4 });
    expect(s?.activeContextId).toBe('task-1-0'); // stale active → first tab
    expect(s?.nextSeq).toBe(5); // maxSeq + 1
  });
});
