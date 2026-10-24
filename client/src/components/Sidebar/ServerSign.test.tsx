/**
 * The server sign on a chat's sidebar row: amber, and saying it in its title,
 * when one of the chat's servers can be opened from other devices (BGVIS-08).
 * On 24/10 the finance chat's server listened on 0.0.0.0:8777 and the sign
 * looked the same as for one on the loopback.
 *
 * Mounted with `test/reactHarness` (no DOM in this repo).
 *
 * @covers BGVIS-08
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { mount, type Harness } from '../../test/reactHarness';
import { ServerSign } from './ServerSign';
import type { RunningServiceSummary } from '../../../../shared/background-work';

let harness: Harness | null = null;
afterEach(() => { harness?.unmount(); harness = null; });

const server = (host: string, port: number): RunningServiceSummary => ({
  processId: `p${port}`, description: 'server', command: 'python3 -m http.server', listen: [{ host, port }],
});

function sign(services: RunningServiceSummary[]) {
  harness = mount(createElement(ServerSign, { services, onFill: false }));
  return harness.last().hosts.find((n) => n.props['data-testid'] === 'row-server-sign');
}

describe('the server sign on the sidebar row', () => {
  test('a server on every interface turns it amber and its title says LAN', () => {
    const s = sign([server('127.0.0.1', 8781), server('*', 8777)])!;
    expect(s.props['data-lan']).toBe('true');
    expect(String(s.props.className)).toContain('text-amber-600');
    expect(String(s.props.title)).toContain('LAN');
    expect(String(s.props.title)).toContain('0.0.0.0:8777');
  });

  test('the title names the address open to the network, also when it is not the first', () => {
    const s = sign([{ ...server('127.0.0.1', 5173), listen: [{ host: '127.0.0.1', port: 5173 }, { host: '*', port: 24678 }] }])!;
    expect(s.props['data-lan']).toBe('true');
    expect(String(s.props.title)).toContain('0.0.0.0:24678');
    expect(String(s.props.title)).not.toContain('127.0.0.1:5173');
  });

  test('servers on the loopback only: the quiet sign, no LAN', () => {
    const s = sign([server('127.0.0.1', 8781), server('[::1]', 8782)])!;
    expect(s.props['data-lan']).toBeUndefined();
    expect(String(s.props.className)).not.toContain('amber');
    expect(String(s.props.title)).not.toContain('LAN');
  });
});
