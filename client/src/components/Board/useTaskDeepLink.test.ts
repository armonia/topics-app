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
  const read = () => ({ select: state!.pendingSelect, paneId: state!.pendingPaneId });
  return Object.assign(read, {
    /** What the drawer is handed: the selected task and the focus it opens on. */
    drawer: () => ({ selected: state!.selectedId, focusPaneId: state!.pendingPaneId }),
    /** The board's move once the task is loaded (in its feed, or resolved). */
    promote: (id: string) => { state!.promote(id); },
  });
}

function countOpened(): () => number {
  let n = 0;
  window.addEventListener('topics:task-opened', () => { n += 1; });
  return () => n;
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

  test('the task, once loaded, becomes the selection and the drawer opens on the file the gesture named', () => {
    const current = drive(true);
    const opened = countOpened();
    openTaskInApp({ taskId: 'task-live' }, focus);
    current.promote('task-live');

    expect(current.drawer()).toEqual({ selected: 'task-live', focusPaneId: focus });
    expect(current().select).toBeNull();
    // The deep link is fulfilled: the board-focus intent it armed is released.
    expect(opened()).toBe(1);
  });

  test('a board that mounts after the gesture opens the drawer on the file too', () => {
    openTaskInApp({ taskId: 'task-cold' }, focus);
    const current = drive(true);
    current.promote('task-cold');

    expect(current.drawer()).toEqual({ selected: 'task-cold', focusPaneId: focus });
  });

  test("a project's board is not where a deep link opens", () => {
    openTaskInApp({ taskId: 'task-cold' }, focus);
    const current = drive(false);
    expect(current()).toEqual({ select: null, paneId: null });
    expect(listeners.get('topics:open-task')?.size ?? 0).toBe(0);
  });
});

describe("the board's end", () => {
  // The board does not mount under `bun test` (store, pane layout, API). What
  // it does with this hook is three lines, pinned on the source as
  // globalOrchestratorEntry.test.ts pins the board: the selection and focus
  // come from here, both promotions go through `promote`, and the drawer gets
  // the focus. These pins catch that wiring removed, not a board that clears
  // the focus on its own: the proof of the whole chain in the real board is
  // the e2e (chat-changed-files-task-range.spec.ts, the drawer's file row
  // `data-focused`).
  const board = readFileSync(join(import.meta.dir, 'KanbanBoardPane.tsx'), 'utf8');
  const pin = (needle: string) => expect(board.includes(needle) ? needle : `MISSING: ${needle}`).toBe(needle);

  test('the board takes selection and focus from this hook, promotes through it and hands the focus to the drawer', () => {
    pin('= useTaskDeepLink(global);');
    pin('promote(pendingSelect);');
    pin('promote(wantId);');
    pin('focusPaneId={pendingPaneId ?? undefined}');
  });
});
