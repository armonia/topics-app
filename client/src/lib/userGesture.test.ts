/**
 * The device's gesture clock. The pane tests drive it through its test hook,
 * so this is the only place where a real event has to move it: a tap that
 * does not would leave the iPad showing the Mac's layout with every other
 * test still green.
 *
 * @covers TOPIC-BROWSER-05
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { __resetUserGestureForTests, installUserGestureClock, lastUserGestureAt, onUserGesture } from './userGesture';

const g = globalThis as unknown as Record<string, unknown>;
let savedWindow: unknown;
/** What the clock registered on the window, by event type. */
let handlers: Map<string, { handler: (event: Event) => void; options: unknown }>;

beforeEach(() => {
  savedWindow = g.window;
  handlers = new Map();
  g.window = {
    addEventListener: (type: string, handler: (event: Event) => void, options: unknown) => {
      handlers.set(type, { handler, options });
    },
  };
  __resetUserGestureForTests();
  installUserGestureClock();
});

afterEach(() => {
  // Deleted, not set back to undefined: a `window` key left on globalThis
  // makes `"window" in globalThis` true for every file that runs after.
  if (savedWindow === undefined) delete g.window;
  else g.window = savedWindow;
  __resetUserGestureForTests();
});

function fire(type: string, isTrusted: boolean): void {
  handlers.get(type)?.handler({ isTrusted } as Event);
}

test('a tap, a key and a wheel each move the clock, without getting in their way', () => {
  for (const type of ['pointerdown', 'keydown', 'wheel']) {
    expect(handlers.get(type)?.options, `${type}: non ascoltato, o ascoltato in modo da poterlo bloccare`).toEqual({ capture: true, passive: true });
    const before = Date.now();
    fire(type, true);
    expect(lastUserGestureAt(), `${type} non ha mosso l'orologio`).toBeGreaterThanOrEqual(before);
    __resetUserGestureForTests();
  }
});

test('an event a script dispatched is not the person', () => {
  fire('pointerdown', false);
  expect(lastUserGestureAt(), 'un evento sintetico conta come un tocco').toBe(0);
});

test('every listener hears each gesture, and they share one claim per page', () => {
  const heard: string[] = [];
  const offFirst = onUserGesture((gesture) => { heard.push('first'); gesture.claimed.add('ctx'); });
  const offSecond = onUserGesture((gesture) => { heard.push(gesture.claimed.has('ctx') ? 'second, already claimed' : 'second'); });
  fire('keydown', true);
  offFirst();
  offSecond();
  fire('keydown', true);
  expect(heard).toEqual(['first', 'second, already claimed']);
});
