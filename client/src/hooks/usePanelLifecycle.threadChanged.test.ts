/**
 * THE APP'S OWN PANE LIFECYCLE TURNS A THREAD-CHANGED FRAME INTO A FRESH READ
 * (card edf3c4db).
 *
 * The server announces rows it changed out of band (the end of a boot reattach
 * leg, a resend the chat route refused) with a `topic:updated` carrying
 * `threadChanged`. A window that read the chat in the last 5 s drops a plain
 * read on the history dedup, and at boot every window has just read on
 * reconnect: the read has to go out `fresh`. `threadReconcile.test.ts` drives
 * the subscription alone; this file mounts `usePanelLifecycle` itself, the hook
 * the app runs, so a lifecycle that stops installing the subscription, or stops
 * handing `opts` to `loadHistory`, goes red here.
 *
 * Mounted detached on one chat (the smallest real pane set: its effects that
 * touch the pane store stand down in a detached window), on the hook harness,
 * with frames emitted on a fake `onWSMessage`.
 *
 * @covers INTERRUPT-01, RESUME-02
 */
import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import * as React from 'react';
import { mount, type Harness } from '../test/reactHarness';
import { usePanelLifecycle, type UsePanelLifecycleArgs } from './usePanelLifecycle';
import { usePaneStore } from '../state/pane/store';
import type { WSMessage } from '../types';

class MemStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

const g = globalThis as unknown as Record<string, unknown>;
// Process-wide: put back what this file found, or the next file in the same
// `bun test` process meets a partial window.
const found = { window: g.window };
afterAll(() => {
  if (found.window === undefined) delete g.window;
  else g.window = found.window;
});
const w = (g.window as Record<string, unknown> | undefined) ?? {};
w.localStorage ??= new MemStorage();
w.addEventListener ??= () => {};
w.removeEventListener ??= () => {};
w.dispatchEvent ??= () => true;
g.window = w;

const TOPIC = { id: 'lifecycle-1', sessionKey: 'topic:lifecycle-1', name: 'Misura' };

function mountPane() {
  const handlers = new Set<(msg: WSMessage) => void>();
  const reads: Array<[string, { fresh?: boolean } | undefined]> = [];
  const args = {
    isDetached: true, detachedTopicId: TOPIC.id, detachedTopicIds: [TOPIC.id], isMobile: false,
    topics: { [TOPIC.id]: TOPIC },
    topicsLoading: false, loadTopics: () => {}, createTopic: async () => null, applyTopicFromWS: () => {},
    archiveProject: async () => true, archiveTopic: async () => true, ensureTopic: async () => null,
    workspaceProjects: [], terminalSessions: [], pruneStaleTerminalPanes: (ids: string[]) => ids, terminalOps: {},
    onWSMessage: (h: (msg: WSMessage) => void) => { handlers.add(h); return () => { handlers.delete(h); }; },
    sendWS: () => {}, windowId: 'lifecycle-window',
    chatStreamHandlers: {
      isOwnStream: () => false,
      isSessionStreaming: () => false,
      loadHistory: (sk: string, opts?: { fresh?: boolean }) => { reads.push([sk, opts]); },
    },
    setSidebarCollapsed: () => {}, removeClosedTab: () => {}, closedTabs: [],
  } as unknown as UsePanelLifecycleArgs;
  function Pane(): null {
    usePanelLifecycle(args);
    return null;
  }
  const harness: Harness = mount(React.createElement(Pane));
  return {
    reads,
    emit: (frame: Record<string, unknown>) => { for (const h of [...handlers]) h(frame as unknown as WSMessage); },
    unmount: () => harness.unmount(),
  };
}

describe('the pane lifecycle, from the frame on the socket to the read', () => {
  const store = usePaneStore.getState();
  let pane: ReturnType<typeof mountPane> | null = null;
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => {
    pane?.unmount();
    pane = null;
    jest.useRealTimers();
    usePaneStore.setState(store, true);
  });

  test('a thread-changed frame reads the chat fresh, past the history dedup', () => {
    pane = mountPane();
    pane.emit({ type: 'topic:updated', topic: TOPIC, threadChanged: true });
    jest.advanceTimersByTime(400);
    expect(pane.reads).toEqual([[TOPIC.sessionKey, { fresh: true }]]);
  });

  test('a plain topic:updated still reads it the ordinary way', () => {
    pane = mountPane();
    pane.emit({ type: 'topic:updated', topic: TOPIC });
    jest.advanceTimersByTime(400);
    expect(pane.reads).toEqual([[TOPIC.sessionKey, undefined]]);
  });

  test('a chat this window does not hold is not read', () => {
    pane = mountPane();
    pane.emit({ type: 'topic:updated', topic: { id: 'elsewhere', sessionKey: 'topic:elsewhere' }, threadChanged: true });
    jest.advanceTimersByTime(400);
    expect(pane.reads).toEqual([]);
  });
});
