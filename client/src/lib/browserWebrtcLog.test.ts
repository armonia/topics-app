import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logBrowserTransport } from './browserWebrtcLog';

/** @covers WEBRTC-02 */

describe('browser WebRTC diagnostics', () => {
  it('writes one line for offer, connection, and fallback', () => {
    const lines: string[] = [];
    for (const event of ['offer', 'connected', 'fallback'] as const) {
      logBrowserTransport(event, 'ctx-1', (line) => lines.push(line));
    }
    expect(lines).toEqual([
      '[browser ctx-1] webrtc offer',
      '[browser ctx-1] webrtc connected',
      '[browser ctx-1] webrtc fallback',
    ]);
  });

  it('is called at the offer, connected state, and exhausted retry path', () => {
    const hook = readFileSync(join(import.meta.dir, '..', 'hooks', 'useRemoteBrowser.ts'), 'utf8');
    for (const event of ['offer', 'connected', 'fallback']) {
      expect(hook).toContain(`logBrowserTransport('${event}', contextId)`);
    }
  });
});
