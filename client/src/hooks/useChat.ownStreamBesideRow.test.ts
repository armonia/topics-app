/**
 * A ROW WRITTEN BESIDE THIS WINDOW'S OWN TURN REACHES ITS PANE.
 *
 * The race (M1): the stopped-by-parent card is written by the sub-agent wake at
 * the first poll after the server's `activeStreams` lets the session go
 * (`server/services/subagent-wake.ts`). `endStream` lets it go BEFORE `[DONE]`,
 * while the window that owns the turn keeps it as its own stream until the
 * `finally` after its history reload (`useChat` `performSend`). The pane handler
 * dropped every `message:new` of an own stream before asking whether the pane
 * held that id, and the reload's snapshot, older than the row, then replaced the
 * whole thread: the card showed only at the next history load.
 *
 * Reproduced deterministically on the real hooks, `useChat` and
 * `usePanelLifecycle` wired as the app wires them: the SSE ends, the history
 * read is HELD, the row arrives over the socket, and only then the read answers
 * with a snapshot taken before the row.
 *
 * @covers SUBAGENT-12
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { mount } from '../test/reactHarness';
import { useChat } from './useChat';
import { usePanelLifecycle, type UsePanelLifecycleArgs } from './usePanelLifecycle';
import { usePaneStore } from '../state/pane/store';
import { __setQueueStorage } from '../state/chatQueue';
import { __resetServerTurns } from '../state/serverTurn';
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
const found = { window: g.window, fetch: g.fetch, requestAnimationFrame: g.requestAnimationFrame, cancelAnimationFrame: g.cancelAnimationFrame };
afterAll(() => {
  for (const [k, v] of Object.entries(found)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

const frames = new Map<number, () => void>();
let frameSeq = 0;
function flushFrames(): void {
  const queued = [...frames.values()];
  frames.clear();
  for (const cb of queued) cb();
}

const realSetTimeout = globalThis.setTimeout;
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    flushFrames();
    await new Promise<void>((r) => realSetTimeout(r, 0));
  }
}

// The messages live in a module store, which outlives a test: one chat each.
let TOPIC = { id: 'parent-0', sessionKey: 'topic:parent-0', name: 'Parent' };
let SK = TOPIC.sessionKey;
let chatSeq = 0;
const PROMPT = 'ferma il figlio';
const REPLY = 'Fermato.';
const STOP_ROW = () => ({
  type: 'message:new', topicId: TOPIC.id, sessionKey: SK, role: 'assistant',
  messageId: 'row-stopped-by-parent', content: 'Sub-agent «child» stopped by the parent.',
  preview: 'Sub-agent «child» stopped by the parent.',
  blocks: [{ kind: 'subagent-result', results: [{ agentId: 'child', status: 'stopped' }] }],
});
const STOP_ID = 'row-stopped-by-parent';
const STOP_TEXT = 'Sub-agent «child» stopped by the parent.';

const SSE = new TextEncoder();
function sseFrame(data: string): Uint8Array { return SSE.encode(`data: ${data}\n\n`); }

/** The SSE body, driven by the test: each `push` is one read of the reader. */
function drivenSse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  return {
    body,
    content(text: string) { controller.enqueue(sseFrame(JSON.stringify({ choices: [{ delta: { content: text } }] }))); },
    done() { controller.enqueue(sseFrame('[DONE]')); controller.close(); },
  };
}

let sse: ReturnType<typeof drivenSse>;
let historyAsked: (() => void) | null;
let releaseHistory: ((messages: unknown[]) => void) | null;

function installFetch(): void {
  g.fetch = async (input: unknown) => {
    const url = typeof input === 'string' ? input : (input as { url: string }).url;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/api/chat')) return new Response(sse.body, { status: 200 });
    if (url.includes('/api/history/')) {
      // HELD: the window between the end of the SSE and the end of its reload.
      const messages = await new Promise<unknown[]>((resolve) => {
        releaseHistory = resolve;
        historyAsked?.();
      });
      return json({ messages, isStreaming: false });
    }
    if (url.includes('/api/topics/streaming')) return json({ sessions: [] });
    return json(null);
  };
}

type Chat = ReturnType<typeof useChat>;

function mountBoth() {
  const lifecycleHandlers = new Set<(msg: WSMessage) => void>();
  const box: { chat: Chat | null } = { chat: null };
  function App(): null {
    const chat = useChat();
    React.useEffect(() => { box.chat = chat; });
    usePanelLifecycle({
      isDetached: true, detachedTopicId: TOPIC.id, detachedTopicIds: [TOPIC.id], isMobile: false,
      topics: { [TOPIC.id]: TOPIC },
      topicsLoading: false, loadTopics: () => {}, createTopic: async () => null, applyTopicFromWS: () => {},
      archiveProject: async () => true, archiveTopic: async () => true, ensureTopic: async () => null,
      workspaceProjects: [], terminalSessions: [], pruneStaleTerminalPanes: (ids: string[]) => ids,
      terminalOps: { markRecentlyCreated: () => {}, addOptimisticSession: () => {} },
      onWSMessage: (h: (msg: WSMessage) => void) => { lifecycleHandlers.add(h); return () => { lifecycleHandlers.delete(h); }; },
      sendWS: () => {}, windowId: 'owner-window',
      chatStreamHandlers: {
        isOwnStream: chat.isOwnStream, isSessionStreaming: chat.isSessionStreaming,
        getSessionMessages: chat.getSessionMessages, addMessageFromWS: chat.addMessageFromWS,
        clearSession: chat.clearSession, loadHistory: chat.loadHistory,
        appendMediaToLastAssistant: chat.appendMediaToLastAssistant, sendMessage: chat.sendMessage, drainQueue: chat.drainQueue,
      },
      setSidebarCollapsed: () => {}, removeClosedTab: () => {}, closedTabs: [],
    } as unknown as UsePanelLifecycleArgs);
    return null;
  }
  const harness = mount(React.createElement(App));
  const chat = (): Chat => {
    if (!box.chat) throw new Error('useChat did not mount');
    return box.chat;
  };
  return {
    chat,
    /** One socket frame, delivered the way the app delivers it: chat first, then the panes. */
    ws(frame: Record<string, unknown>) {
      chat().onWSMessage(frame as unknown as WSMessage);
      for (const h of [...lifecycleHandlers]) h(frame as unknown as WSMessage);
      flushFrames();
      harness.rerender();
    },
    rows: () => chat().getSessionMessages(SK).map((m) => ({ id: m.id, role: m.role, content: m.content })),
    rerender: () => harness.rerender(),
    unmount: () => harness.unmount(),
  };
}

const store = usePaneStore.getState();

beforeEach(() => {
  chatSeq += 1;
  TOPIC = { id: `parent-${chatSeq}`, sessionKey: `topic:parent-${chatSeq}`, name: 'Parent' };
  SK = TOPIC.sessionKey;
  g.window = {
    localStorage: new MemStorage(),
    location: { origin: 'https://app.test', href: 'https://app.test/', pathname: '/', search: '', protocol: 'https:' },
    history: { pushState: () => {}, replaceState: () => {} },
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
  };
  g.requestAnimationFrame = (cb: () => void) => { frames.set(++frameSeq, cb); return frameSeq; };
  g.cancelAnimationFrame = (id: number) => { frames.delete(id); };
  __setQueueStorage(null);
  __resetServerTurns();
  sse = drivenSse();
  historyAsked = null;
  releaseHistory = null;
  installFetch();
});

afterEach(() => {
  g.fetch = found.fetch;
  usePaneStore.setState(store, true);
});

const SNAPSHOT_BEFORE_ROW = [
  { id: 'row-user', role: 'user', content: PROMPT, timestamp: '2026-10-03T10:00:00.000Z' },
  { id: 'row-reply', role: 'assistant', content: REPLY, timestamp: '2026-10-03T10:00:01.000Z' },
];

describe('a row written beside the own turn', () => {
  test('arrives while the reload after [DONE] is in flight, older snapshot: it stays in the pane', async () => {
    const app = mountBoth();
    const asked = new Promise<void>((r) => { historyAsked = r; });
    const sent = app.chat().sendMessage(SK, PROMPT);
    await settle();
    sse.content(REPLY);
    sse.done();
    await asked;
    await settle();
    expect(app.chat().isOwnStream(SK)).toBe(true);

    // The turn's own echo comes back too, under the durable ids: never twice.
    app.ws({ type: 'message:new', topicId: TOPIC.id, sessionKey: SK, role: 'user', messageId: 'row-user', content: PROMPT });
    app.ws({ type: 'message:new', topicId: TOPIC.id, sessionKey: SK, role: 'assistant', messageId: 'row-reply', content: REPLY });
    app.ws(STOP_ROW());
    await settle();
    // Before the fix: dropped by `isOwnStream`, so not here.
    expect(app.rows().map((r) => r.id)).toContain(STOP_ID);

    releaseHistory!(SNAPSHOT_BEFORE_ROW);
    await sent;
    await settle();
    app.rerender();

    // Before the fix: the snapshot replaced the thread and the card was gone.
    expect(app.rows()).toEqual([
      { id: 'row-user', role: 'user', content: PROMPT },
      { id: 'row-reply', role: 'assistant', content: REPLY },
      { id: STOP_ID, role: 'assistant', content: STOP_TEXT },
    ]);
    app.unmount();
  });

  test('arrives before [DONE], while the reply still streams: it does not take the reply\'s bubble', async () => {
    const app = mountBoth();
    const asked = new Promise<void>((r) => { historyAsked = r; });
    const sent = app.chat().sendMessage(SK, PROMPT);
    await settle();
    sse.content(REPLY);
    await settle();

    app.ws(STOP_ROW());
    await settle();
    const live = app.rows();
    // The reply bubble keeps its text, and the card is a row of its own.
    expect(live.filter((r) => r.role === 'assistant').map((r) => r.content)).toEqual([REPLY, STOP_TEXT]);

    sse.done();
    await asked;
    releaseHistory!([...SNAPSHOT_BEFORE_ROW, { id: STOP_ID, role: 'assistant', content: STOP_TEXT, timestamp: '2026-10-03T10:00:02.000Z' }]);
    await sent;
    await settle();
    app.rerender();
    // In the snapshot as well: once, not twice.
    expect(app.rows().map((r) => r.id)).toEqual(['row-user', 'row-reply', STOP_ID]);
    app.unmount();
  });

  test('without blocks, a row of the own stream is the turn\'s echo and is not drawn again', async () => {
    const app = mountBoth();
    const asked = new Promise<void>((r) => { historyAsked = r; });
    const sent = app.chat().sendMessage(SK, PROMPT);
    await settle();
    sse.content(REPLY);
    await settle();
    app.ws({ type: 'message:new', topicId: TOPIC.id, sessionKey: SK, role: 'assistant', messageId: 'row-reply', content: REPLY });
    await settle();
    expect(app.rows().filter((r) => r.role === 'assistant')).toHaveLength(1);
    sse.done();
    await asked;
    releaseHistory!(SNAPSHOT_BEFORE_ROW);
    await sent;
    await settle();
    app.unmount();
  });
});
