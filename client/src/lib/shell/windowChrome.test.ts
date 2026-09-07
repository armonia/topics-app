/**
 * The one value three surfaces read, and the override that makes it measurable.
 *
 * @covers WINCTL-02
 */
import { describe, test, expect } from 'bun:test';
import { resolveWindowChrome } from './windowChrome';

const web = { search: '', tauri: false, tauriWindows: false, platform: 'MacIntel' };

describe('windowChrome', () => {
  test('a plain browser has no chrome to make room for, even on a Mac', () => {
    expect(resolveWindowChrome(web)).toBe('none');
  });

  test('the Tauri shell answers by platform', () => {
    expect(resolveWindowChrome({ ...web, tauri: true })).toBe('mac');
    expect(resolveWindowChrome({ ...web, tauri: true, tauriWindows: true, platform: 'Win32' })).toBe('windows');
    expect(resolveWindowChrome({ ...web, tauri: true, platform: 'Linux x86_64' })).toBe('none');
  });

  test('the URL override wins, so the geometry can be measured from a browser', () => {
    expect(resolveWindowChrome({ ...web, search: '?windowChrome=mac' })).toBe('mac');
    expect(resolveWindowChrome({ ...web, search: '?a=1&windowChrome=windows' })).toBe('windows');
    expect(resolveWindowChrome({ ...web, tauri: true, search: '?windowChrome=none' })).toBe('none');
  });

  test('an unknown override is ignored, not trusted', () => {
    expect(resolveWindowChrome({ ...web, tauri: true, search: '?windowChrome=linux' })).toBe('mac');
  });
});
