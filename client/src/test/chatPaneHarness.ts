/**
 * The real `useChat` and `usePanelLifecycle`, wired as `App` wires them, over a
 * `fetch` the test drives: the SSE body, the answer to each `POST /api/chat`
 * and each history read. Socket frames are delivered the way the app delivers
 * them: the chat's handler first, then the panes'.
 *
 * Shared by the tests of the person's own message beside rows written by
 * others (`hooks/useChat.ownStreamBesideRow.test.ts`) and on every way a send
 * can end (`hooks/useChat.ownBubbleByKey.test.ts`). No `bun:test` import here:
 * this file is type-checked with the app, and each test file wires `setUp`,
 * `tearDown` and `restoreGlobals` into its own hooks.
 */
import * as React from 'react';
import { mount } from './reactHarness';
import { useChat } from '../hooks/useChat';
import { usePanelLifecycle, type UsePanelLifecycleArgs } from '../hooks/usePanelLifecycle';
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
const found = { window: g.window, localStorage: g.localStorage, fetch: g.fetch, requestAnimationFrame: g.requestAnimationFrame, cancelAnimationFrame: g.cancelAnimationFrame };

/** Put back the globals this harness replaced (`afterAll`). */
export function restoreGlobals(): void {
  for (const [k, v] of Object.entries(found)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
}

const frames = new Map<number, () => void>();
let frameSeq = 0;
function flushFrames(): void {
  const queued = [...frames.values()];
  frames.clear();
  for (const cb of queued) cb();
}

const realSetTimeout = globalThis.setTimeout;
/** Every animation frame and every macrotask the hooks queued, twenty rounds deep. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    flushFrames();
    await new Promise<void>((r) => realSetTimeout(r, 0));
  }
}

const SSE = new TextEncoder();
function sseFrame(data: string): Uint8Array { return SSE.encode(`data: ${data}\n\n`); }

/** The SSE body, driven by the test: each `push` is one read of the reader. */
export function drivenSse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  return {
    body,
    content(text: string) { controller.enqueue(sseFrame(JSON.stringify({ choices: [{ delta: { content: text } }] }))); },
    done() { controller.enqueue(sseFrame('[DONE]')); controller.close(); },
  };
}

/** The chat under test: one per test, since the message store outlives a test. */
export const chat = { topic: { id: 'parent-0', sessionKey: 'topic:parent-0', name: 'Parent' }, sk: 'topic:parent-0' };
let chatSeq = 0;

/** The network as the test drives it. */
export const net = {
  /** The body the next unheld `POST /api/chat` streams. */
  sse: drivenSse(),
  /** The key each `POST /api/chat` carried, in order; `sentClientId` is the last one. */
  sentKeys: [] as string[],
  sentClientId: null as string | null,
  /** Set: the next `POST /api/chat` waits for `answerChat` (a Response, or an Error it rejects with); an abort rejects it. */
  holdChat: false,
  answerChat: null as ((answer: Response | Error) => void) | null,
  /** Set: every history read answers at once with these rows. Unset: it is HELD until `releaseHistory` or `failHistory`. */
  historyAnswer: null as unknown[] | null,
  historyAsked: null as (() => void) | null,
  releaseHistory: null as ((messages: unknown[]) => void) | null,
  failHistory: null as (() => void) | null,
  historyReads: 0,
};

function installFetch(): void {
  g.fetch = async (input: unknown, init?: { body?: unknown; signal?: AbortSignal | null }) => {
    const url = typeof input === 'string' ? input : (input as { url: string }).url;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/api/chat')) {
      net.sentClientId = (JSON.parse(String(init?.body)) as { clientMessageId?: string }).clientMessageId ?? null;
      if (net.sentClientId) net.sentKeys.push(net.sentClientId);
      if (net.holdChat) {
        net.holdChat = false;
        return new Promise<Response>((resolve, reject) => {
          net.answerChat = (answer) => (answer instanceof Error ? reject(answer) : resolve(answer));
          init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
        });
      }
      return new Response(net.sse.body, { status: 200 });
    }
    if (url.endsWith('/regenerate')) return new Response(net.sse.body, { status: 200 });
    if (url.includes('/api/history/')) {
      net.historyReads += 1;
      if (net.historyAnswer) return json({ messages: net.historyAnswer, isStreaming: false });
      // HELD: the window between the end of the SSE and the end of its reload.
      const messages = await new Promise<unknown[] | null>((resolve) => {
        net.releaseHistory = resolve;
        net.failHistory = () => resolve(null);
        net.historyAsked?.();
      });
      return messages ? json({ messages, isStreaming: false }) : new Response('down', { status: 503 });
    }
    if (url.includes('/api/topics/streaming')) return json({ sessions: [] });
    return json(null);
  };
}

const store = usePaneStore.getState();

/** A fresh chat, a fresh network, fresh globals (`beforeEach`). */
export function setUp(): void {
  chatSeq += 1;
  chat.topic = { id: `parent-${chatSeq}`, sessionKey: `topic:parent-${chatSeq}`, name: 'Parent' };
  chat.sk = chat.topic.sessionKey;
  // The page's storage, under both names: the outbound queue reads the bare global.
  g.localStorage = new MemStorage();
  g.window = {
    localStorage: g.localStorage,
    location: { origin: 'https://app.test', href: 'https://app.test/', pathname: '/', search: '', protocol: 'https:' },
    history: { pushState: () => {}, replaceState: () => {} },
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
  };
  g.requestAnimationFrame = (cb: () => void) => { frames.set(++frameSeq, cb); return frameSeq; };
  g.cancelAnimationFrame = (id: number) => { frames.delete(id); };
  __setQueueStorage(null);
  __resetServerTurns();
  Object.assign(net, {
    sse: drivenSse(), sentKeys: [], sentClientId: null, holdChat: false, answerChat: null,
    historyAnswer: null, historyAsked: null, releaseHistory: null, failHistory: null, historyReads: 0,
  });
  installFetch();
}

/** `afterEach`. */
export function tearDown(): void {
  g.fetch = found.fetch;
  usePaneStore.setState(store, true);
}

type Chat = ReturnType<typeof useChat>;

/** The two hooks mounted together, as `App` mounts them, on the chat under test. */
export function mountBoth() {
  const lifecycleHandlers = new Set<(msg: WSMessage) => void>();
  const box: { chat: Chat | null } = { chat: null };
  const topic = chat.topic;
  const sk = chat.sk;
  function App(): null {
    const hook = useChat();
    React.useEffect(() => { box.chat = hook; });
    usePanelLifecycle({
      isDetached: true, detachedTopicId: topic.id, detachedTopicIds: [topic.id], isMobile: false,
      topics: { [topic.id]: topic },
      topicsLoading: false, loadTopics: () => {}, createTopic: async () => null, applyTopicFromWS: () => {},
      archiveProject: async () => true, archiveTopic: async () => true, ensureTopic: async () => null,
      workspaceProjects: [], terminalSessions: [], pruneStaleTerminalPanes: (ids: string[]) => ids,
      terminalOps: { markRecentlyCreated: () => {}, addOptimisticSession: () => {} },
      onWSMessage: (h: (msg: WSMessage) => void) => { lifecycleHandlers.add(h); return () => { lifecycleHandlers.delete(h); }; },
      sendWS: () => {}, windowId: 'owner-window',
      chatStreamHandlers: {
        isOwnStream: hook.isOwnStream, isSessionStreaming: hook.isSessionStreaming,
        getSessionMessages: hook.getSessionMessages, addMessageFromWS: hook.addMessageFromWS,
        clearSession: hook.clearSession, loadHistory: hook.loadHistory,
        appendMediaToLastAssistant: hook.appendMediaToLastAssistant, sendMessage: hook.sendMessage, drainQueue: hook.drainQueue,
      },
      setSidebarCollapsed: () => {}, removeClosedTab: () => {}, closedTabs: [],
    } as unknown as UsePanelLifecycleArgs);
    return null;
  }
  const harness = mount(React.createElement(App));
  const current = (): Chat => {
    if (!box.chat) throw new Error('useChat did not mount');
    return box.chat;
  };
  return {
    chat: current,
    /** One socket frame, delivered the way the app delivers it: chat first, then the panes. */
    ws(frame: Record<string, unknown>) {
      current().onWSMessage(frame as unknown as WSMessage);
      for (const h of [...lifecycleHandlers]) h(frame as unknown as WSMessage);
      flushFrames();
      harness.rerender();
    },
    /** The same frame heard by the panes first: the order the two subscriptions take after one of them re-subscribes. */
    wsPanesFirst(frame: Record<string, unknown>) {
      for (const h of [...lifecycleHandlers]) h(frame as unknown as WSMessage);
      current().onWSMessage(frame as unknown as WSMessage);
      flushFrames();
      harness.rerender();
    },
    rows: () => current().getSessionMessages(sk).map((m) => ({ id: m.id, role: m.role, content: m.content })),
    /** The person's rows that hold the blocks the machine marks them with. */
    markedUserRows: () => current().getSessionMessages(sk).filter((m) => m.role === 'user' && (m.blocks?.length ?? 0) > 0).map((m) => m.id),
    rerender: () => harness.rerender(),
    unmount: () => harness.unmount(),
  };
}
