/**
 * THE RULE THAT DECIDES WHETHER THE AMBER NOTICE EVER GOES OUT.
 *
 * `loadTopics` falls back to the local copy when its read fails, and raises
 * "Using cached data…" at the foot of the sidebar. Only a successful read takes
 * that notice down, so the retry condition IS the notice's lifetime: outside
 * it, the line stays lit for the rest of the session with yesterday's rows
 * underneath.
 *
 * The two cases under test are the ones the previous condition got wrong, in
 * opposite directions: an HTTP refusal was NEVER retried (it has neither
 * 'AbortError' for a name nor any engine's network message), and everything
 * else was retried every three seconds FOR EVER, because the call was recursive
 * under a comment that said "once".
 * @covers TOPIC-01
 */
import { describe, expect, test } from 'bun:test';
import {
  TOPICS_RETRY_CEILING_MS,
  shouldRetryTopicsLoad,
  topicsRetryDelayMs,
} from './topicsRetry';

describe('shouldRetryTopicsLoad: an HTTP refusal is a failure like the others', () => {
  test('the 400 of the allowlist cache, right after a server restart', () => {
    // The real case: the project allowlist has a five-second cache, and inside
    // that window `GET /api/topics` answers 400 to a client that is reloading.
    // An `ApiError` carries the SERVER's message, so none of the three network
    // texts catches it.
    expect(shouldRetryTopicsLoad({ name: 'ApiError', message: 'project not allowed', status: 400 })).toBe(true);
  });

  test('and a 500, and a 503', () => {
    expect(shouldRetryTopicsLoad({ name: 'ApiError', message: 'internal error', status: 500 })).toBe(true);
    expect(shouldRetryTopicsLoad({ name: 'ApiError', message: 'Service Unavailable', status: 503 })).toBe(true);
  });

  test('the 6 s timeout and the three network texts, one per engine, stay in', () => {
    expect(shouldRetryTopicsLoad({ name: 'AbortError', message: 'aborted', status: null })).toBe(true);
    expect(shouldRetryTopicsLoad({ name: 'TypeError', message: 'Failed to fetch', status: null })).toBe(true);
    expect(shouldRetryTopicsLoad({ name: 'TypeError', message: 'NetworkError when attempting to fetch', status: null })).toBe(true);
    // WebKit, which is the Tauri shell: the text that was missing on 2026-07-11.
    expect(shouldRetryTopicsLoad({ name: 'TypeError', message: 'Load failed', status: null })).toBe(true);
  });

  test('the 401 and 403 of identity do NOT: markUnpaired owns those', () => {
    // Retrying here is noise and nothing else: the answer does not change
    // until somebody pairs the device again, and there is already a screen
    // asking for exactly that.
    expect(shouldRetryTopicsLoad({ name: 'ApiError', message: 'device revoked', status: 401 })).toBe(false);
    expect(shouldRetryTopicsLoad({ name: 'ApiError', message: 'forbidden', status: 403 })).toBe(false);
  });

  test('a failure that is neither a response nor the transport is not retried', () => {
    // A malformed JSON, or a bug of our own: repeating the same request would
    // produce the identical outcome.
    expect(shouldRetryTopicsLoad({ name: 'SyntaxError', message: 'Unexpected token <', status: null })).toBe(false);
    expect(shouldRetryTopicsLoad({})).toBe(false);
  });
});

describe('topicsRetryDelayMs: the ceiling slows down, it does not switch off', () => {
  test('it doubles from three seconds and stops at a minute', () => {
    expect([0, 1, 2, 3, 4].map(topicsRetryDelayMs)).toEqual([3000, 6000, 12000, 24000, 48000]);
    expect(topicsRetryDelayMs(5)).toBe(TOPICS_RETRY_CEILING_MS);
  });

  test('at the hundredth attempt it still waits a minute, not for ever', () => {
    // This is the difference between "slows down" and "gives up": against a
    // server that comes back after ten minutes, a client that gave up sits on
    // the amber notice until somebody reloads the page by hand.
    expect(topicsRetryDelayMs(100)).toBe(TOPICS_RETRY_CEILING_MS);
    expect(Number.isFinite(topicsRetryDelayMs(1000))).toBe(true);
  });

  test('the first wait after a success is the short one again', () => {
    // `loadTopics` zeroes the counter when the server answers: the next failure
    // starts from three seconds, not from the minute it had climbed to.
    expect(topicsRetryDelayMs(0)).toBe(3000);
  });
});
