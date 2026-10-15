/**
 * @covers RUNTIME-23
 */
import { describe, expect, test } from 'bun:test';
import { startVisibleInterval, type VisibleIntervalEnv } from './documentVisibility';

function createEnv(visible: boolean) {
  const listeners = new Set<() => void>();
  const timers = new Map<number, () => void>();
  let nextId = 1;
  const env: VisibleIntervalEnv = {
    isVisible: () => visible,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setInterval(callback) {
      const id = nextId++;
      timers.set(id, callback);
      return id;
    },
    clearInterval(timer) { timers.delete(timer as number); },
  };
  return {
    env,
    timers,
    setVisible(next: boolean) {
      visible = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

describe('startVisibleInterval', () => {
  test('stops its timer while hidden and refreshes once on return', () => {
    const env = createEnv(true);
    let calls = 0;
    const stop = startVisibleInterval(() => { calls += 1; }, 1000, env.env);

    expect(env.timers.size).toBe(1);
    env.setVisible(false);
    expect(env.timers.size).toBe(0);
    env.setVisible(true);
    expect(env.timers.size).toBe(1);
    expect(calls).toBe(1);
    stop();
    expect(env.timers.size).toBe(0);
  });

  test('does not arm while hidden and disposal prevents a later restart', () => {
    const env = createEnv(false);
    let calls = 0;
    const stop = startVisibleInterval(() => { calls += 1; }, 1000, env.env);

    expect(env.timers.size).toBe(0);
    stop();
    env.setVisible(true);
    expect(env.timers.size).toBe(0);
    expect(calls).toBe(0);
  });
});
