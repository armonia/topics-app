/**
 * Concurrency of the ui-state writes for the TASK browser tabs: a local write,
 * an inbound frame from another device and a read in flight can all touch the
 * same record at once. The plain behaviour of the store lives in
 * `taskBrowserTabs.test.ts`; this file is only about who wins.
 * @covers BROWSER-STATE-01
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  liveTabs,
  applyRemoteTaskTabs,
  resyncTaskTabsFromServer,
  forgetTaskTabs,
  getTaskTabs,
  taskBrowserTabs,
  __resetTaskTabs,
} from './taskBrowserTabs';

const uniq = (p: string) => `${p}-${Math.random().toString(36).slice(2)}`;

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
      if (method === 'DELETE') return Promise.resolve(new Response('{}', { status: 200 }));
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
    __resetTaskTabs();
  });

  const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
  const recordOf = (...ctx: string[]) => ({
    tabs: ctx.map((c, i) => ({ contextId: c, url: 'u', title: 'T', seq: i })),
    activeContextId: ctx[0] ?? null,
    nextSeq: ctx.length,
  });
  const liveIds = (taskId: string) => liveTabs(getTaskTabs(taskId)).map((t) => t.contextId);
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
    const tid = uniq('seq-older');
    const key = `task-browser-tabs:${tid}`;
    applyRemoteTaskTabs(tid, recordOf('task-i-0'), 100);
    served.set(key, recordOf('task-i-0'));

    taskBrowserTabs.removeTab(tid, 'task-i-0');   // last tab: PUT with no debounce
    await tick();                                  // PUT committed on the server, answer withheld

    applyRemoteTaskTabs(tid, recordOf('task-i-0', 'task-i-1'), 100);
    expect(liveIds(tid)).toEqual([]);              // held, and it is our own past

    release('PUT');
    await tick();
    expect(liveIds(tid)).toEqual([]);
    expect(onServer(key)).toEqual([]);             // both copies agree
  });

  test('a NEWER frame arriving before our PUT answers is adopted, not lost', async () => {
    const tid = uniq('seq-newer');
    const key = `task-browser-tabs:${tid}`;
    applyRemoteTaskTabs(tid, recordOf('task-n-0'), 100);
    served.set(key, recordOf('task-n-0'));

    taskBrowserTabs.removeTab(tid, 'task-n-0');
    await tick();                                  // the server holds our empty record at seq 101

    served.set(key, recordOf('task-n-1'));         // another device writes AFTER us
    applyRemoteTaskTabs(tid, recordOf('task-n-1'), 102);

    release('PUT');
    await tick();
    expect(liveIds(tid)).toEqual(['task-n-1']);    // the newer write wins
    expect(liveIds(tid)).toEqual(onServer(key));
  });

  test('a resync GET issued before a close does not resurrect the tab', async () => {
    const tid = uniq('seq-read');
    const key = `task-browser-tabs:${tid}`;
    applyRemoteTaskTabs(tid, recordOf('task-r-0'), 100);
    served.set(key, recordOf('task-r-0'));

    const reading = resyncTaskTabsFromServer({});
    await tick();                                  // the GET read one tab, answer withheld
    expect(asked).toContain(key);

    taskBrowserTabs.removeTab(tid, 'task-r-0');
    await tick();
    release('PUT');
    await tick();                                  // our close is persisted

    release('GET');
    await reading;
    await tick();
    expect(liveIds(tid)).toEqual([]);              // the read was overtaken by the write
    expect(onServer(key)).toEqual([]);
  });

  test('a PUT that fails releases the frame it was holding', async () => {
    const tid = uniq('seq-failed');
    applyRemoteTaskTabs(tid, recordOf('task-f-0'), 100);

    taskBrowserTabs.removeTab(tid, 'task-f-0');
    await tick();
    applyRemoteTaskTabs(tid, recordOf('task-f-9'), 105);

    release('PUT', true);
    await tick();
    expect(liveIds(tid)).toEqual(['task-f-9']);    // nothing of ours reached the row
  });

  // The flight protection made the reconnect resync SKIP the key, and nothing
  // ever came back for it: the write settled, the frame another device had sent
  // while the socket was down was gone, and the two copies stayed apart.
  test('a key the resync skipped is re-read when its write settles', async () => {
    const tid = uniq('seq-owed');
    const key = `task-browser-tabs:${tid}`;
    applyRemoteTaskTabs(tid, recordOf('task-o-0'), 100);
    served.set(key, recordOf('task-o-0'));

    taskBrowserTabs.removeTab(tid, 'task-o-0');    // PUT out, answer withheld
    await tick();
    served.set(key, recordOf('task-o-9'));         // device B writes while we are deaf

    await resyncTaskTabsFromServer({});            // reconnect: the key is skipped
    expect(asked).not.toContain(key);

    release('PUT');
    await tick();                                  // the settle owes that read
    release('GET');
    await tick();
    expect(asked).toContain(key);
    expect(liveIds(tid)).toEqual(['task-o-9']);
    expect(liveIds(tid)).toEqual(onServer(key));
  });

  // The owed read is a GET like any other, so it can be overtaken like any other:
  // between the settle that asks for it and its answer, the person can close a
  // tab again. Without the staleness guard on it, the answer (which still has the
  // old row) puts the closed tab back and the resync defect returns through the
  // door opened to fix it.
  test('a read owed to a resync does not resurrect a close committed while it travels', async () => {
    const tid = uniq('seq-owed-stale');
    const key = `task-browser-tabs:${tid}`;
    applyRemoteTaskTabs(tid, recordOf('task-w-0'), 100);
    served.set(key, recordOf('task-w-0'));

    taskBrowserTabs.removeTab(tid, 'task-w-0');
    await tick();
    served.set(key, recordOf('task-w-9'));         // device B writes while we are deaf

    await resyncTaskTabsFromServer({});            // key skipped
    release('PUT');
    await tick();                                  // the owed GET leaves, and will read [task-w-9]
    expect(asked).toContain(key);

    taskBrowserTabs.upsertTab(tid, 'task-w-5', 'u');
    taskBrowserTabs.removeTab(tid, 'task-w-5');    // a close committed meanwhile
    await tick();
    release('PUT');
    await tick();                                  // the server holds our empty record

    release('GET');
    await tick();
    expect(liveIds(tid)).toEqual([]);              // the owed read was overtaken
    expect(onServer(key)).toEqual([]);
  });

  // A read is ordered against OUR writes by the token; nothing ordered it
  // against the OTHER devices, so a GET that left when the row said [b] put [b]
  // back over a [c] that had landed meanwhile, and the copies stayed apart.
  test('an owed read does not undo a newer frame that landed while it travelled', async () => {
    const tid = uniq('read-seq-owed');
    const key = `task-browser-tabs:${tid}`;
    applyRemoteTaskTabs(tid, recordOf('task-ro-0'), 100);
    served.set(key, recordOf('task-ro-0'));

    taskBrowserTabs.removeTab(tid, 'task-ro-0');    // last tab: PUT with no debounce
    await tick();
    const skipped = resyncTaskTabsFromServer({});   // write in the air: the key is owed, not read
    await skipped;
    expect(asked).not.toContain(key);

    served.set(key, recordOf('task-ro-b'));         // another device wrote while we were in flight
    release('PUT');
    await tick();                                    // our write settles: the owed GET reads [b]
    expect(asked).toContain(key);

    applyRemoteTaskTabs(tid, recordOf('task-ro-c'), 103);   // and a third device writes [c]
    served.set(key, recordOf('task-ro-c'));
    expect(liveIds(tid)).toEqual(['task-ro-c']);

    release('GET');
    await tick();
    expect(liveIds(tid)).toEqual(['task-ro-c']);    // the read described a state we had left
    expect(liveIds(tid)).toEqual(onServer(key));
  });

  test('the bulk resync does not undo a newer frame either', async () => {
    const tid = uniq('read-seq-bulk');
    const key = `task-browser-tabs:${tid}`;
    applyRemoteTaskTabs(tid, recordOf('task-rb-0'), 100);
    served.set(key, recordOf('task-rb-0'));

    const reading = resyncTaskTabsFromServer({});
    await tick();                                    // the GET read [task-rb-0] at seq 100
    expect(asked).toContain(key);

    applyRemoteTaskTabs(tid, recordOf('task-rb-c'), 104);
    served.set(key, recordOf('task-rb-c'));

    release('GET');
    await reading;
    await tick();
    expect(liveIds(tid)).toEqual(['task-rb-c']);
    expect(liveIds(tid)).toEqual(onServer(key));
  });

  // A server_seq can go BACKWARDS: a data/topics.db put back from backup, which
  // is the rollback planned before a migration, with the app still open and the
  // socket simply reconnecting. Compared against a high-water mark the key would
  // be wedged -- and these keys are excluded from `ui-state:init`, so the read
  // refused as "old" is the only thing that realigns them.
  test('a seq that went backwards does not wedge a key we never wrote', async () => {
    const tid = uniq('regress-unwritten');
    const key = `task-browser-tabs:${tid}`;
    applyRemoteTaskTabs(tid, recordOf('task-g-a'), 500);
    served.set(key, recordOf('task-g-a'));
    nextSeq = 500;

    served.set(key, recordOf('task-g-old'));       // the row is restored from backup...
    nextSeq = 20;                                   // ...and the counter with it

    const reconnect = resyncTaskTabsFromServer({});
    await settleGets();
    await reconnect;
    expect(liveIds(tid)).toEqual(['task-g-old']);  // the read at seq 20 is believed
    expect(liveIds(tid)).toEqual(onServer(key));

    served.set(key, recordOf('task-g-d'));          // another device writes while we are down
    nextSeq = 499;
    const later = resyncTaskTabsFromServer({});
    await settleGets();
    await later;
    expect(liveIds(tid)).toEqual(onServer(key));    // still realigning, 499 or not
  });

  test('a seq that went backwards does not wedge a key we wrote ourselves', async () => {
    const tid = uniq('regress-written');
    const key = `task-browser-tabs:${tid}`;
    applyRemoteTaskTabs(tid, recordOf('task-h-a', 'task-h-x'), 100);
    served.set(key, recordOf('task-h-a', 'task-h-x'));
    nextSeq = 499;

    taskBrowserTabs.removeTab(tid, 'task-h-x');     // our own write, confirmed at 500
    await tick(900);
    while (held.some((h) => h.method === 'PUT')) { release('PUT'); await tick(); }
    expect(onServer(key)).toEqual(['task-h-a']);

    served.set(key, recordOf('task-h-old'));        // restore from backup
    nextSeq = 20;
    served.set(key, recordOf('task-h-b'));          // and another device writes at 21
    nextSeq = 21;

    const reconnect = resyncTaskTabsFromServer({});
    await settleGets();
    await reconnect;
    expect(liveIds(tid)).toEqual(onServer(key));    // the reconnect read realigns us
  });

  // Two resyncs can overlap (a socket that goes and comes back sends two inits):
  // the older GET answering LAST must not undo what the newer one applied.
  test('an overlapping read answered last does not undo the newer read', async () => {
    const tid = uniq('overlap-reads');
    const key = `task-browser-tabs:${tid}`;
    applyRemoteTaskTabs(tid, recordOf('task-o-a'), 100);
    served.set(key, recordOf('task-o-b'));
    nextSeq = 101;

    const first = resyncTaskTabsFromServer({});
    await tick();                                   // GET1 reads [b] at 101
    served.set(key, recordOf('task-o-c'));          // a write elsewhere, its frame lost
    nextSeq = 102;
    const second = resyncTaskTabsFromServer({});
    await tick();                                   // GET2 reads [c] at 102

    releaseNth('GET', 1);
    await second;
    await tick();
    expect(liveIds(tid)).toEqual(['task-o-c']);

    releaseNth('GET', 0);
    await first;
    await tick();
    expect(liveIds(tid)).toEqual(['task-o-c']);     // GET1 described a state already left
    expect(liveIds(tid)).toEqual(onServer(key));
  });

  // `confirmedSeq` is the one per-key maximum left in the arbitration, and a
  // maximum outlives the counter that produced it: after a rollback of the DB
  // every frame from the other devices reads as our own past and is dropped,
  // for as many writes as the rollback threw away.
  test('a seq that went backwards does not make us drop the other devices', async () => {
    const tid = uniq('rollback-frames');
    const key = `task-browser-tabs:${tid}`;
    applyRemoteTaskTabs(tid, recordOf('task-r-old', 'task-r-x'), 100);
    served.set(key, recordOf('task-r-old', 'task-r-x'));
    nextSeq = 499;

    taskBrowserTabs.removeTab(tid, 'task-r-x');    // our write, confirmed at 500
    await tick(900);
    while (held.some((h) => h.method === 'PUT')) { release('PUT'); await tick(); }

    served.set(key, recordOf('task-r-old'));        // rollback: row and counter
    nextSeq = 20;
    const reconnect = resyncTaskTabsFromServer({});
    await settleGets();
    await reconnect;
    expect(liveIds(tid)).toEqual(onServer(key));

    served.set(key, recordOf('task-r-old', 'task-r-b'));   // another device writes at 21
    nextSeq = 21;
    applyRemoteTaskTabs(tid, recordOf('task-r-old', 'task-r-b'), 21);
    expect(liveIds(tid)).toEqual(onServer(key));    // not "our past": the counter restarted
  });

  test('a frame dropped after a rollback is not overwritten by our next edit', async () => {
    const tid = uniq('rollback-commit');
    const key = `task-browser-tabs:${tid}`;
    applyRemoteTaskTabs(tid, recordOf('task-s-old', 'task-s-x'), 100);
    served.set(key, recordOf('task-s-old', 'task-s-x'));
    nextSeq = 499;

    taskBrowserTabs.removeTab(tid, 'task-s-x');
    await tick(900);
    while (held.some((h) => h.method === 'PUT')) { release('PUT'); await tick(); }

    served.set(key, recordOf('task-s-old'));
    nextSeq = 20;
    const reconnect = resyncTaskTabsFromServer({});
    await settleGets();
    await reconnect;

    served.set(key, recordOf('task-s-old', 'task-s-b'));   // another device opens a tab
    nextSeq = 21;
    applyRemoteTaskTabs(tid, recordOf('task-s-old', 'task-s-b'), 21);

    taskBrowserTabs.upsertTab(tid, 'task-s-mine', 'u');    // and we open ours
    await tick(900);
    while (held.some((h) => h.method === 'PUT')) { release('PUT'); await tick(); }
    expect(onServer(key)).toContain('task-s-b');           // our commit did not erase theirs
  });

  // A record forgotten because its task was archived must not be resurrected by
  // a GET issued before the archiving: the deletion is an applied value too.
  test('a read answered after the task was forgotten does not resurrect it', async () => {
    const tid = uniq('forget-during-read');
    const key = `task-browser-tabs:${tid}`;
    applyRemoteTaskTabs(tid, recordOf('task-t-a'), 100);
    served.set(key, recordOf('task-t-c'));
    nextSeq = 102;

    const reading = resyncTaskTabsFromServer({});
    await tick();                                   // the GET reads [c] at 102

    served.delete(key);                             // archived elsewhere: row gone
    forgetTaskTabs(tid);
    release('GET');
    await reading;
    await tick();
    expect(liveIds(tid)).toEqual([]);

    const reopened = taskBrowserTabs.ensureLoaded(tid);   // unarchived and reopened
    await settleGets();
    await reopened;
    expect(liveIds(tid)).toEqual([]);                // and it stays gone
  });
});
