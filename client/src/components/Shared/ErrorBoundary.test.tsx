/**
 * THE NET UNDERNEATH HAS TO HOLD WHEN THERE IS NOTHING THERE YET.
 *
 * `main.tsx` now wraps the whole app in this net, and the case it exists for is
 * the worst one available: a throw in the render of `App` - 2,635 lines of
 * hooks, all mounted together before the first frame. There was no net there,
 * and such a throw left an empty page with nothing but the theme's background:
 * "a white screen, with not even a way to close it", written in `App.tsx` next
 * to Settings' own net, which itself arrived after a real failure (a device
 * with no `id` blowing up `DevicesSection`).
 *
 * The risk with a crash screen is that it crashes too, and here the concrete
 * way is the language: `currentLocale()` reads the settings, and at the moment
 * this net draws, the settings may very well not be there - it may be exactly
 * what made the app throw. With `localStorage` THROWING (a WKWebView with site
 * data blocked, a runtime with no DOM) the read still has to produce a readable
 * sentence, not a second exception inside the fallback's own `render`.
 *
 * @covers PANE-01
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement, type ReactElement } from 'react';
import { ErrorBoundary } from './ErrorBoundary';
import IT from '../../lib/i18n-it';
import EN from '../../lib/i18n-en';

/**
 * The fallback screen, actually drawn.
 *
 * The child is NOT made to throw: `renderToStaticMarkup` has none of React's
 * nets - the string renderer RETHROWS instead of running
 * `getDerivedStateFromError` (measured: the first version of this file failed
 * with the child's error, not with the screen). So the component is put into
 * the state the net would have put it in, using its own static method, and
 * what it would draw is drawn: the real `render()` branch, `currentLocale()`
 * included, which is what this file is looking at.
 */
function crashScreen(fallbackMessageKey?: string): string {
  const boundary = new ErrorBoundary({ fallbackMessageKey, children: null });
  boundary.state = ErrorBoundary.getDerivedStateFromError(new Error('a device with no id'));
  return renderToStaticMarkup(boundary.render() as ReactElement);
}

const realLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

function withLocalStorage(impl: { getItem(k: string): string | null } | 'throws'): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      if (impl === 'throws') throw new Error('the browser refuses site data');
      return impl;
    },
  });
}

afterEach(() => {
  if (realLocalStorage) Object.defineProperty(globalThis, 'localStorage', realLocalStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

/**
 * The root's headline exists in BOTH catalogues. A missing key does not look
 * like an error: `t()` falls back to Italian and then to the KEY itself, so the
 * symptom would be the string `crash.app` printed in the middle of the crash
 * screen, which is the one place nobody goes to look.
 */
describe('crash.app: the headline of the net underneath', () => {
  test('it is there in Italian and in English, and it is not the key', () => {
    expect(IT['crash.app']).toBeTruthy();
    expect(EN['crash.app']).toBeTruthy();
    expect(IT['crash.app']).not.toBe('crash.app');
    expect(EN['crash.app']).not.toBe('crash.app');
  });
});

describe('ErrorBoundary: the crash screen does not crash', () => {
  test('with no settings saved it still draws the sentence, not the key', () => {
    // The boot case: `topics-settings` was never written, or the crash arrived
    // before anybody got to write it.
    withLocalStorage({ getItem: () => null });
    const html = crashScreen('crash.app');
    expect(html).toContain(IT['crash.app']);
    expect(html).not.toContain('crash.app');
  });

  test('with localStorage THROWING the screen holds all the same', () => {
    // `loadSettings()` throws, `currentLocale()` falls back to FALLBACK_LOCALE:
    // without that try/catch the fallback would throw INSIDE the fallback's
    // render and the page would stay blank - which is exactly the failure this
    // net exists to prevent.
    withLocalStorage('throws');
    const html = crashScreen('crash.app');
    expect(html).toContain(IT['crash.app']);
  });

  test("the error's raw message stays on screen: it is the diagnosis", () => {
    withLocalStorage({ getItem: () => null });
    const html = crashScreen('crash.app');
    expect(html).toContain('a device with no id');
    // And a way out, which is the piece the white page was missing.
    expect(html).toContain(IT['crash.generic.action']);
  });

  test('with no error the children pass through untouched', () => {
    withLocalStorage({ getItem: () => null });
    const child = createElement('span', null, 'the app');
    const html = renderToStaticMarkup(createElement(ErrorBoundary, { children: child }));
    expect(html).toContain('the app');
  });
});
