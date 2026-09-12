/** @covers GUEST-18 */
import { expect, test } from 'bun:test';
import { installationInviteUrl } from './installationInvite';

test('the installation link contains no pairing code, guest token or secret', () => {
  const url = installationInviteUrl({ enabled: true, baseUrl: 'https://relay.example/', relayId: 'relay one' });
  expect(url).toBe('https://relay.example/i/relay%20one');
  expect(url).not.toContain('token');
  expect(url).not.toContain('key');
});
