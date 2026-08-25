/**
 * @covers BROWSER-DEV-01
 */
import { describe, it, expect } from 'bun:test';
import { DEVICE_PRESETS, deviceModeFromUserAgent, type DeviceMode } from './browserDevTypes';

describe('deviceModeFromUserAgent', () => {
  // The bug this guards: `deviceMode` was component state seeded to 'desktop',
  // while the User-Agent lives on the WKWebView — which outlives the component.
  // browser_open REUSES a live view, a background tab stays mounted, and a ⌘R of
  // the host UI doesn't tear the child webview down at all. Every one of those
  // put the switcher back to Desktop over a view still serving an iPhone UA: the
  // menu said one thing, the site saw another, and nothing on screen said which.

  it('recognises its own presets', () => {
    expect(deviceModeFromUserAgent(DEVICE_PRESETS.mobile.userAgent!)).toBe('mobile');
    expect(deviceModeFromUserAgent(DEVICE_PRESETS.tablet.userAgent!)).toBe('tablet');
  });

  it('reads anything else as desktop', () => {
    expect(deviceModeFromUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)',
    )).toBe('desktop');
    expect(deviceModeFromUserAgent('')).toBe('desktop');
  });

  it('does not confuse the two mobile presets', () => {
    // Both are "Mobile/15E148 Safari", so a substring match on the wrong token
    // would report an iPad as a phone and letterbox it to 390×844.
    expect(deviceModeFromUserAgent(DEVICE_PRESETS.tablet.userAgent!)).not.toBe('mobile');
    expect(deviceModeFromUserAgent(DEVICE_PRESETS.mobile.userAgent!)).not.toBe('tablet');
  });

  it('never claims a mode the page cannot actually report', () => {
    // `custom` (responsive resize) and `auto` set no UA, so they are not
    // recoverable and must not be guessed — the caller keeps its own value.
    const recoverable: DeviceMode[] = ['desktop', 'mobile', 'tablet'];
    for (const ua of ['', 'anything', DEVICE_PRESETS.mobile.userAgent!, DEVICE_PRESETS.tablet.userAgent!]) {
      expect(recoverable).toContain(deviceModeFromUserAgent(ua));
    }
  });
});

describe('DEVICE_PRESETS', () => {
  it('the emulating presets carry a UA — it is the whole of what emulation means here', () => {
    expect(DEVICE_PRESETS.mobile.userAgent).toBeTruthy();
    expect(DEVICE_PRESETS.tablet.userAgent).toBeTruthy();
  });

  it('the pass-through presets carry neither UA nor size', () => {
    for (const p of [DEVICE_PRESETS.desktop, DEVICE_PRESETS.auto]) {
      expect(p.userAgent).toBeUndefined();
      expect(p.width).toBeUndefined();
      expect(p.height).toBeUndefined();
    }
  });

  it('carries no field that nothing reads', () => {
    // `deviceScaleFactor` and `mobile` used to be set on the mobile and tablet
    // presets and read by nobody: WKWebView exposes no way to fake a backing
    // scale factor or a touch pointer from outside the page, so they described
    // an emulation that was not happening. Config you can set and that changes
    // nothing is worse than config that isn't there.
    for (const p of Object.values(DEVICE_PRESETS)) {
      expect(Object.keys(p).sort()).toEqual(
        p.userAgent
          ? ['height', 'label', 'mode', 'userAgent', 'width']
          : ['label', 'mode'],
      );
    }
  });
});
