/**
 * The hub's machines among the devices: which rows are kept, which hub paths
 * an action may reach, and that a hub that does not answer reads as "no rows".
 * `fetch` is replaced in place, so nothing reaches a real hub.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { bridgePath, readHubMachines, remoteHubMachines, runHubMachineAction } from './hubMachines';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const pc = { id: 'pc', name: 'PC', local: false, state: 'dorme', level: 0, on: false };
const hz = { id: 'hetzner', name: 'Server Hetzner', local: false, kind: 'cloud', state: 'spento', level: 0, on: false, spend: { eur: 3.83, cap: 20, warn: 15, over: false } };

describe('remoteHubMachines', () => {
  test('drops the local Mac (already "this computer") and anything malformed', () => {
    const mac = { id: 'local', name: 'MacBook', local: true, state: 'ok', level: 0 };
    expect(remoteHubMachines([mac, pc, hz, null, { id: 3 }]).map((m) => m.id)).toEqual(['pc', 'hetzner']);
    expect(remoteHubMachines({ not: 'a list' })).toEqual([]);
  });
});

describe('bridgePath', () => {
  test('a hub path goes through the bridge, nothing else does', () => {
    expect(bridgePath('/api/hetzner/spegni')).toBe('/api/hub/hetzner/spegni');
    expect(bridgePath('https://evil.example/api/x')).toBeNull();
    expect(bridgePath('/api/../auth/devices')).toBeNull();
    expect(bridgePath('/api//x')).toBeNull();
    expect(bridgePath('/other/x')).toBeNull();
  });
});

describe('reading and acting', () => {
  test('a hub that is down is null, not an empty list', async () => {
    globalThis.fetch = (async () => new Response('{"error":"hub not reachable"}', { status: 502 })) as unknown as typeof fetch;
    expect(await readHubMachines()).toBeNull();
  });

  test('the list comes from /api/hub/machines', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => { seen.push(String(input)); return new Response(JSON.stringify([pc, hz])); }) as unknown as typeof fetch;
    expect((await readHubMachines())?.map((m) => m.id)).toEqual(['pc', 'hetzner']);
    expect(seen[0]).toContain('/api/hub/machines');
  });

  test('an action POSTs through the bridge and reports the hub refusal', async () => {
    const seen: { url: string; method?: string }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), method: init?.method });
      return new Response('{"error":"spegnimento non riuscito"}', { status: 502 });
    }) as unknown as typeof fetch;
    const why = await runHubMachineAction({ id: 'spegni', label: 'Spegni tutti', url: '/api/hetzner/spegni' });
    expect(why).toBe('spegnimento non riuscito');
    expect(seen[0].url).toContain('/api/hub/hetzner/spegni');
    expect(seen[0].method).toBe('POST');
    expect(await runHubMachineAction({ id: 'x', label: 'x', url: '/elsewhere' })).toBe('invalid action path');
  });
});
