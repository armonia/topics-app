/**
 * THE STRIP DRAWS THE TOPIC'S CHANGESET, and what the changeset does not hold
 * stays a plain row, through the real strip.
 *
 * `lib/changesStripOpen.test.ts` pins where a plain row opens; nothing there
 * fails if the strip stops calling it, or draws every row plain again. This
 * mounts `ChangedFilesStrip` (`test/reactHarness`: no DOM in this repo),
 * answers its `/changes` and `/changes/diff` fetches, clicks the chip and a row
 * through the handlers the component drew, and reads what reached the window's
 * bus. The drawer's end of the link is `Board/useTaskDeepLink.test.ts`.
 *
 * @covers CHAT-CHANGES-01, CHGSET-03
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { mount, type Harness, type HostNode } from '../../test/reactHarness';
import { ChangedFilesStrip } from './ChangedFilesStrip';
import { diffFocusFor } from '../Board/constants';
import type { TopicChanges } from '../../../../shared/topic-changes';
import type { ChangeSet } from '../../../../shared/change-set';

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
  revs: { base: 'a'.repeat(40), head: 'b'.repeat(40) },
};

/** The card's range holds `src/a.ts`; the write in another folder is not in it. */
const rangeSet: ChangeSet = {
  stat: [{ path: 'src/a.ts', additions: 2, deletions: 0, status: 'A' }],
  patch: 'diff --git a/src/a.ts b/src/a.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/a.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n',
  truncated: false,
  revs: landed.revs,
};

let changes: TopicChanges = landed;
const asked: string[] = [];

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
  changes = landed;
  asked.length = 0;
  g.fetch = async (input: unknown) => {
    const url = String(input);
    asked.push(url);
    return new Response(JSON.stringify(url.includes('/changes/diff') ? rangeSet : changes));
  };
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

/** Mounts the strip, waits for its fetch to land, opens the panel and waits for the changeset. */
async function openList(): Promise<Harness> {
  const h = mount(createElement(ChangedFilesStrip, {
    topic: { id: 'topic-1', projectPath: '/project', worktreeId: null },
    onWSMessage: () => () => {},
  }));
  harness = h;
  for (let i = 0; i < 100 && !host(h, 'chat-changes-chip'); i++) await new Promise((r) => setTimeout(r, 1));
  click(host(h, 'chat-changes-chip'));
  for (let i = 0; i < 100 && host(h, 'chat-changes-loading'); i++) await new Promise((r) => setTimeout(r, 1));
  return h;
}

describe('the panel of the changed-files strip', () => {
  test('the changeset is asked for only once the panel opens', async () => {
    const h = mount(createElement(ChangedFilesStrip, {
      topic: { id: 'topic-1', projectPath: '/project', worktreeId: null },
      onWSMessage: () => () => {},
    }));
    harness = h;
    for (let i = 0; i < 100 && !host(h, 'chat-changes-chip'); i++) await new Promise((r) => setTimeout(r, 1));
    expect(asked.some((u) => u.includes('/changes/diff'))).toBe(false);
    click(host(h, 'chat-changes-chip'));
    for (let i = 0; i < 100 && host(h, 'chat-changes-loading'); i++) await new Promise((r) => setTimeout(r, 1));
    expect(asked.filter((u) => u.includes('/changes/diff'))).toEqual(['/api/topics/topic-1/changes/diff']);
  });

  // The panel itself (`UnifiedDiff`, loaded lazily) draws in the e2e
  // `chat-changed-files.spec.ts`: this harness renders no lazy component.
  test('a file of the changeset goes to the diff, not to the plain rows', async () => {
    const h = await openList();
    expect(host(h, 'chat-changes-diff')).toBeDefined();
    expect(host(h, 'changed-file-row', 'src/a.ts')).toBeUndefined();
  });

  test("a row outside the changeset stays a plain row, and opens the editor's diff in the tree the route read", async () => {
    const h = await openList();
    click(host(h, 'changed-file-row', '/elsewhere/package.json'));

    expect(events.map((e) => e.type)).toEqual(['open-file-diff']);
    expect(events[0]!.detail).toEqual({ filePath: '/elsewhere/package.json', projectPath: '/repo' });
  });

  test("on a card's topic the link opens the card's drawer on the diff's file", async () => {
    const h = await openList();
    click(host(h, 'chat-changes-open-card'));

    expect(events.find((e) => e.type === 'topics:open-task')?.detail)
      .toEqual({ taskId: 'task-strip', focusPaneId: diffFocusFor('src/a.ts') });
  });

  test('a topic no card owns has no link to a card', async () => {
    const { taskId: _owned, ...plain } = landed;
    changes = plain;
    const h = await openList();
    expect(host(h, 'chat-changes-diff')).toBeDefined();
    expect(host(h, 'chat-changes-open-card')).toBeUndefined();
  });
});
