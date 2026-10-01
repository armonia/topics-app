/**
 * The chat's per-session turn flags wake only the subscribers of the session
 * that changed, so a turn in a background chat does not re-render the app.
 *
 * @covers BGSTREAM-01
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  __resetSessionFlags,
  flagMapRef,
  flagSetter,
  getSessionFlag,
  subscribeAllSessionFlags,
  subscribeSessionFlags,
  updateSessionFlags,
} from './sessionFlags';

afterEach(() => __resetSessionFlags());

describe('the per-session turn flags', () => {
  test('a change wakes the subscribers of that session only, and the global ones', () => {
    const woke: string[] = [];
    subscribeSessionFlags('topic:a', () => woke.push('a'));
    subscribeSessionFlags('topic:b', () => woke.push('b'));
    subscribeAllSessionFlags(() => woke.push('all'));
    updateSessionFlags('streaming', (prev) => ({ ...prev, 'topic:a': true }));
    expect(woke).toEqual(['a', 'all']);
    expect(getSessionFlag('streaming', 'topic:a')).toBe(true);
    expect(getSessionFlag('streaming', 'topic:b')).toBe(false);
  });

  test('a write that changes no boolean wakes nobody', () => {
    const woke: string[] = [];
    subscribeSessionFlags('topic:a', () => woke.push('a'));
    subscribeAllSessionFlags(() => woke.push('all'));
    // The shape every "turn over" path writes: false over a key never set.
    updateSessionFlags('loading', (prev) => ({ ...prev, 'topic:a': false }));
    // The same value again.
    updateSessionFlags('thinking', (prev) => ({ ...prev, 'topic:a': true }));
    woke.length = 0;
    updateSessionFlags('thinking', (prev) => ({ ...prev, 'topic:a': true }));
    expect(woke).toEqual([]);
  });

  test('the four flags are independent maps', () => {
    const setStopped = flagSetter('stopped');
    setStopped((prev) => ({ ...prev, 'topic:a': true }));
    expect(getSessionFlag('stopped', 'topic:a')).toBe(true);
    expect(getSessionFlag('streaming', 'topic:a')).toBe(false);
  });

  test('a key dropped from the map while true counts as a change', () => {
    const woke: string[] = [];
    updateSessionFlags('streaming', { 'topic:a': true });
    subscribeSessionFlags('topic:a', () => woke.push('a'));
    updateSessionFlags('streaming', {});
    expect(woke).toEqual(['a']);
  });

  test('the live ref always reads the current map', () => {
    const ref = flagMapRef('streaming');
    updateSessionFlags('streaming', (prev) => ({ ...prev, 'topic:a': true }));
    expect(ref.current['topic:a']).toBe(true);
    updateSessionFlags('streaming', (prev) => ({ ...prev, 'topic:a': false }));
    expect(ref.current['topic:a']).toBe(false);
  });

  test('an unsubscribed listener is not called again', () => {
    const woke: string[] = [];
    const off = subscribeSessionFlags('topic:a', () => woke.push('a'));
    off();
    updateSessionFlags('streaming', { 'topic:a': true });
    expect(woke).toEqual([]);
  });
});
