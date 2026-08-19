import { describe, test, expect, beforeEach } from 'bun:test';
import { encodeNotifyTarget, decodeNotifyTarget, openNotifyToken } from './notifyTarget';

/**
 * Il difetto che questi test fissano: il banner partiva con il solo `taskId`,
 * quindi una notifica di CHAT (fine turno, messaggio nuovo, terminale) non
 * aveva bersaglio e il click non apriva la tab della conversazione. Qui si
 * verifica il giro intero: bersaglio → token → di nuovo bersaglio → evento di
 * apertura.
 *
 * Ambiente senza DOM, come nel gemello `openTaskLink.test.ts`: si stubba la
 * finestra minima che il modulo tocca (location, dispatchEvent, history).
 */
type StubWindow = {
  location: { origin: string; href: string; pathname: string; search: string };
  dispatchEvent: (e: { type: string; detail?: unknown }) => boolean;
  history: { pushState: (state: unknown, title: unknown, url: string) => void };
};
const g = globalThis as unknown as { window: StubWindow; CustomEvent: unknown };

const origin = 'https://localhost:3333';

class StubCustomEvent {
  type: string;
  detail: unknown;
  constructor(type: string, opts?: { detail?: unknown }) {
    this.type = type;
    this.detail = opts?.detail;
  }
}

function stubWindow() {
  const events: Array<{ type: string; detail: unknown }> = [];
  const u0 = new URL(`${origin}/`);
  g.window = {
    location: { origin: u0.origin, href: u0.href, pathname: u0.pathname, search: u0.search },
    dispatchEvent: (e) => { events.push({ type: e.type, detail: e.detail }); return true; },
    history: {
      pushState: (_s, _t, url) => {
        const u = new URL(url);
        g.window.location.href = u.href;
        g.window.location.pathname = u.pathname;
        g.window.location.search = u.search;
      },
    },
  };
  g.CustomEvent = StubCustomEvent;
  return events;
}

const TASK_ID = 'b3f1c2d4-0000-4000-8000-abcdefabcdef';
const TOPIC_ID = 'aa11bb22-cc33-4d44-8e55-ff66aa77bb88';

describe('encodeNotifyTarget / decodeNotifyTarget', () => {
  test('un task viaggia come id nudo: i gusci gia installati leggono questo', () => {
    const token = encodeNotifyTarget({ kind: 'task', id: TASK_ID });
    expect(token).toBe(TASK_ID);
    expect(decodeNotifyTarget(token)).toEqual({ kind: 'task', id: TASK_ID });
  });

  test('un topic viaggia con il prefisso e torna topic', () => {
    const token = encodeNotifyTarget({ kind: 'topic', id: TOPIC_ID });
    expect(token).toBe(`topic_${TOPIC_ID}`);
    expect(decodeNotifyTarget(token)).toEqual({ kind: 'topic', id: TOPIC_ID });
  });

  test('nessun bersaglio: niente token, cioe un banner senza click', () => {
    expect(encodeNotifyTarget(null)).toBeNull();
    expect(encodeNotifyTarget(undefined)).toBeNull();
    expect(encodeNotifyTarget({ kind: 'task', id: '' })).toBeNull();
  });

  test('un id con caratteri che il guscio scarterebbe non parte affatto', () => {
    expect(encodeNotifyTarget({ kind: 'task', id: 'id con spazi' })).toBeNull();
    expect(encodeNotifyTarget({ kind: 'topic', id: '../altro' })).toBeNull();
    expect(decodeNotifyTarget('topic_')).toBeNull();
    expect(decodeNotifyTarget('')).toBeNull();
    expect(decodeNotifyTarget(null)).toBeNull();
  });
});

describe('openNotifyToken: il click che torna dal guscio', () => {
  let events: Array<{ type: string; detail: unknown }>;
  beforeEach(() => { events = stubWindow(); });

  test('token di TOPIC: apre la tab della conversazione', () => {
    expect(openNotifyToken(`topic_${TOPIC_ID}`)).toBe(true);
    expect(events.map((e) => e.type)).toEqual(['topics:open-topic']);
    expect(events[0]?.detail).toEqual({ topicId: TOPIC_ID, mode: 'permanent' });
  });

  test('token di TASK: apre la board e il drawer del task', () => {
    expect(openNotifyToken(TASK_ID)).toBe(true);
    expect(events.map((e) => e.type)).toEqual(['topics:open-utility', 'topics:open-task']);
    expect(events[1]?.detail).toEqual({ taskId: TASK_ID });
  });

  test('token vuoto: non apre niente e lo dice', () => {
    expect(openNotifyToken('')).toBe(false);
    expect(events).toHaveLength(0);
  });
});
