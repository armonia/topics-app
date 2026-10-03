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
import { __setQueueStorage, getQueue } from '../state/chatQueue';
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
/** The key the last send carried, as the server echoes it on the person's row. */
let sentClientId: string | null;
/** Set: the next `POST /api/chat` waits for the test to answer it (`answerChat`). */
let holdChat: boolean;
let answerChat: ((response: Response) => void) | null;

function installFetch(): void {
  g.fetch = async (input: unknown, init?: { body?: unknown }) => {
    const url = typeof input === 'string' ? input : (input as { url: string }).url;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/api/chat')) {
      sentClientId = (JSON.parse(String(init?.body)) as { clientMessageId?: string }).clientMessageId ?? null;
      if (holdChat) {
        holdChat = false;
        return new Promise<Response>((resolve) => { answerChat = resolve; });
      }
      return new Response(sse.body, { status: 200 });
    }
    if (url.endsWith('/regenerate')) return new Response(sse.body, { status: 200 });
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
        isOwnStream: chat.isOwnStream, ownSends: chat.ownSends, isSessionStreaming: chat.isSessionStreaming,
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
    /** The person's rows that hold the blocks the machine marks them with. */
    markedUserRows: () => chat().getSessionMessages(SK).filter((m) => m.role === 'user' && (m.blocks?.length ?? 0) > 0).map((m) => m.id),
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
  sentClientId = null;
  holdChat = false;
  answerChat = null;
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

/**
 * The same class with `user` rows (verifier, 03/10): the pane took every
 * non-assistant row of an own stream for the turn's echo. But the machine
 * writes `user` rows beside the turn too, each with its mark: the wake's
 * sub-agent result, the goal's continuation, the board's envelope. Only the
 * row of the message THIS window sent is its echo, known by the key the send
 * carried.
 */
const BESIDE_USER_ROWS = () => [
  {
    id: 'row-wake', content: 'Sub-agent «child» finished.',
    blocks: [{ kind: 'subagent-result', results: [{ agentId: 'child', status: 'completed' }] }],
  },
  { id: 'row-nudge', content: 'Objective still open: finish the migration.', blocks: [{ kind: 'goal-nudge', attempt: 1 }] },
  { id: 'row-envelope', content: 'Card #12: carry on.', blocks: [{ kind: 'dispatched-envelope' }] },
];

describe('a user row written beside the own turn', () => {
  test('the wake\'s result, the goal nudge and the board\'s envelope reach the pane and survive the older snapshot', async () => {
    const app = mountBoth();
    const asked = new Promise<void>((r) => { historyAsked = r; });
    const sent = app.chat().sendMessage(SK, PROMPT);
    await settle();
    sse.content(REPLY);
    sse.done();
    await asked;
    await settle();
    expect(app.chat().isOwnStream(SK)).toBe(true);
    expect(sentClientId).toBeTruthy();

    // The own echo comes back WITH a mark (a repeated message is marked too):
    // the key says it is ours, and it is not drawn twice.
    app.ws({
      type: 'message:new', topicId: TOPIC.id, sessionKey: SK, role: 'user', messageId: 'row-user', content: PROMPT,
      clientMessageId: sentClientId, blocks: [{ kind: 'repeated', count: 2 }],
    });
    for (const row of BESIDE_USER_ROWS()) {
      app.ws({ type: 'message:new', topicId: TOPIC.id, sessionKey: SK, role: 'user', messageId: row.id, content: row.content, blocks: row.blocks });
    }
    await settle();
    // Before the fix: every user row of an own stream was dropped as echo.
    expect(app.markedUserRows()).toEqual(['row-wake', 'row-nudge', 'row-envelope']);
    expect(app.rows().filter((r) => r.role === 'user' && r.content === PROMPT)).toHaveLength(1);

    releaseHistory!(SNAPSHOT_BEFORE_ROW);
    await sent;
    await settle();
    app.rerender();
    expect(app.rows().map((r) => r.id)).toEqual(['row-user', 'row-reply', 'row-wake', 'row-nudge', 'row-envelope']);
    app.unmount();
  });

  // Until 03/10 a keyless row with the sent text was dropped here as the echo
  // of a server without the key: it was another agent's message
  // (`a keyless user row with the words I sent`, below).
  test('a user row with another window\'s key is not mine: it is drawn', async () => {
    const app = mountBoth();
    const asked = new Promise<void>((r) => { historyAsked = r; });
    const sent = app.chat().sendMessage(SK, PROMPT);
    await settle();
    sse.content(REPLY);
    sse.done();
    await asked;
    await settle();
    app.ws({ type: 'message:new', topicId: TOPIC.id, sessionKey: SK, role: 'user', messageId: 'row-user', content: PROMPT, clientMessageId: sentClientId });
    // Another window's message, with its own key: not ours.
    app.ws({ type: 'message:new', topicId: TOPIC.id, sessionKey: SK, role: 'user', messageId: 'row-other', content: 'from the phone', clientMessageId: 'phone-key' });
    await settle();
    expect(app.rows().filter((r) => r.role === 'user').map((r) => r.content)).toEqual([PROMPT, 'from the phone']);
    releaseHistory!(SNAPSHOT_BEFORE_ROW);
    await sent;
    await settle();
    app.unmount();
  });

  test('regenerate: a row that arrives while its reload is in flight stays in the pane', async () => {
    const app = mountBoth();
    // A thread already on screen.
    let asked = new Promise<void>((r) => { historyAsked = r; });
    const first = app.chat().sendMessage(SK, PROMPT);
    await settle();
    sse.content(REPLY);
    sse.done();
    await asked;
    releaseHistory!(SNAPSHOT_BEFORE_ROW);
    await first;
    await settle();

    sse = drivenSse();
    asked = new Promise<void>((r) => { historyAsked = r; });
    const regenerated = app.chat().regenerateMessage(SK, 'row-reply');
    await asked;
    expect(app.chat().isOwnStream(SK)).toBe(true);
    const wake = BESIDE_USER_ROWS()[0]!;
    app.ws({ type: 'message:new', topicId: TOPIC.id, sessionKey: SK, role: 'user', messageId: wake.id, content: wake.content, blocks: wake.blocks });
    app.ws(STOP_ROW());
    await settle();
    expect(app.rows().map((r) => r.id)).toContain(wake.id);

    // The branch's snapshot, taken before both rows were written.
    releaseHistory!([...SNAPSHOT_BEFORE_ROW, { id: 'row-reply-2', role: 'assistant', content: '', timestamp: '2026-10-03T10:00:05.000Z', partial: true }]);
    await settle();
    sse.content('Again.');
    sse.done();
    await regenerated;
    await settle();
    app.rerender();
    // Before the fix: the branch reload replaced the thread and both were gone.
    const ids = app.rows().map((r) => r.id);
    expect(ids).toContain(wake.id);
    expect(ids).toContain(STOP_ID);
    app.unmount();
  });
});

/**
 * A send the server REFUSES while a row written by someone else lands beside it
 * (verifier, 03/10). From the moment the POST leaves, the window holds the
 * stream as its own; a row another device or the machine writes in that window
 * wins the server's gate, reaches this pane (it is not this send's echo), and
 * the POST then answers 409 `stream_in_flight`. The message goes back to the
 * queue, and only there: its optimistic bubble and its assistant placeholder
 * leave the thread by the ids this send gave them, wherever they are, not by
 * position (the other row is now the last one) nor by text (the other row may
 * say the same words).
 */
const FROM_DESKTOP = 'from desktop';
const TURN_OPEN = { boot: 'b', asOf: 1, turnId: 1, open: true };
const inFlight = () => new Response(
  JSON.stringify({ error: 'a response is already streaming for this session', code: 'stream_in_flight', turn: TURN_OPEN }),
  { status: 409, headers: { 'content-type': 'application/json' } },
);

describe('a send refused while a row written beside it lands', () => {
  async function refusedBeside(app: ReturnType<typeof mountBoth>, content: string, row: Record<string, unknown>): Promise<boolean> {
    holdChat = true;
    const sent = app.chat().sendMessage(SK, content);
    await settle();
    expect(app.chat().isOwnStream(SK)).toBe(true);
    app.ws({ type: 'message:new', topicId: TOPIC.id, sessionKey: SK, ...row });
    await settle();
    answerChat!(inFlight());
    const accepted = await sent;
    await settle();
    app.rerender();
    return accepted;
  }

  test('a row from the phone: the thread holds the phone\'s row only, my message waits in the queue', async () => {
    const app = mountBoth();
    await refusedBeside(app, FROM_DESKTOP, { role: 'user', messageId: 'row-phone', content: 'from the phone', clientMessageId: 'phone-key' });
    // Before the fix: [from desktop, empty placeholder, row-phone] and the queue held it too.
    expect(app.rows()).toEqual([{ id: 'row-phone', role: 'user', content: 'from the phone' }]);
    expect(getQueue(SK).map((q) => q.content)).toEqual([FROM_DESKTOP]);
    app.unmount();
  });

  test('once the queue drains, my message is in the thread once, not twice', async () => {
    const app = mountBoth();
    await refusedBeside(app, FROM_DESKTOP, { role: 'user', messageId: 'row-phone', content: 'from the phone', clientMessageId: 'phone-key' });
    // The phone's turn ends: the queue leaves on its close, on a fresh stream.
    sse = drivenSse();
    app.ws({ type: 'turn:state', sessionKey: SK, ...TURN_OPEN, asOf: 2, open: false });
    await settle();
    expect(getQueue(SK)).toHaveLength(0);
    expect(app.chat().isOwnStream(SK)).toBe(true);
    // Before the fix: two «from desktop» bubbles until the end-of-turn reload.
    expect(app.rows().filter((r) => r.role === 'user').map((r) => r.content)).toEqual(['from the phone', FROM_DESKTOP]);
    expect(app.rows().filter((r) => r.role === 'assistant')).toHaveLength(1);
    const asked = new Promise<void>((r) => { historyAsked = r; });
    sse.content(REPLY);
    sse.done();
    await asked;
    releaseHistory!([]);
    await settle();
    app.unmount();
  });

  test('the sub-agent wake\'s row, the race measured on 30/09: same outcome', async () => {
    const app = mountBoth();
    const wake = BESIDE_USER_ROWS()[0]!;
    await refusedBeside(app, FROM_DESKTOP, { role: 'user', messageId: wake.id, content: wake.content, blocks: wake.blocks });
    expect(app.rows()).toEqual([{ id: wake.id, role: 'user', content: wake.content }]);
    expect(app.markedUserRows()).toEqual([wake.id]);
    expect(getQueue(SK).map((q) => q.content)).toEqual([FROM_DESKTOP]);
    app.unmount();
  });

  test('another window\'s row with the same words is not adopted as mine, and survives my refusal', async () => {
    const app = mountBoth();
    await refusedBeside(app, 'ok', { role: 'user', messageId: 'row-w2', content: 'ok', clientMessageId: 'w2-key' });
    // Before the fix: my bubble took row-w2's id, the pane then held «row-w2»
    // and skipped it, and the 409 removed it by its text: rows [].
    expect(app.rows()).toEqual([{ id: 'row-w2', role: 'user', content: 'ok' }]);
    expect(getQueue(SK).map((q) => q.content)).toEqual(['ok']);
    app.unmount();
  });
});

/**
 * A row WITHOUT the key is never this window's echo: every send of a window
 * carries one and the server writes it on the person's row. The rows without
 * one are written by somebody else (`send_chat_message` of another agent, the
 * answer relay), and they may say the very words this window sent.
 */
describe('a keyless user row with the words I sent', () => {
  test('arrives while the reload after [DONE] is in flight, older snapshot: it stays', async () => {
    const app = mountBoth();
    const asked = new Promise<void>((r) => { historyAsked = r; });
    const sent = app.chat().sendMessage(SK, PROMPT);
    await settle();
    app.ws({ type: 'message:new', topicId: TOPIC.id, sessionKey: SK, role: 'user', messageId: 'row-user', content: PROMPT, clientMessageId: sentClientId });
    sse.content(REPLY);
    sse.done();
    await asked;
    await settle();
    app.ws({ type: 'message:new', topicId: TOPIC.id, sessionKey: SK, role: 'user', messageId: 'row-agent', content: PROMPT });
    await settle();
    releaseHistory!(SNAPSHOT_BEFORE_ROW);
    await sent;
    await settle();
    app.rerender();
    // Before the fix: dropped as the echo by its text, gone until the next history load.
    expect(app.rows().map((r) => r.id)).toEqual(['row-user', 'row-reply', 'row-agent']);
    app.unmount();
  });

  test('my own echo never reached this window (a socket that reconnected): my bubble does not take its id', async () => {
    const app = mountBoth();
    const asked = new Promise<void>((r) => { historyAsked = r; });
    const sent = app.chat().sendMessage(SK, PROMPT);
    await settle();
    sse.content(REPLY);
    sse.done();
    await asked;
    await settle();
    app.ws({ type: 'message:new', topicId: TOPIC.id, sessionKey: SK, role: 'user', messageId: 'row-agent', content: PROMPT });
    await settle();
    // Before the fix: my bubble was renamed «row-agent» by its words, so the
    // pane held that id and skipped the row, and the older snapshot lost it.
    expect(app.rows().filter((r) => r.role === 'user').map((r) => r.id)).toContain('row-agent');
    expect(app.rows().filter((r) => r.role === 'user')).toHaveLength(2);
    releaseHistory!(SNAPSHOT_BEFORE_ROW);
    await sent;
    await settle();
    app.rerender();
    expect(app.rows().map((r) => r.id)).toEqual(['row-user', 'row-reply', 'row-agent']);
    app.unmount();
  });
});
