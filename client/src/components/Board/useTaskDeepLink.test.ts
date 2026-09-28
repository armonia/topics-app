/**
 * THE BOARD'S END OF «OPEN THIS TASK ON THAT FILE».
 *
 * A row of the chat's changed-files strip asks for the task's drawer with one
 * diff file in front (`Chat/ChangedFilesStrip.test.tsx` pins the asking). The
 * board hears it one of two ways: live, when it is already mounted, or from
 * the URL plus `pendingTaskFocus` when it mounts after the click. Dropping
 * either leaves the drawer open on its default tab, with the file the row
 * named nowhere in sight. Driven through the real hook (`test/reactHarness`),
 * with only the window stubbed.
 *
 * @covers CHAT-CHANGES-01
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as React from 'react';
import { mount, type Harness } from '../../test/reactHarness';
import { useTaskDeepLink } from './useTaskDeepLink';
import { openTaskInApp } from '../../lib/openTaskLink';
import { diffFocusFor } from './constants';

const g = globalThis as unknown as Record<string, unknown>;
const savedWindow = g.window;
const listeners = new Map<string, Set<(e: Event) => void>>();
let harness: Harness | null = null;
const focus = diffFocusFor('src/a.ts');

beforeEach(() => {
  listeners.clear();
  const location = { origin: 'http://localhost', href: 'http://localhost/', pathname: '/', search: '' };
  g.window = {
    location,
    history: {
      pushState: (_state: unknown, _title: unknown, url: string) => {
        const u = new URL(url);
        Object.assign(location, { href: u.href, pathname: u.pathname, search: u.search });
      },
    },
    addEventListener: (type: string, cb: (e: Event) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(cb);
    },
    removeEventListener: (type: string, cb: (e: Event) => void) => { listeners.get(type)?.delete(cb); },
    dispatchEvent: (e: Event) => {
      for (const cb of listeners.get(e.type) ?? []) cb(e);
      return true;
    },
  };
});

afterEach(() => {
  harness?.unmount();
  harness = null;
  if (savedWindow === undefined) delete g.window; else g.window = savedWindow;
});

function drive(global: boolean) {
  let state: ReturnType<typeof useTaskDeepLink> | undefined;
  function Probe(): null {
    const current = useTaskDeepLink(global);
    React.useEffect(() => { state = current; });
    return null;
  }
  harness = mount(React.createElement(Probe));
  return () => ({ select: state!.pendingSelect, paneId: state!.pendingPaneId });
}

describe('useTaskDeepLink', () => {
  test('a board already open hears the gesture: the task to select and the file to put in front', () => {
    const current = drive(true);
    expect(current()).toEqual({ select: null, paneId: null });

    openTaskInApp({ taskId: 'task-live' }, focus);
    expect(current()).toEqual({ select: 'task-live', paneId: focus });

    // The next opening without a focus is another gesture: the file does not carry over.
    openTaskInApp({ taskId: 'task-other' });
    expect(current()).toEqual({ select: 'task-other', paneId: null });
  });

  test('a board that mounts after the gesture reads the task from the URL and the file from the pending focus', () => {
    openTaskInApp({ taskId: 'task-cold' }, focus);
    expect(listeners.get('topics:open-task')?.size ?? 0).toBe(0);

    expect(drive(true)()).toEqual({ select: 'task-cold', paneId: focus });
  });

  test("a project's board is not where a deep link opens", () => {
    openTaskInApp({ taskId: 'task-cold' }, focus);
    const current = drive(false);
    expect(current()).toEqual({ select: null, paneId: null });
    expect(listeners.get('topics:open-task')?.size ?? 0).toBe(0);
  });
});

describe("the board's end", () => {
  // The last link, board to drawer, is pinned on the source, as
  // globalOrchestratorEntry.test.ts pins the board: mounting 2,000 lines of
  // board to watch one prop pass is the e2e's job
  // (chat-changed-files-task-range.spec.ts, which opens the drawer on the file).
  // A board that kept a focus of its own, or stopped handing it over, would
  // leave every test above green.
  const board = readFileSync(join(import.meta.dir, 'KanbanBoardPane.tsx'), 'utf8');
  const pin = (needle: string) => expect(board.includes(needle) ? needle : `MISSING: ${needle}`).toBe(needle);

  test('the board takes the focus from this hook and hands it to the drawer', () => {
    pin('const { pendingSelect, setPendingSelect, pendingPaneId, setPendingPaneId } = useTaskDeepLink(global);');
    pin('focusPaneId={pendingPaneId ?? undefined}');
  });
});
