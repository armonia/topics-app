/**
 * A non-ok `/api/agent-channels` response must not freeze the cache at `{}`
 * forever.
 *
 * THE DEFECT. `useChannelTitles` cached `body?.titles ?? {}` unconditionally,
 * even when `r.ok` was false (body is `null` in that case). Once a single
 * request failed, `titlesCache` became a permanent `{}` and the `if
 * (titlesCache) return;` guard at the top of the effect skipped every future
 * fetch, on every future mount — nothing ever retried.
 *
 * @covers TITLES-CACHE-01
 */
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import * as React from 'react';
import { mount } from '../test/reactHarness';

const {
  serverHttpBase: realServerHttpBase,
  isAppLoopbackOrigin: realIsAppLoopbackOrigin,
  serverWsBase: realServerWsBase,
  __resetNetShimForTests: realResetNetShim,
  installNetShim: realInstallNetShim,
} = await import('../lib/shell/net');
const realNet = {
  serverHttpBase: realServerHttpBase,
  isAppLoopbackOrigin: realIsAppLoopbackOrigin,
  serverWsBase: realServerWsBase,
  __resetNetShimForTests: realResetNetShim,
  installNetShim: realInstallNetShim,
};

type FakeResponse = { ok: boolean; json?: () => Promise<unknown> };
let queue: FakeResponse[] = [];

mock.module('../lib/shell/net', () => ({
  ...realNet,
  apiFetch: () => Promise.resolve(queue.shift() as unknown as Response),
}));
afterAll(() => { mock.module('../lib/shell/net', () => realNet); });

afterEach(() => { queue = []; });

const { useChannelTitles } = await import('./agentGroups');

function Probe({ onRender }: { onRender: (t: Record<string, string>) => void }): null {
  onRender(useChannelTitles());
  return null;
}

/** Enough microtask turns for the `apiFetch().then().then()` chain to settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

test('a non-ok response does not latch the cache at {} — the next mount still retries', async () => {
  queue.push({ ok: false });
  const seen: Record<string, string>[] = [];
  const first = mount(React.createElement(Probe, { onRender: (t) => seen.push(t) }));
  await flush();
  first.unmount();

  // A real titles payload, waiting for the mount that is about to retry.
  queue.push({ ok: true, json: () => Promise.resolve({ titles: { abc: 'My channel' } }) });
  const second = mount(React.createElement(Probe, { onRender: (t) => seen.push(t) }));
  await flush();
  second.rerender();

  expect(seen[seen.length - 1]).toEqual({ abc: 'My channel' });
});
