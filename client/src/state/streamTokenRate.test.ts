import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import {
  beginStreamTokenRate,
  finishStreamTokenRate,
  forgetStreamTokenRate,
  getStreamTokenRate,
  recordStreamText,
  refreshStreamTokenRate,
  subscribeStreamTokenRate,
} from './streamTokenRate';

const SESSION = 'rate-test-session';

describe('stream token rate', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    forgetStreamTokenRate(SESSION);
  });

  afterEach(() => {
    forgetStreamTokenRate(SESSION);
    jest.useRealTimers();
  });

  test('publishes at a fixed cadence instead of once per streamed chunk', () => {
    beginStreamTokenRate(SESSION);
    let notifications = 0;
    const unsubscribe = subscribeStreamTokenRate(SESSION, () => { notifications += 1; });

    for (let i = 0; i < 100; i += 1) recordStreamText(SESSION, 'word', 0);

    expect(notifications).toBe(1);
    refreshStreamTokenRate(SESSION, 250);
    expect(notifications).toBe(2);
    expect(getStreamTokenRate(SESSION).tokensPerSecond).toBe(400);
    unsubscribe();
  });

  test('uses a 2.5 second moving window for the live text estimate', () => {
    beginStreamTokenRate(SESSION);
    recordStreamText(SESSION, 'a'.repeat(40), 0);
    refreshStreamTokenRate(SESSION, 1_000);
    recordStreamText(SESSION, 'b'.repeat(40), 1_000);
    refreshStreamTokenRate(SESSION, 2_000);

    expect(getStreamTokenRate(SESSION).tokensPerSecond).toBe(10);

    refreshStreamTokenRate(SESSION, 4_500);
    expect(getStreamTokenRate(SESSION).tokensPerSecond).toBe(0);
  });

  test('replaces a text estimate with output usage after a tool-heavy turn', () => {
    beginStreamTokenRate(SESSION);
    recordStreamText(SESSION, 'x'.repeat(100), 1_000);
    finishStreamTokenRate(SESSION, 200, 3_000);

    expect(getStreamTokenRate(SESSION)).toMatchObject({
      mode: 'actual',
      streaming: false,
      tokensPerSecond: 100,
      estimatedTokens: 25,
      actualTokens: 200,
      differencePercent: 87.5,
    });

    recordStreamText(SESSION, 'late transport chunk', 3_001);
    expect(getStreamTokenRate(SESSION).mode).toBe('actual');
  });
});
