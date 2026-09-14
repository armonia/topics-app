/**
 * Concurrency of the ui-state writes for the TOPIC browser window: a local write,
 * an inbound frame from another device and a read in flight can all touch the
 * same record at once. The plain behaviour of the store lives in
 * `topicBrowserWindow.test.ts`; this file is only about who wins.
 * @covers TOPIC-BROWSER-01
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  EMPTY_TOPIC_BROWSER_WINDOW,
  applyRemoteTopicWindow,
  applyTopicWindowFrame,
  ensureTopicWindowLoaded,
  reloadTopicWindowsFromServer,
  getTopicWindow,
  forgetTopicWindow,
  topicBrowserWindow,
  __resetTopicWindows,
} from './topicBrowserWindow';

let seq = 0;
const uniqueId = (tag: string) => `topic-${tag}-${seq++}`;

describe('a write in flight is arbitrated by server_seq, not by a flag', () => {
  const REAL_FETCH = globalThis.fetch;
  let served: Map<string, unknown>;
  let held: { method: string; key: string; release: (fail?: boolean) => void }[];
  let nextSeq: number;
  let asked: string[];

  beforeEach(() => {
    served = new Map();
    held = [];
    asked = [];
    nextSeq = 100;
    // A server that COMMITS on arrival (and would broadcast there) but hands the
    // answer over only when the test releases it: that gap is the race.
    (globalThis as unknown as { fetch: unknown }).fetch = (url: string, init?: RequestInit): Promise<Response> => {
      const key = decodeURIComponent(String(url).replace('/api/ui-state/', ''));
      const method = init?.method ?? 'GET';
      let body: string;
      if (method === 'PUT') {
        served.set(key, JSON.parse(String(init!.body)));
        body = JSON.stringify({ ok: true, server_seq: ++nextSeq });
      } else {
        asked.push(key);
        const value = served.get(key);
        body = JSON.stringify(value === undefined ? null : { value, server_seq: nextSeq });
      }
      return new Promise<Response>((resolve, reject) => {
        held.push({
          method,
          key,
          release: (fail) => (fail
            ? reject(new TypeError('network'))
            : resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }))),
        });
      });
    };
  });
  afterEach(() => {
    (globalThis as unknown as { fetch: unknown }).fetch = REAL_FETCH;
    __resetTopicWindows();
  });

  const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
  const window = (...contextIds: string[]) => ({
    mode: 'min',
    tabs: contextIds.map((contextId) => ({ contextId, url: 'u', title: 'T', openedBy: 'user' })),
    activeContextId: contextIds[0] ?? null,
    promoted: [],
    minPos: null,
    expandedWidth: null,
  });
  const ids = (topicId: string) => getTopicWindow(topicId).tabs.map((t) => t.contextId);
  const onServer = (key: string) => ((served.get(key) as { tabs: { contextId: string }[] }).tabs).map((t) => t.contextId);
  const release = (method: string, fail?: boolean) => {
    const entry = held.find((h) => h.method === method)!;
    held = held.filter((h) => h !== entry);
    entry.release(fail);
  };
  /** Release the n-th withheld GET: two resyncs can overlap and answer out of order. */
  const releaseNth = (method: string, i: number) => {
    const entry = held.filter((h) => h.method === method)[i]!;
    held = held.filter((h) => h !== entry);
    entry.release();
  };
  const settleGets = async () => {
    await tick();
    while (held.some((h) => h.method === 'GET')) { release('GET'); await tick(); }
  };

  test('an OLDER frame arriving while our PUT travels is dropped', async () => {
    const tid = uniqueId('seq-older');
    const key = `topic-browser:${tid}`;
    applyRemoteTopicWindow(tid, window('a'), 100);
    served.set(key, window('a'));

    topicBrowserWindow.close(tid, 'a');    // last sheet: PUT with no debounce
    await tick();                           // PUT committed on the server, answer withheld

    applyTopicWindowFrame({ key, value: window('a', 'b'), sourceClientId: 'device-b', server_seq: 100 });
    expect(ids(tid)).toEqual([]);           // held, and it is our own past

    release('PUT');
    await tick();
    expect(ids(tid)).toEqual([]);
    expect(onServer(key)).toEqual([]);      // both copies agree
  });

  test('a NEWER frame arriving before our PUT answers is adopted, not lost', async () => {
    const tid = uniqueId('seq-newer');
    const key = `topic-browser:${tid}`;
    applyRemoteTopicWindow(tid, window('a'), 100);
    served.set(key, window('a'));

    topicBrowserWindow.close(tid, 'a');
    await tick();                           // the server holds our [] at seq 101

    served.set(key, window('b'));           // another device writes AFTER us
    applyTopicWindowFrame({ key, value: window('b'), sourceClientId: 'device-b', server_seq: 102 });

    release('PUT');
    await tick();
    expect(ids(tid)).toEqual(['b']);        // the newer write wins
    expect(ids(tid)).toEqual(onServer(key));
  });

  test('a resync GET issued before a close does not resurrect the sheet', async () => {
    const tid = uniqueId('seq-read');
    const key = `topic-browser:${tid}`;
    applyRemoteTopicWindow(tid, window('a'), 100);
    served.set(key, window('a'));

    const reading = reloadTopicWindowsFromServer({});
    await tick();                           // the GET read ['a'], answer withheld
    expect(asked).toContain(key);

    topicBrowserWindow.close(tid, 'a');
    await tick();
    release('PUT');
    await tick();                           // our close is persisted

    release('GET');
    await reading;
    await tick();
    expect(ids(tid)).toEqual([]);           // the read was overtaken by the write
    expect(onServer(key)).toEqual([]);
  });

  test('a PUT that fails releases the frame it was holding', async () => {
    const tid = uniqueId('seq-failed');
    const key = `topic-browser:${tid}`;
    applyRemoteTopicWindow(tid, window('a'), 100);

    topicBrowserWindow.close(tid, 'a');
    await tick();
    applyTopicWindowFrame({ key, value: window('z'), sourceClientId: 'device-b', server_seq: 105 });

    release('PUT', true);
    await tick();
    expect(ids(tid)).toEqual(['z']);        // nothing of ours reached the row
  });

  // The flight protection made the reconnect resync SKIP the key, and nothing
  // ever came back for it: the write settled, the frame another device had sent
  // while the socket was down was gone, and the two copies stayed apart.
  test('a key the resync skipped is re-read when its write settles', async () => {
    const tid = uniqueId('seq-owed');
    const key = `topic-browser:${tid}`;
    applyRemoteTopicWindow(tid, window('a'), 100);
    served.set(key, window('a'));

    topicBrowserWindow.close(tid, 'a');     // PUT out, answer withheld
    await tick();
    served.set(key, window('z'));           // device B writes while we are deaf

    await reloadTopicWindowsFromServer({}); // reconnect: the key is skipped
    expect(asked).not.toContain(key);

    release('PUT');
    await tick();                           // the settle owes that read
    release('GET');
    await tick();
    expect(asked).toContain(key);
    expect(ids(tid)).toEqual(['z']);
    expect(ids(tid)).toEqual(onServer(key));
  });

  // The owed read is a GET like any other, so it can be overtaken like any other:
  // between the settle that asks for it and its answer, the person can close the
  // window again. Without the staleness guard on it, the answer (which still has
  // the old row) puts the closed sheet back and the resync defect returns through
  // the door opened to fix it.
  test('a read owed to a resync does not resurrect a close committed while it travels', async () => {
    const tid = uniqueId('seq-owed-stale');
    const key = `topic-browser:${tid}`;
    applyRemoteTopicWindow(tid, window('a'), 100);
    served.set(key, window('a'));

    topicBrowserWindow.close(tid, 'a');
    await tick();
    served.set(key, window('z'));           // device B writes while we are deaf

    await reloadTopicWindowsFromServer({}); // key skipped
    release('PUT');
    await tick();                           // the owed GET leaves, and will read ['z']
    expect(asked).toContain(key);

    topicBrowserWindow.open(tid, { contextId: 'c' });
    topicBrowserWindow.close(tid, 'c');     // a close committed meanwhile
    await tick();
    release('PUT');
    await tick();                           // the server holds our empty row

    release('GET');
    await tick();
    expect(ids(tid)).toEqual([]);           // the owed read was overtaken
    expect(onServer(key)).toEqual([]);
  });

  // A row the server no longer has (the topic was archived elsewhere) has to DROP
  // the cached window, exactly as the bulk resync does: adopting `null` as a value
  // would throw, and ignoring it would keep a window the server has forgotten.
  test('an owed read that finds no row drops the cached window', async () => {
    const tid = uniqueId('seq-owed-gone');
    const key = `topic-browser:${tid}`;
    applyRemoteTopicWindow(tid, window('a', 'b'), 100);
    served.set(key, window('a', 'b'));

    topicBrowserWindow.close(tid, 'b');     // a sheet stays open, so the cache is not empty
    await new Promise((r) => setTimeout(r, 850)); // a row still holding sheets is debounced
    expect(ids(tid)).toEqual(['a']);
    served.delete(key);                     // purged server-side while we were deaf

    await reloadTopicWindowsFromServer({});
    release('PUT');
    await tick();
    release('GET');
    await tick();
    expect(getTopicWindow(tid)).toEqual(EMPTY_TOPIC_BROWSER_WINDOW);
  });

  // A read is ordered against OUR writes by the token; nothing ordered it
  // against the OTHER devices, so a GET that left when the row said [b] put [b]
  // back over a [c] that had landed meanwhile, and the copies stayed apart.
  test('an owed read does not undo a newer frame that landed while it travelled', async () => {
    const tid = uniqueId('read-seq-owed');
    const key = `topic-browser:${tid}`;
    applyRemoteTopicWindow(tid, window('a'), 100);
    served.set(key, window('a'));

    topicBrowserWindow.close(tid, 'a');      // last sheet: PUT with no debounce
    await tick();
    const skipped = reloadTopicWindowsFromServer({});   // write in the air: owed, not read
    await skipped;
    expect(asked).not.toContain(key);

    served.set(key, window('b'));            // another device wrote while we were in flight
    release('PUT');
    await tick();                             // our write settles: the owed GET reads [b]
    expect(asked).toContain(key);

    applyTopicWindowFrame({ key, value: window('c'), sourceClientId: 'device-c', server_seq: 103 });
    served.set(key, window('c'));
    expect(ids(tid)).toEqual(['c']);

    release('GET');
    await tick();
    expect(ids(tid)).toEqual(['c']);         // the read described a state we had left
    expect(ids(tid)).toEqual(onServer(key));
  });

  test('the bulk resync does not undo a newer frame either', async () => {
    const tid = uniqueId('read-seq-bulk');
    const key = `topic-browser:${tid}`;
    applyRemoteTopicWindow(tid, window('a'), 100);
    served.set(key, window('a'));

    const reading = reloadTopicWindowsFromServer({});
    await tick();                             // the GET read ['a'] at seq 100
    expect(asked).toContain(key);

    applyTopicWindowFrame({ key, value: window('c'), sourceClientId: 'device-c', server_seq: 104 });
    served.set(key, window('c'));

    release('GET');
    await reading;
    await tick();
    expect(ids(tid)).toEqual(['c']);
    expect(ids(tid)).toEqual(onServer(key));
  });

  // A server_seq can go BACKWARDS: a data/topics.db put back from backup, the
  // rollback planned before a migration, with the app open. Against a high-water
  // mark the key would be wedged, and `ui-state:init` does not carry these keys,
  // so the refused read is the only thing that would have realigned it.
  test('a seq that went backwards does not wedge the key', async () => {
    const tid = uniqueId('regress');
    const key = `topic-browser:${tid}`;
    applyRemoteTopicWindow(tid, window('a'), 500);
    served.set(key, window('a'));
    nextSeq = 500;

    served.set(key, window('old'));           // row restored from backup...
    nextSeq = 20;                              // ...and the counter with it

    const reconnect = reloadTopicWindowsFromServer({});
    await settleGets();
    await reconnect;
    expect(ids(tid)).toEqual(['old']);
    expect(ids(tid)).toEqual(onServer(key));

    served.set(key, window('d'));              // another device writes while we are down
    nextSeq = 499;
    const later = reloadTopicWindowsFromServer({});
    await settleGets();
    await later;
    expect(ids(tid)).toEqual(onServer(key));
  });

  // A topic whose browser was never opened has NO row, and the server answers a
  // missing row with a literal `null`: no envelope, so no seq of its own. A read
  // like that answering late must not erase a window another device just made.
  test('a null read answered after a frame created the window does not erase it', async () => {
    const tid = uniqueId('null-read');
    const key = `topic-browser:${tid}`;
    const hydrate = ensureTopicWindowLoaded(tid);
    await tick();
    release('GET');
    await hydrate;
    await tick();                              // loaded, and the server holds no row

    const reading = reloadTopicWindowsFromServer({});
    await tick();                              // this GET will answer `null`

    served.set(key, window('c'));              // another device opens a sheet meanwhile
    applyTopicWindowFrame({ key, value: window('c'), sourceClientId: 'device-c', server_seq: ++nextSeq });
    expect(ids(tid)).toEqual(['c']);

    release('GET');
    await reading;
    await tick();
    expect(ids(tid)).toEqual(['c']);           // the `null` is older than the frame
    expect(ids(tid)).toEqual(onServer(key));
  });

  // A window forgotten because its topic was archived must not be resurrected
  // by a GET issued before the archiving: a deletion is an applied value too.
  test('a read answered after the topic was forgotten does not resurrect it', async () => {
    const tid = uniqueId('forget-during-read');
    const key = `topic-browser:${tid}`;
    applyRemoteTopicWindow(tid, window('a'), 100);
    served.set(key, window('c'));
    nextSeq = 102;

    const reading = reloadTopicWindowsFromServer({});
    await tick();                                  // the GET reads [c] at 102

    served.delete(key);                            // archived elsewhere: row gone
    forgetTopicWindow(tid);
    release('GET');
    await reading;
    await tick();
    expect(ids(tid)).toEqual([]);

    const reopened = ensureTopicWindowLoaded(tid);  // unarchived and reopened
    await settleGets();
    await reopened;
    expect(ids(tid)).toEqual([]);                   // and it stays gone
  });

  // Two resyncs overlap: the newer one reads the deleted row and answers first,
  // the older one still carries the value and answers last.
  test('an older read answered last does not undo a deletion the newer one applied', async () => {
    const tid = uniqueId('overlap-null');
    const key = `topic-browser:${tid}`;
    applyRemoteTopicWindow(tid, window('a'), 100);
    served.set(key, window('c'));
    nextSeq = 102;

    const first = reloadTopicWindowsFromServer({});
    await tick();                                  // GET1 reads [c] at 102
    served.delete(key);                            // the row is deleted
    const second = reloadTopicWindowsFromServer({});
    await tick();                                  // GET2 reads `null`

    releaseNth('GET', 1);
    await second;
    await tick();
    expect(ids(tid)).toEqual([]);

    releaseNth('GET', 0);
    await first;
    await tick();
    expect(ids(tid)).toEqual([]);                  // GET1 describes a state we left
  });
});
