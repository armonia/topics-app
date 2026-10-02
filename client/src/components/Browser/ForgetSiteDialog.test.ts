/**
 * A FAILED «forget this site» must not look like a done one.
 *
 * The confirm used to swallow the rejection (`.catch(() => 0)`) and then reload
 * the pane and close the dialog exactly as on success: the person believed the
 * cookies and the session of the site were gone while they were still on disk.
 * Driven through the real dialog; only the data backend is faked.
 *
 * @covers BROWSER-FORGET-01
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { mount, type Harness } from '../../test/reactHarness';
import { ForgetSiteDialog } from './ForgetSiteDialog';
import type { SiteDataBackend } from '../../lib/browserForgetSite';

let harness: Harness | null = null;
// The modal hook under ConfirmDialog reads `document.activeElement` and binds
// Escape on `window`: the least of both, put back after every case so the
// next file in the same process meets what it found.
const g = globalThis as unknown as Record<string, unknown>;
const saved = { document: g.document, window: g.window };
beforeEach(() => {
  g.document = { activeElement: null, body: {}, documentElement: { classList: { contains: () => false } } };
  g.window = { addEventListener() {}, removeEventListener() {}, setTimeout };
});
afterEach(() => {
  harness?.unmount(); harness = null;
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete g[k]; else g[k] = v; }
});

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

function drive(forget: SiteDataBackend['forget']) {
  const calls = { forgotten: 0, closed: 0 };
  const backend: SiteDataBackend = {
    records: async () => ({ supported: true, records: [{ displayName: 'example.com', types: ['Cookies'] }] }),
    forget,
  };
  const onClose = () => { calls.closed++; };
  harness = mount(React.createElement(ForgetSiteDialog, {
    contextId: 'c1', url: 'https://example.com/', backend, onClose, onForgotten: () => { calls.forgotten++; },
  }));
  const confirm = () => {
    const buttons = harness!.last().hosts.filter((h) => h.type === 'button');
    (buttons[buttons.length - 1]!.props.onClick as () => void)();
  };
  return { calls, confirm };
}

describe('ForgetSiteDialog · the outcome of the deletion', () => {
  test('a rejected deletion keeps the dialog open and says so', async () => {
    const { calls, confirm } = drive(async () => { throw new Error('forget-site 500'); });
    await settle();
    confirm();
    await settle();
    expect(calls.forgotten).toBe(0);
    expect(calls.closed).toBe(0);
    expect(harness!.last().hosts.some((h) => h.props['data-testid'] === 'forget-site-error')).toBe(true);
  });

  test('a deletion that succeeds reloads the pane and closes', async () => {
    const { calls, confirm } = drive(async () => 1);
    await settle();
    confirm();
    await settle();
    expect(calls.forgotten).toBe(1);
    expect(calls.closed).toBe(1);
  });
});
