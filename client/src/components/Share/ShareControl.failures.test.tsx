/**
 * A REFUSED REMOVAL SAYS SO, IN THE PANEL.
 *
 * «Remove access» and «Revoke link» were a bare try/finally around the DELETE:
 * a refusal left the row standing without a word, and a network error was an
 * unhandled rejection (the handlers are called with `void`). `shareRequest.ts`
 * is tested on its own; this drives the real panel, so putting the old code
 * back in `togli` or `revocaLink` turns it red even with that helper intact.
 *
 * No DOM here (see `test/reactHarness.ts`): the panel is mounted on the hook
 * harness, its buttons are the host nodes it returned, and a click is their
 * own `onClick`.
 *
 * @covers AUTHERR-01
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { mount, type Harness, type HostNode } from '../../test/reactHarness';
import { t as translate } from '../../lib/i18n';

const g = globalThis as unknown as Record<string, unknown>;
const found = { window: g.window, document: g.document, fetch: g.fetch, ResizeObserver: g.ResizeObserver, getComputedStyle: g.getComputedStyle };
afterAll(() => {
  for (const [k, v] of Object.entries(found)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

class MemStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
const listeners = { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };
g.window = {
  ...listeners, innerWidth: 1280, innerHeight: 800, localStorage: new MemStorage(),
  location: { origin: 'https://app.test', href: 'https://app.test/', pathname: '/', search: '', protocol: 'https:' },
  matchMedia: () => ({ matches: false, ...listeners }),
};
// The popover is portalled to <body>: a container is all `createPortal` asks of it.
g.document = { ...listeners, body: { nodeType: 1, ...listeners }, activeElement: null, documentElement: { ...listeners } };
g.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
// `useMobile` reads the safe-area insets off the root's style.
g.getComputedStyle = () => ({ getPropertyValue: () => '' });

const { ShareControl } = await import('./ShareControl');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const deletes: string[] = [];
/** How the next DELETE ends: refused with a code, or the network is down. */
let deleteAnswer: 'refused' | 'offline' = 'refused';

beforeEach(() => {
  deletes.length = 0;
  g.fetch = async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as { url: string }).url;
    if (init?.method === 'DELETE') {
      deletes.push(url);
      if (deleteAnswer === 'offline') throw new TypeError('Failed to fetch');
      return json({ error: 'unknown_device' }, 403);
    }
    if (url.includes('/api/auth/shares')) return json({ shares: [{ subjectType: 'device', subjectId: 'd-1', name: 'Anna', sharedAt: 1, level: 'read' }] });
    if (url.includes('/api/auth/subjects')) return json({ subjects: [] });
    if (url.includes('/api/auth/relay')) return json({ enabled: true, baseUrl: 'https://relay.test', relayId: 'r-1', connected: true });
    if (url.includes('/api/auth/share-links')) return json({ links: [{ ref: 'L-1', expiresAt: Date.now() + 86_400_000, revokedAt: null, openedCount: 0, scaduto: false }] });
    return json({});
  };
});

let h: Harness | null = null;
afterEach(() => { h?.unmount(); h = null; });

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 0));
    h?.rerender();
  }
}
const hosts = (): HostNode[] => h!.last().hosts;
const byLabel = (label: string) => hosts().find((n) => n.props['aria-label'] === label);
const shownError = () => hosts().filter((n) => n.type === 'p' && String(n.props.className).includes('text-red-500')).map((n) => n.props.children);

async function openPanel(): Promise<void> {
  h = mount(createElement(ShareControl, { resourceType: 'topic', resourceId: 'topic-1' }));
  const trigger = hosts().find((n) => n.props['data-testid'] === 'share-control')!;
  (trigger.props.onClick as () => void)();
  await settle();
}

describe('a removal the server refuses, in the share panel', () => {
  test('«Remove access» refused: the panel says why, and the row stays', async () => {
    deleteAnswer = 'refused';
    await openPanel();
    const remove = byLabel(translate('share.removeAccess', 'it', { name: 'Anna' }))!;
    expect(remove).toBeDefined();
    (remove.props.onClick as () => void)();
    await settle();
    expect(deletes.some((u) => u.includes('/api/auth/shares?') && u.includes('subjectId=d-1'))).toBe(true);
    // Before the fix: nothing was written, the panel looked like a click that did nothing.
    expect(shownError()).toEqual([translate('auth.err.unknown_device', 'it')]);
    expect(byLabel(translate('share.removeAccess', 'it', { name: 'Anna' }))).toBeDefined();
  });

  test('«Revoke link» with the network down: the panel says it failed, not an unhandled rejection', async () => {
    deleteAnswer = 'offline';
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    try {
      await openPanel();
      const revoke = byLabel(translate('share.revokeLink', 'it'))!;
      expect(revoke).toBeDefined();
      (revoke.props.onClick as () => void)();
      await settle();
      expect(deletes.some((u) => u.includes('/api/auth/share-links?ref=L-1'))).toBe(true);
      expect(shownError()).toEqual([translate('auth.err.generic', 'it')]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
