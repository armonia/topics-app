/**
 * A DOWNLOAD ANNOUNCES ITSELF.
 *
 * The defect, measured on the card: `downloadsStarted` reached this hook and
 * was thrown away. The chrome row only appeared when you asked for it (console
 * or downloads list from the tab menu), and the menu that was supposed to
 * replace it sits behind three dots that stay invisible until the pointer is
 * over them. Result: a PDF landed on the disk and the app said NOTHING - no
 * bubble, no badge, no toast.
 *
 * What is watched here is the only thing that defect is about: on the bump the
 * row exists (`showChrome`) and the list is requested
 * (`downloadsRequestOpen`), which is what `DownloadsMenu` waits for to open.
 * The rest of the chain (button, entry, size) is already covered by the
 * `browser-ws-streaming` E2E.
 *
 * @covers BROWSER-01
 */
import { describe, it, expect } from 'bun:test';
import { createElement } from 'react';
import { mount } from '../../test/reactHarness';
import { useBrowserChromeBridge, type BrowserChromeBridge } from './useBrowserChromeBridge';

interface Knobs { url: string; downloads: number; downloadsStarted: number }

/** The bridge's outcome, one entry per pass. */
function drive(knobs: () => Knobs, seen: BrowserChromeBridge[]) {
  return function Probe() {
    const k = knobs();
    seen.push(useBrowserChromeBridge('ctx-test', {
      url: k.url,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      downloads: k.downloads,
      downloadsStarted: k.downloadsStarted,
      shared: false,
      commands: {},
    }));
    return null;
  };
}

describe('the chrome row and the downloads', () => {
  it('a download that starts brings it up and asks for its list', () => {
    let knobs: Knobs = { url: 'https://example.com/', downloads: 0, downloadsStarted: 0 };
    const seen: BrowserChromeBridge[] = [];
    const h = mount(createElement(drive(() => knobs, seen)));
    try {
      expect(seen.at(-1)?.showChrome).toBe(false);
      const requestsBefore = seen.at(-1)!.downloadsRequestOpen;

      knobs = { url: 'https://example.com/', downloads: 1, downloadsStarted: 1 };
      h.rerender();

      expect(seen.at(-1)?.showChrome).toBe(true);
      expect(seen.at(-1)!.downloadsRequestOpen).toBeGreaterThan(requestsBefore);
    } finally {
      h.unmount();
    }
  });

  it('the next navigation takes it back', () => {
    let knobs: Knobs = { url: 'https://example.com/', downloads: 0, downloadsStarted: 0 };
    const seen: BrowserChromeBridge[] = [];
    const h = mount(createElement(drive(() => knobs, seen)));
    try {
      knobs = { ...knobs, downloads: 1, downloadsStarted: 1 };
      h.rerender();
      expect(seen.at(-1)?.showChrome).toBe(true);

      knobs = { url: 'https://example.com/altro', downloads: 1, downloadsStarted: 1 };
      h.rerender();
      expect(seen.at(-1)?.showChrome).toBe(false);
    } finally {
      h.unmount();
    }
  });

  it('a pane starting over from zero opens nothing', () => {
    // `downloadsStarted` only falls when the pane changes identity: then the
    // reference re-syncs in silence, without bringing up a row nobody asked
    // for.
    let knobs: Knobs = { url: 'https://example.com/', downloads: 2, downloadsStarted: 3 };
    const seen: BrowserChromeBridge[] = [];
    const h = mount(createElement(drive(() => knobs, seen)));
    try {
      knobs = { url: 'https://example.com/', downloads: 0, downloadsStarted: 0 };
      h.rerender();
      expect(seen.at(-1)?.showChrome).toBe(false);
    } finally {
      h.unmount();
    }
  });
});
