/**
 * ASKING FOR THE ADDRESS BAR IS ASKING FOR THE KEYBOARD.
 *
 * The defect, measured on the shipped Windows app (2.2.291, card 4f4954e1): a
 * browser pane is a NATIVE child webview, and while it is there it holds the
 * operating system's keyboard. Ctrl+L opened the inline address editor of the
 * tab, which looked focused and received nothing: every letter went to the page
 * instead, and an HTTP witness on a port the app does not use recorded no
 * request at all. Typing the same address the instant the pane opens does load
 * it, because the native child does not exist yet.
 *
 * The tab strip already asked the shell for the keyboard on pointer-down, so
 * the mouse worked and only the keyboard was dead. What is pinned here is that
 * the ask now lives at the one door both gestures pass through: `focusAddress`
 * releases the native focus BEFORE requesting the caret. Off the desktop shell
 * `releaseNativeFocus` is a no-op, which is why the assertion is on the call
 * and not on a focus that no test environment has.
 *
 * Both modules are imported STATICALLY on purpose. A `const m = await
 * import(…)` would make this module opaque to knip, and the dead-code gate
 * would stop seeing every export of the hook (`check:deadcode-blindspots`).
 * `mock.module` reaches an already-imported module through the live binding, so
 * the hook calls the spy without the dynamic import.
 *
 * @covers BROWSER-01
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import { createElement } from 'react';
import { mount } from '../../test/reactHarness';
import { getBrowserPaneChrome } from '../../state/browserPaneChrome';
import * as tauriShell from '../../lib/shell/tauri';
import { useBrowserChromeBridge, type BrowserChromeBridge } from './useBrowserChromeBridge';

/** The registry key the hook publishes under, for the context id below. */
const PANE = 'browser:ctx-keyboard';

/**
 * The real exports, captured at load time — before any mock is installed and
 * every one of them by hand: a restore that lists fewer would leave the missing
 * ones undefined for every file that runs after this one.
 */
const realTauri = {
  tauriInvoke: tauriShell.tauriInvoke,
  currentWindowLabel: tauriShell.currentWindowLabel,
  releaseNativeFocus: tauriShell.releaseNativeFocus,
};

/** How many times the shell was asked to hand the keyboard back. */
let released = 0;

beforeAll(() => {
  mock.module('../../lib/shell/tauri', () => ({
    ...realTauri,
    releaseNativeFocus: () => { released++; },
  }));
});

afterAll(() => {
  mock.module('../../lib/shell/tauri', () => realTauri);
});

function probe(seen: BrowserChromeBridge[]) {
  return function Probe() {
    seen.push(useBrowserChromeBridge('ctx-keyboard', {
      url: 'https://example.com/',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      downloads: 0,
      downloadsStarted: 0,
      shared: false,
      commands: {},
    }));
    return null;
  };
}

describe('the caret and the native keyboard', () => {
  test('focusAddress asks the shell for the keyboard before requesting the caret', () => {
    const seen: BrowserChromeBridge[] = [];
    const h = mount(createElement(probe(seen)));
    try {
      const asksBefore = released;
      const requestsBefore = getBrowserPaneChrome(PANE)!.addressEditRequest;

      seen.at(-1)!.focusAddress();

      expect(released).toBe(asksBefore + 1);
      expect(getBrowserPaneChrome(PANE)!.addressEditRequest).toBeGreaterThan(requestsBefore);
    } finally {
      h.unmount();
    }
  });
});
