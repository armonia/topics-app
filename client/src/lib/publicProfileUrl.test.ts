/**
 * @covers PUBLIC-PROFILE-URL-01
 */
import { describe, test, expect } from 'bun:test';
import { publicProfileUrl } from './publicProfileUrl';

/**
 * UNDER THE DESKTOP SHELL THE PAGE ORIGIN IS NOT AN ADDRESS.
 *
 * «Copy link» built the public profile URL from `window.location.origin` with
 * no desktop branch. Under Tauri - the primary shell - that origin is
 * `tauri://localhost` on macOS and `http://tauri.localhost` elsewhere, so the
 * clipboard got `tauri://localhost/public/profile/<token>`: not reachable from
 * any network, not even a URL a browser opens, while the line underneath
 * promised «reachable on the local network».
 *
 * The fix is not a nicer string: it is falling back to the address the server
 * actually answers on, and saying how far that address travels.
 */
describe('the public profile URL', () => {
  const relayOff = { enabled: false, baseUrl: null, relayId: null };

  test('macOS shell: tauri://localhost falls back to the server http origin', () => {
    const r = publicProfileUrl('tauri://localhost', 'http://127.0.0.1:13333', relayOff, 'abc');
    expect(r.url).toBe('http://127.0.0.1:13333/public/profile/abc');
    expect(r.reach).toBe('thisComputer');
    expect(r.shareable).toBe(false);
  });

  test('Windows/Linux shell: http://tauri.localhost is not an address either', () => {
    const r = publicProfileUrl('http://tauri.localhost', 'http://127.0.0.1:13333', relayOff, 'abc');
    expect(r.url).toBe('http://127.0.0.1:13333/public/profile/abc');
    expect(r.reach).toBe('thisComputer');
  });

  test('browser on the LAN: the page origin is kept, and it is local-network only', () => {
    const r = publicProfileUrl('http://192.168.1.20:3333', '', relayOff, 'abc');
    expect(r.url).toBe('http://192.168.1.20:3333/public/profile/abc');
    expect(r.reach).toBe('lan');
    expect(r.shareable).toBe(false);
  });

  test('browser on the same machine: loopback is not the local network', () => {
    const r = publicProfileUrl('http://localhost:3333', '', relayOff, 'abc');
    expect(r.reach).toBe('thisComputer');
  });

  test('relay on: it wins over any local origin, and it is shareable', () => {
    const r = publicProfileUrl(
      'tauri://localhost',
      'http://127.0.0.1:13333',
      { enabled: true, baseUrl: 'https://relay.example', relayId: 'r1' },
      'abc',
    );
    expect(r.url).toBe('https://relay.example/i/r1/public/profile/abc');
    expect(r.reach).toBe('public');
    expect(r.shareable).toBe(true);
  });

  test('not published yet: no URL, but the base is still there to show', () => {
    const r = publicProfileUrl('tauri://localhost', 'http://127.0.0.1:13333', relayOff, null);
    expect(r.url).toBeNull();
    expect(r.base).toBe('http://127.0.0.1:13333/public/profile');
  });
});
