/**
 * THE TAB KEEPS ITS NAME, AND THE ADDRESS OPENS UNDER IT.
 *
 * Two claims live here. The first is the older defect: the editor was seeded
 * with the raw `chrome.url`, and for a local file that address is the TRANSPORT
 * - `tauri://localhost/api/media?path=%2FUsers%2F…`. What landed under the
 * caret was a string nobody can read or edit, while the label of the very same
 * tab, half a centimetre above, wrote the document.
 *
 * The second is the shape: the panel is a separate surface with its own testid,
 * and the label is still drawn while it is open. Before, the label WAS the
 * input, so a tab being typed into stopped naming its page.
 *
 * The test looks at the field's VALUE, which is a prop and not a child: hence
 * `test/reactHarness` (`hosts`) instead of `renderToStaticMarkup`. And a second
 * render is needed anyway - the editor opens on a BUMP of `addressEditRequest`,
 * so a single-shot renderer would never see it open. There is no DOM in this
 * runtime, so the panel renders in place instead of through its portal; the
 * portal is a placement concern and is exercised by the E2E.
 *
 * @covers BROWSER-01
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { createElement } from 'react';
import { mount, type HostNode } from '../../test/reactHarness';
import { BrowserTabAddress } from './BrowserTabAddress';
import { publishBrowserPaneChrome, __resetBrowserPaneChrome, type BrowserPaneChrome } from '../../state/browserPaneChrome';

const PANE = 'browser:test';
const PDF = '/Users/a/b.pdf';
const REF = `/api/media?path=${encodeURIComponent(PDF)}`;

function chrome(url: string, addressEditRequest: number): BrowserPaneChrome {
  return {
    url,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    consoleErrors: 0,
    consoleWarnings: 0,
    downloads: 0,
    zoom: 100,
    deviceMode: 'desktop',
    shared: false,
    addressEditRequest,
    commands: {},
  };
}

/** The editor's field, if this pass drew it. */
function addressInput(hosts: HostNode[]): HostNode | undefined {
  return hosts.find((h) => h.props['data-testid'] === 'browser-tab-address-input');
}

/** The panel that holds it. */
function dropdown(hosts: HostNode[]): HostNode | undefined {
  return hosts.find((h) => h.props['data-testid'] === 'browser-address-dropdown');
}

afterEach(() => { __resetBrowserPaneChrome(); });

describe('the address editor in the tab', () => {
  it('is seeded with the document, not with the route that serves it', () => {
    publishBrowserPaneChrome(PANE, chrome(`tauri://localhost${REF}`, 0));
    const h = mount(createElement(BrowserTabAddress, { paneId: PANE, label: 'b.pdf' }));
    try {
      expect(addressInput(h.last().hosts)).toBeUndefined();

      // The bump is Cmd+L (or the tab menu's "edit address" entry).
      publishBrowserPaneChrome(PANE, chrome(`tauri://localhost${REF}`, 1));
      expect(addressInput(h.last().hosts)?.props.value).toBe(`file://${PDF}`);
    } finally {
      h.unmount();
    }
  });

  it('leaves an ordinary address alone', () => {
    publishBrowserPaneChrome(PANE, chrome('https://example.com/x?q=1', 0));
    const h = mount(createElement(BrowserTabAddress, { paneId: PANE, label: 'Example' }));
    try {
      publishBrowserPaneChrome(PANE, chrome('https://example.com/x?q=1', 1));
      expect(addressInput(h.last().hosts)?.props.value).toBe('https://example.com/x?q=1');
    } finally {
      h.unmount();
    }
  });

  it('opens a panel of its own, and the tab goes on writing its name', () => {
    publishBrowserPaneChrome(PANE, chrome('https://example.com/x', 0));
    const h = mount(createElement(BrowserTabAddress, { paneId: PANE, label: 'Example Domain' }));
    try {
      expect(dropdown(h.last().hosts)).toBeUndefined();
      expect(h.last().text).toBe('Example Domain');

      publishBrowserPaneChrome(PANE, chrome('https://example.com/x', 1));
      const panel = dropdown(h.last().hosts);
      expect(panel, 'the dropdown is drawn on the bump').toBeDefined();
      // The class the occlusion tracker matches: without it the panel paints
      // UNDER the native webview on the desktop app (lib/shell/browserOcclusion).
      expect(String(panel?.props.className)).toContain('glass-surface');
      // The label is still there: the panel is beside it, not instead of it.
      expect(h.last().text).toBe('Example Domain');
    } finally {
      h.unmount();
    }
  });
});
