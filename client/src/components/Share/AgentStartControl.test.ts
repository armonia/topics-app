/**
 * A REMOTE GRANT WHOSE REQUEST FAILED DOES NOT LEAVE AN INERT CAPABILITY.
 *
 * Granting to a remote computer is two writes: the capability, then the
 * delegated request that carries it to the other machine. When the second one
 * failed, the first stayed: on the next load it showed up as granted, with no
 * request row (so no code and no «Reissue»), and on the remote computer it did
 * nothing. The grant now revokes the capability it just created. Driven
 * through the real control; only the network is faked.
 *
 * @covers GUEST-17
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { mount, type Harness } from '../../test/reactHarness';
import { AgentStartControl } from './AgentStartControl';

const realFetch = globalThis.fetch;
const g = globalThis as unknown as Record<string, unknown>;
const BROWSER_KEYS = ['window', 'document', 'getComputedStyle'] as const;
const saved: Record<string, unknown> = {};
let harness: Harness | null = null;
// The Select inside the form reads `useMobile`: the least of a desktop window.
beforeEach(() => {
  for (const k of BROWSER_KEYS) saved[k] = g[k];
  g.window = { addEventListener() {}, removeEventListener() {}, innerWidth: 1280, innerHeight: 800 };
  g.document = { documentElement: {} };
  g.getComputedStyle = () => ({ getPropertyValue: () => '' });
});
afterEach(() => {
  harness?.unmount(); harness = null; globalThis.fetch = realFetch;
  for (const k of BROWSER_KEYS) { if (saved[k] === undefined) delete g[k]; else g[k] = saved[k]; }
});

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

const INVENTORY = {
  capabilities: [],
  computers: [{
    id: 'm1', name: 'Remote', repositoryName: 'repo', remote: true, available: true,
    modelSupport: 'verified', models: [{ id: 'claude-opus-5' }],
  }],
  recommendedModel: 'claude-opus-5',
  efforts: ['high'],
  durationsMinutes: [30],
};

describe('AgentStartControl · remote grant', () => {
  test('a failed delegated request revokes the capability it followed', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      seen.push(`${method} ${url}`);
      if (url.startsWith('/api/auth/agent-start-capabilities')) {
        if (method === 'POST') return json({ capability: { id: 'cap1' } });
        if (method === 'DELETE') return json({ ok: true });
        return json(INVENTORY);
      }
      if (url === '/api/machines/delegated-requests' && method === 'POST') return json({ error: 'down' }, 503);
      return json({ error: 'not here' }, 404);
    }) as unknown as typeof fetch;

    harness = mount(React.createElement(AgentStartControl, {
      projectId: 'p1', subjects: [{ subjectType: 'person', subjectId: 'u1', name: 'Anna' }],
    }));
    await settle();
    const buttons = () => harness!.last().hosts.filter((h) => h.type === 'button');
    // Open the form: the only button before it is open.
    (buttons()[0]!.props.onClick as () => void)();
    await settle();
    const box = harness.last().hosts.find((h) => h.type === 'input' && h.props.type === 'checkbox')!;
    (box.props.onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    const confirm = buttons().find((h) => String(h.props.className).includes('bg-violet-600'))!;
    (confirm.props.onClick as () => void)();
    await settle();

    expect(confirm.props.disabled).toBe(false);
    expect(seen).toContain('POST /api/machines/delegated-requests');
    expect(seen.some((s) => s.startsWith('DELETE /api/auth/agent-start-capabilities') && s.includes('capabilityId=cap1'))).toBe(true);
  });
});
