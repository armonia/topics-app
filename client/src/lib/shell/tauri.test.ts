/**
 * NO WINDOW IS "NOT UNDER TAURI", NOT AN EXCEPTION.
 *
 * These helpers all ask one question - is a Tauri shell hosting us - and they
 * all promise the same two answers: the shell, or null. Reading `window` by name
 * when no such global exists is neither: it is a ReferenceError, raised
 * synchronously, before any promise exists for a `.catch()` to attach to.
 *
 * WHY THIS IS WORTH A TEST. A browser pane's teardown schedules `browser_close`
 * behind a 350ms grace (`hooks/useTauriBrowser`). A test file that unmounted a
 * pane finishes well inside that window and takes its fake `window` with it, so
 * the timer lands in a world without one. The throw escapes the timer callback,
 * bun files it as an unhandled error BETWEEN tests, and the NEXT file in the
 * shard dies with "Cannot call describe() after the test run has completed" -
 * naming a file that has nothing to do with browser panes. That is the red seen
 * in CI on `client/src/lib/authorDisplay.test.ts`, and the reason it moved
 * target between runs: the victim is whoever happens to be next.
 *
 * @covers SHELL-TAURI-01
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { currentWindowLabel, tauriInvoke } from './tauri';

const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

/**
 * Takes `window` away, and SAYS SO when it could not.
 *
 * `delete globalThis.window` is not enough everywhere: if the global comes from a
 * preload that puts it on the prototype or behind a getter, the delete removes an
 * own property that is not there and the inherited one answers all the same. That
 * is what happened in CI - this file passed on the laptop and failed on the runner
 * with `threw: null, rejectedWith: null`, meaning `internals()` still found Tauri.
 * A diff like that does not say "the code is wrong", it says "the test measured
 * something else", which is the worst kind of red.
 *
 * `defineProperty` with `value: undefined` creates an OWN property that covers
 * whatever is underneath. And the condition is checked rather than hoped for: if
 * the environment will not grant it, the test dies here saying why.
 */
function withoutWindow(body: () => void | Promise<void>): void | Promise<void> {
  Object.defineProperty(globalThis, 'window', { value: undefined, configurable: true, writable: true });
  expect(typeof window, "l'ambiente non lascia togliere `window`: il test non puo' misurare niente")
    .toBe('undefined');
  return body();
}

afterEach(() => {
  if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
  else delete (globalThis as Record<string, unknown>).window;
});

describe('the Tauri helpers with no window at all', () => {
  test('an invoke REJECTS instead of throwing, so a detached timer can catch it', async () => {
    // The shape the caller relies on: `tauriInvoke(...).catch(...)`. A synchronous
    // throw walks straight past that catch and out of the timer.
    let threw: unknown = null;
    let rejected: unknown = null;
    await withoutWindow(async () => {
      try {
        await tauriInvoke('browser_close', { id: 'x' }).catch((e: unknown) => { rejected = e; });
      } catch (e) { threw = e; }
    });
    expect({ threw, rejectedWith: (rejected as Error | null)?.message ?? null })
      .toEqual({ threw: null, rejectedWith: 'not running under Tauri' });
  });

  test('the window label answers null, the same as being off Tauri', () => {
    let threw: unknown = null;
    let label: string | null | undefined;
    withoutWindow(() => {
      try { label = currentWindowLabel(); } catch (e) { threw = e; }
    });
    expect({ threw, label }).toEqual({ threw: null, label: null });
  });
});
