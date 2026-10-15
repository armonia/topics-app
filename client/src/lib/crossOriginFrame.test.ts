import { describe, expect, test } from 'bun:test';
import { crossOriginFrameHost } from './crossOriginFrame';

/** @covers NATIVE-HOST-09 */
describe('crossOriginFrameHost', () => {
  const page = 'https://shop.example.com/checkout';

  test('ignores a same-origin frame', () => {
    expect(crossOriginFrameHost('https://shop.example.com/embedded', page)).toBeNull();
  });

  test('returns only the host for a different origin', () => {
    expect(crossOriginFrameHost('https://pay.example.net/secure?token=secret', page)).toBe('pay.example.net');
  });

  test('ignores absent, invalid and opaque URLs', () => {
    expect(crossOriginFrameHost(undefined, page)).toBeNull();
    expect(crossOriginFrameHost('not a url', page)).toBeNull();
    expect(crossOriginFrameHost('about:blank', page)).toBeNull();
    expect(crossOriginFrameHost('data:text/html,secret', page)).toBeNull();
  });
});
