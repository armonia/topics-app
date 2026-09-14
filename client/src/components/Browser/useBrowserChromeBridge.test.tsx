/**
 * A DOWNLOAD ANNOUNCES ITSELF, AND OPENS NOTHING.
 *
 * Two defects, one on each side of the same line, and this file is the fence
 * between them.
 *
 *  - It said NOTHING. `downloadsStarted` reached this hook and was thrown away:
 *    a PDF landed on the disk and there was no bubble, no badge, no toast.
 *  - Then it said it too loudly. The cure was a 40px chrome row brought back
 *    over the page by the arrival, and the sheet that replaced that row would
 *    be the same interruption with a smaller footprint: it COVERS the page and
 *    FREEZES it, so a file arriving mid-read would stop the reading to report
 *    something nobody asked about at that instant.
 *
 * So the bridge only PUBLISHES: `downloadsStarted` travels to the tab, which
 * lights its quiet cue, and the opening waits for a click on that cue —
 * `openDownloads`, which bumps `downloadsOpenRequest` and nothing else. What is
 * asserted here is exactly that asymmetry. The rest of the chain (cue, entry,
 * size) is covered by the `browser-ws-streaming` E2E.
 *
 * @covers BROWSER-01
 */
import { describe, it, expect } from 'bun:test';
import { createElement, act } from 'react';
import { mount } from '../../test/reactHarness';
import { useBrowserChromeBridge } from './useBrowserChromeBridge';
import { getBrowserPaneChrome } from '../../state/browserPaneChrome';

const PANE = 'browser:ctx-test';

interface Knobs { url: string; downloads: number; downloadsStarted: number }

const DOWNLOADS = {
  items: [], activeCount: 0, startedCount: 0,
  onDismiss: () => {}, onClear: () => {},
};

function drive(knobs: () => Knobs) {
  return function Probe() {
    const k = knobs();
    useBrowserChromeBridge('ctx-test', {
      url: k.url,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      downloads: k.downloads,
      downloadsStarted: k.downloadsStarted,
      shared: false,
      // Present, so `openDownloads` is offered: a command that would open an
      // empty section is not offered at all.
      downloadsMenu: { ...DOWNLOADS, startedCount: k.downloadsStarted },
      commands: {},
    });
    return null;
  };
}

describe('a download and the tab', () => {
  it('travels to the tab and opens nothing on its own', () => {
    let knobs: Knobs = { url: 'https://example.com/', downloads: 0, downloadsStarted: 0 };
    const h = mount(createElement(drive(() => knobs)));
    try {
      const before = getBrowserPaneChrome(PANE)!;
      expect(before.downloadsStarted).toBe(0);

      knobs = { url: 'https://example.com/', downloads: 1, downloadsStarted: 1 };
      h.rerender();

      const after = getBrowserPaneChrome(PANE)!;
      // The cue can light: the count reached the tab.
      expect(after.downloadsStarted).toBe(1);
      expect(after.downloads).toBe(1);
      // And NOTHING was asked to open — neither door.
      expect(after.downloadsOpenRequest).toBe(before.downloadsOpenRequest);
      expect(after.addressEditRequest).toBe(before.addressEditRequest);
    } finally {
      h.unmount();
    }
  });

  it('the click on the cue is what asks for the list', () => {
    const knobs: Knobs = { url: 'https://example.com/', downloads: 1, downloadsStarted: 1 };
    const h = mount(createElement(drive(() => knobs)));
    try {
      const before = getBrowserPaneChrome(PANE)!;
      act(() => { before.commands.openDownloads!(); });
      const after = getBrowserPaneChrome(PANE)!;

      expect(after.downloadsOpenRequest).toBeGreaterThan(before.downloadsOpenRequest);
      // Asking for the list must not ask for the caret: opened from the cue the
      // address field is neither focused nor selected.
      expect(after.addressEditRequest).toBe(before.addressEditRequest);
    } finally {
      h.unmount();
    }
  });

  it('a pane starting over from zero asks for nothing', () => {
    // `downloadsStarted` only falls when the pane changes identity: the tab
    // re-syncs in silence and no request is emitted.
    let knobs: Knobs = { url: 'https://example.com/', downloads: 2, downloadsStarted: 3 };
    const h = mount(createElement(drive(() => knobs)));
    try {
      const before = getBrowserPaneChrome(PANE)!;
      knobs = { url: 'https://example.com/', downloads: 0, downloadsStarted: 0 };
      h.rerender();
      const after = getBrowserPaneChrome(PANE)!;

      expect(after.downloadsStarted).toBe(0);
      expect(after.downloadsOpenRequest).toBe(before.downloadsOpenRequest);
    } finally {
      h.unmount();
    }
  });
});
