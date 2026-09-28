/**
 * A ROW OF THE STRIP OPENS WHERE ITS COUNTS CAME FROM, through the real strip.
 *
 * `lib/changesStripOpen.test.ts` pins the rule; nothing there fails if the
 * strip stops calling it. This mounts `ChangedFilesStrip` (`test/reactHarness`:
 * no DOM in this repo), answers its `/changes` fetch, clicks the chip and a row
 * through the handlers the component drew, and reads what reached the window's
 * bus. The drawer's end of it is `Board/useTaskDeepLink.test.ts`.
 *
 * @covers CHAT-CHANGES-01
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { mount, type Harness, type HostNode } from '../../test/reactHarness';
import { ChangedFilesStrip } from './ChangedFilesStrip';
import { diffFocusFor } from '../Board/constants';
import type { TopicChanges } from '../../../../shared/topic-changes';

const g = globalThis as unknown as Record<string, unknown>;
const saved = { window: g.window, fetch: g.fetch };
let events: Array<{ type: string; detail: unknown }> = [];
let harness: Harness | null = null;

const landed: TopicChanges = {
  files: [
    { path: 'src/a.ts', kind: 'created', turns: 1, lastAt: '', added: 2, removed: 0, inRange: true },
    { path: '/elsewhere/package.json', kind: 'modified', turns: 1, lastAt: '' },
  ],
  git: { root: '/repo', branch: 'main' },
  taskId: 'task-strip',
};

beforeEach(() => {
  events = [];
  const location = { origin: 'http://localhost', href: 'http://localhost/', pathname: '/', search: '' };
  g.window = {
    location,
    history: {
      pushState: (_state: unknown, _title: unknown, url: string) => {
        const u = new URL(url);
        Object.assign(location, { href: u.href, pathname: u.pathname, search: u.search });
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: (e: Event) => {
      events.push({ type: e.type, detail: (e as CustomEvent).detail });
      return true;
    },
  };
  g.fetch = async () => new Response(JSON.stringify(landed));
});

afterEach(() => {
  harness?.unmount();
  harness = null;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete g[key]; else g[key] = value;
  }
});

function host(h: Harness, testId: string, path?: string): HostNode | undefined {
  return h.last().hosts.find((n) => n.props['data-testid'] === testId && (path === undefined || n.props['data-path'] === path));
}

function click(node: HostNode | undefined): void {
  if (!node) throw new Error('nothing drawn to click');
  (node.props.onClick as (e: { stopPropagation: () => void }) => void)({ stopPropagation: () => {} });
}

/** Mounts the strip, waits for its fetch to land, and opens the list. */
async function openList(): Promise<Harness> {
  const h = mount(createElement(ChangedFilesStrip, {
    topic: { id: 'topic-1', projectPath: '/project', worktreeId: null },
    onWSMessage: () => () => {},
  }));
  harness = h;
  for (let i = 0; i < 100 && !host(h, 'chat-changes-chip'); i++) await new Promise((r) => setTimeout(r, 1));
  click(host(h, 'chat-changes-chip'));
  return h;
}

describe('a row of the changed-files strip', () => {
  test("counted on the task's range, it opens the task's drawer on that file", async () => {
    const h = await openList();
    click(host(h, 'changed-file-row', 'src/a.ts'));

    expect(events.find((e) => e.type === 'topics:open-task')?.detail)
      .toEqual({ taskId: 'task-strip', focusPaneId: diffFocusFor('src/a.ts') });
    expect(events.some((e) => e.type === 'open-file-diff')).toBe(false);
  });

  test("outside the range, it opens the editor's diff in the tree the route read", async () => {
    const h = await openList();
    click(host(h, 'changed-file-row', '/elsewhere/package.json'));

    expect(events.map((e) => e.type)).toEqual(['open-file-diff']);
    expect(events[0]!.detail).toEqual({ filePath: '/elsewhere/package.json', projectPath: '/repo' });
  });
});
