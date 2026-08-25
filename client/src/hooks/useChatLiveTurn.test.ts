/**
 * THE NAME OF THE BUBBLE A TURN IS WRITING, driven through the REAL hook.
 *
 * Everything here goes through `useChat()` mounted on the hook harness
 * (`client/src/test/reactHarness.ts`) and through the real WS entry point
 * (`onWSMessage`). That is deliberate: the two defects this file exists for are
 * WIRING defects. A pure module can be perfect and the page still broken if the
 * hook forgets to call it on one of the paths where a turn dies, and that is
 * exactly what happened.
 *
 *  - The in-flight id was deleted on `stream:end` and `stream:error` only. A turn
 *    killed by the watchdog, by the orphan-stream reconciler or by the user's
 *    stop button left its name behind, and the NEXT answer was written into the
 *    dead bubble above the user's message while the fresh placeholder stayed
 *    empty forever.
 *  - Once the placeholder started carrying the durable id, the id dedupe in
 *    `addMessage` matched it and returned early, so a window that never receives
 *    the content chunks (its `openTopicIds` does not list the topic) kept an
 *    EMPTY bubble: the closing persisted row was its only chance to be filled.
 *
 * @covers CHAT-01, SUBAGENT-07
 */
import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { mount } from '../test/reactHarness';
import { useChat } from './useChat';
import type { WSMessage } from '../types';

/** localStorage stand-in: bun:test runs without a DOM. */
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
// Merge into whatever window a sibling test file already installed instead of
// replacing it: in this repo a fake window is process-wide, and overwriting one
// that another module captured is how a subset of the suite goes red on its own.
const w = (g.window as Record<string, unknown> | undefined) ?? {};
w.localStorage ??= new MemStorage();
w.addEventListener ??= () => {};
w.removeEventListener ??= () => {};
w.dispatchEvent ??= () => true;
g.window = w;

// The delta buffer is flushed on an animation frame. A queue the test drains by
// hand is the only way to keep the assertions deterministic.
const frames = new Map<number, () => void>();
let frameSeq = 0;
g.requestAnimationFrame = (cb: () => void) => { frames.set(++frameSeq, cb); return frameSeq; };
g.cancelAnimationFrame = (id: number) => { frames.delete(id); };
function flushFrames(): void {
  const queued = [...frames.values()];
  frames.clear();
  for (const cb of queued) cb();
}

type Chat = ReturnType<typeof useChat>;

interface Driver {
  chat: Chat;
  /** A WS frame for this session, as the socket would deliver it. */
  ws(frame: Record<string, unknown>): void;
  /** Text of every message of the session, in order. */
  texts(): string[];
  ids(): string[];
  unmount(): void;
}

let seq = 0;

function drive(): Driver {
  const sessionKey = `topic:test-${++seq}`;
  // The harness has no `result.current`, so the hook publishes itself through a
  // ref-shaped box. A plain outer variable would be an assignment during render,
  // which the react-hooks lint refuses (rightly: here it is a test probe).
  const box: { current: Chat | null } = { current: null };
  function Probe(): null {
    const live = useChat();
    React.useEffect(() => { box.current = live; });
    return null;
  }
  const harness = mount(React.createElement(Probe));
  const api = (): Chat => {
    if (!box.current) throw new Error('useChat did not mount');
    return box.current;
  };
  return {
    get chat() { return api(); },
    ws(frame) {
      api().onWSMessage({ sessionKey, ...frame } as unknown as WSMessage);
      flushFrames();
      harness.rerender();
    },
    texts: () => api().getSessionMessages(sessionKey).map((m) => m.content ?? ''),
    ids: () => api().getSessionMessages(sessionKey).map((m) => m.id),
    unmount: () => harness.unmount(),
  };
}

/** The session key the LAST `drive()` handed to the hook, for direct calls. */
function keyOf(): string {
  return `topic:test-${seq}`;
}

const LIVE = 'a1b2c3d4-0000-4000-8000-000000000001';
const PRIMA = 'Ho aperto la pratica.';
const DOPO = ' Il risultato conferma.';

describe('un turno morto non si prende la risposta successiva', () => {
  test('lo stream dichiarato orfano dimentica il nome della sua bolla', () => {
    const d = drive();
    const sk = keyOf();

    // Another window drives the turn: this one only watches it over the socket.
    d.ws({ type: 'stream:start', messageId: LIVE });
    d.ws({ type: 'stream:content_chunk', content: PRIMA });
    expect(d.texts()).toEqual([PRIMA]);

    // The turn dies WITHOUT stream:end (server restart, dropped socket). The
    // reconciler needs two consecutive polls with the session absent before it
    // declares the flag orphaned, which is the real production condition.
    d.chat.reconcileServerStreams(new Set<string>());
    d.chat.reconcileServerStreams(new Set<string>());

    // The user now sends from this window: a user row plus a fresh placeholder
    // minted locally, which is what performSend puts on screen.
    d.chat.addMessageFromWS(sk, { role: 'user', content: 'e allora?', timestamp: new Date().toISOString() });
    d.chat.addMessageFromWS(sk, { role: 'assistant', content: '', timestamp: new Date().toISOString(), partial: true });
    d.ws({ type: 'stream:content_chunk', content: DOPO });

    // The dead bubble is untouched and the answer is in the fresh one. Before
    // the fix the ref still held LIVE, so `liveAssistantIndex` found the corpse
    // at index 0 and wrote there: ['Ho aperto la pratica. Il risultato…', …, ''].
    expect(d.texts()).toEqual([PRIMA, 'e allora?', DOPO]);
    d.unmount();
  });

  test('il watchdog dei 3 minuti dimentica il nome della sua bolla', async () => {
    // The watchdog is a plain `setTimeout`, so the only way to make it fire in a
    // test is to hold the timers instead of the clock. Scoped to this test and
    // restored in `finally`: a process-wide fake setTimeout would be inherited
    // by every file that runs after this one.
    const armed = new Map<number, { cb: () => void; ms: number }>();
    let timerSeq = 0;
    const savedSetTimeout = g.setTimeout;
    const savedClearTimeout = g.clearTimeout;
    const savedFetch = g.fetch;
    g.setTimeout = (cb: () => void, ms?: number) => { armed.set(++timerSeq, { cb, ms: ms ?? 0 }); return timerSeq; };
    g.clearTimeout = (id: number) => { armed.delete(id); };
    // The watchdog does not trust silence: it asks the server, and only a server
    // that does NOT list the session declares the turn dead.
    g.fetch = async () => new Response(JSON.stringify({ sessions: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    try {
      const d = drive();
      const sk = keyOf();
      d.ws({ type: 'stream:start', messageId: LIVE });
      d.ws({ type: 'stream:content_chunk', content: PRIMA });

      // STREAM_TIMEOUT_MS is not exported; the delay is the identity of the
      // watchdog among the timers this turn armed.
      const watchdog = [...armed.values()].filter((t) => t.ms === 3 * 60 * 1000).pop();
      expect(watchdog, 'lo stream deve armare il watchdog').toBeDefined();
      watchdog!.cb();
      // Let the async probe of /api/topics/streaming settle.
      for (let i = 0; i < 8; i++) await Promise.resolve();

      d.chat.addMessageFromWS(sk, { role: 'user', content: 'ci sei?', timestamp: new Date().toISOString() });
      d.chat.addMessageFromWS(sk, { role: 'assistant', content: '', timestamp: new Date().toISOString(), partial: true });
      d.ws({ type: 'stream:content_chunk', content: DOPO });

      expect(d.texts()).toEqual([PRIMA, 'ci sei?', DOPO]);
      d.unmount();
    } finally {
      g.setTimeout = savedSetTimeout;
      g.clearTimeout = savedClearTimeout;
      g.fetch = savedFetch;
    }
  });

  test('lo stop dell\'utente dimentica il nome della sua bolla', async () => {
    const savedFetch = g.fetch;
    g.fetch = async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    try {
      const d = drive();
      const sk = keyOf();
      d.ws({ type: 'stream:start', messageId: LIVE });
      d.ws({ type: 'stream:content_chunk', content: PRIMA });

      await d.chat.stopSession(sk);
      flushFrames();

      // Stop finalises the live bubble (partial cleared) and then forgets it.
      expect(d.chat.getSessionMessages(sk)[0].partial).toBeFalsy();

      d.chat.addMessageFromWS(sk, { role: 'user', content: 'riprova', timestamp: new Date().toISOString() });
      d.chat.addMessageFromWS(sk, { role: 'assistant', content: '', timestamp: new Date().toISOString(), partial: true });
      d.ws({ type: 'stream:content_chunk', content: DOPO });

      expect(d.texts()).toEqual([PRIMA, 'riprova', DOPO]);
      d.unmount();
    } finally {
      g.fetch = savedFetch;
    }
  });
});

describe('svuotare o sfrattare una sessione dimentica il nome', () => {
  test('dopo un clear il nome vecchio non guida più le delta', () => {
    const d = drive();
    const sk = keyOf();
    d.ws({ type: 'stream:start', messageId: LIVE });
    d.ws({ type: 'stream:content_chunk', content: PRIMA });

    // `clearSession` passa da `forgetSessionCaches`, la stessa porta che usa lo
    // spazzino della residenza quando sfratta un trascritto.
    d.chat.clearSession(sk);
    expect(d.texts()).toEqual([]);

    // La sessione si ripopola (rilettura della storia) e fra le righe c'è anche
    // quella di prima, con il suo id.
    d.chat.addMessageFromWS(sk, { id: LIVE, role: 'assistant', content: PRIMA, timestamp: new Date().toISOString() });
    d.chat.addMessageFromWS(sk, { role: 'user', content: 'di nuovo', timestamp: new Date().toISOString() });
    d.chat.addMessageFromWS(sk, { role: 'assistant', content: '', timestamp: new Date().toISOString(), partial: true });
    d.ws({ type: 'stream:content_chunk', content: DOPO });

    expect(d.texts()).toEqual([PRIMA, 'di nuovo', DOPO]);
    d.unmount();
  });
});

describe('la riga persistita riempie la bolla rimasta vuota', () => {
  test('una finestra senza delta riceve il testo dal message:new di chiusura', () => {
    const d = drive();
    const sk = keyOf();

    // No content chunks at all: this window is not subscribed to the topic, so
    // `broadcastToTopicSubscribers` never reaches it.
    d.ws({ type: 'stream:start', messageId: LIVE });
    expect(d.texts()).toEqual(['']);

    d.chat.addMessageFromWS(sk, {
      id: LIVE,
      role: 'assistant',
      content: PRIMA + DOPO,
      timestamp: new Date().toISOString(),
    });

    // One bubble, filled. Before the fix the id dedupe matched and returned, so
    // this stayed [''] until the next loadHistory.
    expect(d.texts()).toEqual([PRIMA + DOPO]);
    expect(d.ids()).toEqual([LIVE]);
    expect(d.chat.getSessionMessages(sk)[0].partial).toBeFalsy();
    d.unmount();
  });

  test('una anteprima TRONCATA non accorcia quello che abbiamo già', () => {
    const d = drive();
    const sk = keyOf();
    d.ws({ type: 'stream:start', messageId: LIVE });
    d.ws({ type: 'stream:content_chunk', content: PRIMA + DOPO });

    // `message:new` carries `preview` when the row is long: filling with it
    // would REPLACE the full streamed text with its own first line.
    d.chat.addMessageFromWS(sk, {
      id: LIVE,
      role: 'assistant',
      content: PRIMA,
      timestamp: new Date().toISOString(),
    });

    expect(d.texts()).toEqual([PRIMA + DOPO]);
    d.unmount();
  });

  test('la riga di un sotto-agente resta una bolla sua', () => {
    const d = drive();
    const sk = keyOf();
    const REPORT = 'c0ffee00-1111-4222-8333-444455556666';
    d.ws({ type: 'stream:start', messageId: LIVE });
    d.ws({ type: 'stream:content_chunk', content: PRIMA });

    d.chat.addMessageFromWS(sk, {
      id: REPORT,
      role: 'assistant',
      content: 'sotto-agente completato',
      timestamp: new Date().toISOString(),
    });
    d.ws({ type: 'stream:content_chunk', content: DOPO });

    // Two bubbles, and the rest of the turn went back into the turn's own.
    expect(d.texts()).toEqual([PRIMA + DOPO, 'sotto-agente completato']);
    expect(d.ids()).toEqual([LIVE, REPORT]);
    d.unmount();
  });

  test('il segnaposto porta l\'id annunciato, quindi la riga uguale non si sdoppia', () => {
    const d = drive();
    const sk = keyOf();
    d.ws({ type: 'stream:start', messageId: LIVE });
    d.ws({ type: 'stream:content_chunk', content: PRIMA });
    expect(d.ids()).toEqual([LIVE]);

    // Exactly what a mid-turn history reload replays: the same row, same id.
    d.chat.addMessageFromWS(sk, {
      id: LIVE,
      role: 'assistant',
      content: PRIMA,
      timestamp: new Date().toISOString(),
    });
    expect(d.ids()).toEqual([LIVE]);
    expect(d.texts()).toEqual([PRIMA]);
    d.unmount();
  });
});

/**
 * LA DOMANDA CHE COMPARIVA DUE VOLTE.
 *
 * La finestra da cui parte il messaggio lo disegna subito con un id coniato in
 * locale; il `message:new` che porta l'id del DB veniva scartato in blocco come
 * «roba mia», quindi quel nome provvisorio restava per sempre. Al primo
 * ricarico della storia (una riconnessione basta, e nella notte fra il 18 e il
 * 19/08 la socket cadeva di continuo) la riga del server arrivava sotto il suo
 * nome vero, il segnaposto non veniva riconosciuto e finiva in coda: la domanda
 * a schermo due volte, e con essa l'impressione di due risposte.
 */
describe('la copia ottimistica prende il nome vero', () => {
  const SRV_U1 = 'b1b2c3d4-0000-4000-8000-000000000011';
  const SRV_U2 = 'b1b2c3d4-0000-4000-8000-000000000012';

  test('il message:new della PROPRIA finestra ribattezza la bolla invece di aggiungerne una', () => {
    const d = drive();
    const sk = keyOf();
    // Quello che fa `performSend`: la bolla utente con un id locale.
    d.chat.addMessageFromWS(sk, { role: 'user', content: 'beeper', timestamp: new Date().toISOString() });
    expect(d.ids()[0].startsWith('msg_')).toBe(true);

    d.ws({ type: 'message:new', role: 'user', messageId: SRV_U1, content: 'beeper' });

    expect(d.ids()).toEqual([SRV_U1]);
    expect(d.texts()).toEqual(['beeper']);
    d.unmount();
  });

  test('la stessa riga annunciata due volte resta una riga sola', () => {
    const d = drive();
    const sk = keyOf();
    d.chat.addMessageFromWS(sk, { role: 'user', content: 'beeper', timestamp: new Date().toISOString() });
    d.ws({ type: 'message:new', role: 'user', messageId: SRV_U1, content: 'beeper' });
    d.ws({ type: 'message:new', role: 'user', messageId: SRV_U1, content: 'beeper' });
    d.chat.addMessageFromWS(sk, { id: SRV_U1, role: 'user', content: 'beeper', timestamp: new Date().toISOString() });

    expect(d.ids()).toEqual([SRV_U1]);
    d.unmount();
  });

  test('due messaggi con id DIVERSI e lo stesso testo restano due', () => {
    const d = drive();
    const sk = keyOf();
    d.chat.addMessageFromWS(sk, { role: 'user', content: 'beeper', timestamp: new Date().toISOString() });
    d.ws({ type: 'message:new', role: 'user', messageId: SRV_U1, content: 'beeper' });
    // La stessa domanda, mandata di nuovo: è legittimo, e nasconderne una
    // sarebbe un difetto peggiore di mostrarla due volte.
    d.chat.addMessageFromWS(sk, { role: 'user', content: 'beeper', timestamp: new Date().toISOString() });
    d.ws({ type: 'message:new', role: 'user', messageId: SRV_U2, content: 'beeper' });

    expect(d.ids()).toEqual([SRV_U1, SRV_U2]);
    expect(d.texts()).toEqual(['beeper', 'beeper']);
    d.unmount();
  });
});
