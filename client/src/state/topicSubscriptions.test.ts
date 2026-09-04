/**
 * @covers KANBAN-52
 *
 * The extra topics a window declares on the wire, on top of its open panes.
 *
 * What is defended here is the COUNT and the REFERENCE: two holders on the same
 * topic must survive one release, and a snapshot that changed identity without
 * changing content would make `useSyncExternalStore` loop and refire the
 * `subscribe` effect on every render.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import {
  __resetTopicSubscriptions,
  getExtraTopicIds,
  holdTopic,
  subscribeExtraTopics,
} from './topicSubscriptions';

beforeEach(() => {
  __resetTopicSubscriptions();
});

describe('the extra set', () => {
  test('a hold adds the topic, the release takes it away', () => {
    expect(getExtraTopicIds()).toEqual([]);
    const release = holdTopic('t1');
    expect([...getExtraTopicIds()]).toEqual(['t1']);
    release();
    expect([...getExtraTopicIds()]).toEqual([]);
  });

  test('two readers of one topic: the first release does not silence the second', () => {
    const first = holdTopic('t1');
    const second = holdTopic('t1');
    first();
    expect([...getExtraTopicIds()]).toEqual(['t1']);
    second();
    expect([...getExtraTopicIds()]).toEqual([]);
  });

  test('the release is idempotent: calling it twice does not free somebody else', () => {
    const first = holdTopic('t1');
    holdTopic('t1');
    first();
    first();
    expect([...getExtraTopicIds()]).toEqual(['t1']);
  });

  test('an empty id never enters the set', () => {
    holdTopic('');
    expect([...getExtraTopicIds()]).toEqual([]);
  });
});

describe('stability by reference', () => {
  test('the snapshot keeps its identity while the keys do not change', () => {
    holdTopic('t1');
    const first = getExtraTopicIds();
    holdTopic('t1');
    expect(getExtraTopicIds()).toBe(first);
  });

  test('it changes identity when a key enters or leaves', () => {
    const empty = getExtraTopicIds();
    const release = holdTopic('t1');
    expect(getExtraTopicIds()).not.toBe(empty);
    const held = getExtraTopicIds();
    release();
    expect(getExtraTopicIds()).not.toBe(held);
  });
});

describe('the subscribers', () => {
  test('wake up only when the set really changes', () => {
    let woke = 0;
    const stop = subscribeExtraTopics(() => { woke += 1; });

    const first = holdTopic('t1');
    expect(woke).toBe(1);
    const second = holdTopic('t1'); // same key: nothing to publish
    expect(woke).toBe(1);
    first();
    expect(woke).toBe(1);
    second();
    expect(woke).toBe(2);

    stop();
    holdTopic('t2');
    expect(woke).toBe(2);
  });
});
