/**
 * The topics map in two halves, and the two caches that follow them.
 *
 * What is load-bearing here is IDENTITY: `persistBuckets` decides "did the
 * archive change" by `!==` on the bucket object, so every operation must keep
 * the object of a half it did not touch. A rename of a live chat that minted a
 * new archived bucket would rewrite 1,535 rows into the localStorage journal
 * for nothing - the exact cost this split exists to remove.
 *
 * @covers TOPIC-01
 * @covers STORAGE-WAL-01
 */
import { describe, expect, test } from 'bun:test';
import type { Topic } from '../types';
import { createThrottledLocalWriter, type WriterStorage } from '../lib/throttledLocalWrite';
import {
  ARCHIVED_CACHE_KEY,
  LIVE_CACHE_KEY,
  emptyBuckets,
  mergeBuckets,
  persistBuckets,
  readTopicCaches,
  replaceArchived,
  replaceLive,
  splitByArchived,
  toListShape,
  upsertTopics,
  vanishedFrom,
} from './topicBuckets';

function topic(id: string, archived: boolean, extra: Partial<Topic> = {}): Topic {
  return {
    id,
    name: `topic ${id}`,
    slug: id,
    parentId: null,
    links: [],
    sessionKey: `topic:${id}`,
    color: 'blue',
    icon: 'chat',
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
    archived,
    ...extra,
  };
}

function buckets(live: Topic[], archived: Topic[]) {
  return {
    live: Object.fromEntries(live.map((t) => [t.id, t])),
    archived: Object.fromEntries(archived.map((t) => [t.id, t])),
  };
}

describe('splitByArchived / mergeBuckets', () => {
  test('a mixed map is sorted by its flag and reads back as one map', () => {
    const mixed = { a: topic('a', false), b: topic('b', true), c: topic('c', false) };
    const b = splitByArchived(mixed);
    expect(Object.keys(b.live).sort()).toEqual(['a', 'c']);
    expect(Object.keys(b.archived)).toEqual(['b']);
    expect(mergeBuckets(b)).toEqual(mixed);
  });
});

describe('upsertTopics keeps the identity of the half it did not touch', () => {
  test('updating a live topic leaves the archived bucket as the same object', () => {
    const b = buckets([topic('a', false)], [topic('z', true)]);
    const next = upsertTopics(b, [topic('a', false, { name: 'renamed' })]);
    expect(next.live.a.name).toBe('renamed');
    expect(next.archived).toBe(b.archived);
    expect(next.live).not.toBe(b.live);
  });

  test('archiving moves the topic across and changes both halves once', () => {
    const b = buckets([topic('a', false)], [topic('z', true)]);
    const next = upsertTopics(b, [topic('a', true)]);
    expect(next.live.a).toBeUndefined();
    expect(next.archived.a?.archived).toBe(true);
    expect(next.archived.z).toBeDefined();
  });

  test('reopening moves it back', () => {
    const b = buckets([], [topic('a', true)]);
    const next = upsertTopics(b, [topic('a', false)]);
    expect(next.archived.a).toBeUndefined();
    expect(next.live.a?.archived).toBe(false);
  });

  test('nothing to upsert returns the same buckets object', () => {
    const b = buckets([topic('a', false)], []);
    expect(upsertTopics(b, [])).toBe(b);
  });
});

describe('replaceLive / vanishedFrom (a fresh boot list)', () => {
  test('the server list becomes the live half; a topic it carries leaves the archive', () => {
    const b = buckets([topic('a', false), topic('gone', false)], [topic('z', true), topic('a-reopened', true)]);
    const fresh = { a: topic('a', false), 'a-reopened': topic('a-reopened', false) };
    const next = replaceLive(b, fresh);
    expect(next.live).toBe(fresh);
    expect(next.archived['a-reopened']).toBeUndefined();
    expect(next.archived.z).toBeDefined();
  });

  test('the archive keeps its identity when no id crossed over', () => {
    const b = buckets([topic('a', false)], [topic('z', true)]);
    const next = replaceLive(b, { a: topic('a', false, { name: 'renamed' }) });
    expect(next.archived).toBe(b.archived);
  });

  test('a live id missing from the fresh list and unknown to the archive is reported as vanished', () => {
    const b = buckets([topic('a', false), topic('gone', false), topic('closed', false)], [topic('closed', true)]);
    const fresh = { a: topic('a', false) };
    // `closed` is already known archived (a WS frame moved it); `gone` is not.
    expect(vanishedFrom(b, fresh)).toEqual(['gone']);
  });
});

describe('replaceArchived (the archive arrived)', () => {
  test('the server archive becomes the archived half and takes its ids out of the live one', () => {
    const b = buckets([topic('a', false), topic('stale', false)], [topic('old', true)]);
    const fresh = { stale: topic('stale', true), z: topic('z', true) };
    const next = replaceArchived(b, fresh);
    expect(next.archived).toBe(fresh);
    expect(next.live.stale).toBeUndefined();
    expect(next.live.a).toBeDefined();
  });

  test('the live half keeps its identity when nothing crossed over', () => {
    const b = buckets([topic('a', false)], []);
    const next = replaceArchived(b, { z: topic('z', true) });
    expect(next.live).toBe(b.live);
  });
});

describe('readTopicCaches (the first frame)', () => {
  const storage = (data: Record<string, string>): Pick<Storage, 'getItem'> => ({
    getItem: (k) => data[k] ?? null,
  });

  test('a legacy topics-cache with the archive mixed in is split on read', () => {
    const legacy = { a: topic('a', false), z: topic('z', true) };
    const b = readTopicCaches(storage({ [LIVE_CACHE_KEY]: JSON.stringify(legacy) }));
    expect(Object.keys(b.live)).toEqual(['a']);
    expect(Object.keys(b.archived)).toEqual(['z']);
  });

  test('both keys are read and the flag decides, not the key', () => {
    const b = readTopicCaches(storage({
      [LIVE_CACHE_KEY]: JSON.stringify({ a: topic('a', false) }),
      [ARCHIVED_CACHE_KEY]: JSON.stringify({ z: topic('z', true), reopened: topic('reopened', false) }),
    }));
    expect(Object.keys(b.live).sort()).toEqual(['a', 'reopened']);
    expect(Object.keys(b.archived)).toEqual(['z']);
  });

  test('garbage in a cache is a hint ignored, not an error', () => {
    const b = readTopicCaches(storage({ [LIVE_CACHE_KEY]: '{not json', [ARCHIVED_CACHE_KEY]: '[1,2]' }));
    expect(b).toEqual(emptyBuckets());
  });
});

describe('persistBuckets writes only the half that changed', () => {
  /** Real writers on a hand-driven clock: `persist` writes, then `tick` closes
   *  every window armed, so each step counts what reached storage. The
   *  throttle itself is proven in throttledLocalWrite.test.ts; here only WHICH
   *  key is written matters. */
  function counting() {
    const data = new Map<string, string>();
    const writes: Record<string, number> = {};
    const storage: WriterStorage = {
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => { data.set(k, v); writes[k] = (writes[k] ?? 0) + 1; },
    };
    let seq = 0;
    const timers = new Map<number, () => void>();
    const schedule = (fn: () => void) => { timers.set(++seq, fn); return seq; };
    const cancel = (handle: unknown) => { timers.delete(handle as number); };
    const writers = {
      live: createThrottledLocalWriter({ key: LIVE_CACHE_KEY, storage, schedule, cancel }),
      archived: createThrottledLocalWriter({ key: ARCHIVED_CACHE_KEY, storage, schedule, cancel }),
    };
    const persist = (prev: ReturnType<typeof buckets> | null, next: ReturnType<typeof buckets>, known: { live: boolean; archived: boolean }) => {
      persistBuckets(prev, next, writers, known);
      const due = [...timers.values()];
      timers.clear();
      for (const fn of due) fn();
    };
    return { persist, writes, data };
  }

  test('a hundred updates of live topics cost the archived cache nothing', () => {
    const { persist, writes } = counting();
    const known = { live: true, archived: true };
    let prev = buckets([topic('a', false)], [topic('z', true)]);
    persist(null, prev, known);
    expect(writes[LIVE_CACHE_KEY]).toBe(1);
    expect(writes[ARCHIVED_CACHE_KEY]).toBe(1);

    for (let i = 0; i < 100; i++) {
      const next = upsertTopics(prev, [topic('a', false, { name: `r${i}` })]);
      persist(prev, next, known);
      prev = next;
    }
    expect(writes[LIVE_CACHE_KEY]).toBe(101);
    expect(writes[ARCHIVED_CACHE_KEY]).toBe(1);
  });

  test('archiving a topic writes both halves, once each', () => {
    const { persist, writes } = counting();
    const known = { live: true, archived: true };
    const prev = buckets([topic('a', false)], [topic('z', true)]);
    persist(null, prev, known);
    const next = upsertTopics(prev, [topic('a', true)]);
    persist(prev, next, known);
    expect(writes[LIVE_CACHE_KEY]).toBe(2);
    expect(writes[ARCHIVED_CACHE_KEY]).toBe(2);
  });

  test('an empty half the server has not answered for is not written over the cache', () => {
    const { persist, writes } = counting();
    const b = buckets([topic('a', false)], []);
    persist(null, b, { live: true, archived: false });
    expect(writes[LIVE_CACHE_KEY]).toBe(1);
    expect(writes[ARCHIVED_CACHE_KEY]).toBeUndefined();
    // Once the server has said "none", the empty archive IS the truth.
    persist(null, b, { live: true, archived: true });
    expect(writes[ARCHIVED_CACHE_KEY]).toBe(1);
  });

  test('the same bytes are not written twice even when the object changed', () => {
    const { persist, writes } = counting();
    const known = { live: true, archived: true };
    const prev = buckets([topic('a', false)], [topic('z', true)]);
    persist(null, prev, known);
    const same = { live: { ...prev.live }, archived: { ...prev.archived } };
    persist(prev, same, known);
    expect(writes[LIVE_CACHE_KEY]).toBe(1);
    expect(writes[ARCHIVED_CACHE_KEY]).toBe(1);
  });
});

describe('toListShape', () => {
  test('a whole topic keeps the flag and drops the prompt and the browser state', () => {
    const whole = topic('a', true, { systemPrompt: 'be brief', browserState: { url: 'https://x' } as Topic['browserState'] });
    const listed = toListShape(whole);
    expect(listed.systemPrompt).toBeUndefined();
    expect(listed.browserState).toBeUndefined();
    expect(listed.hasSystemPrompt).toBe(true);
    expect(toListShape(topic('b', false)).hasSystemPrompt).toBeUndefined();
  });
});
