import { describe, it, expect } from 'bun:test';
import { parseBrowserWsMessage } from './browser-ws-messages';

// Protocol contract for the two variants added for native-grade streaming:
// `resize` (client -> server) and `download` (server -> client). The Zod union
// is the source of truth — every WS receive boundary validates against it.

describe('browser-ws-messages: resize', () => {
  it('accepts width/height + optional deviceScaleFactor', () => {
    const r = parseBrowserWsMessage({ type: 'resize', width: 800, height: 600, deviceScaleFactor: 2 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ type: 'resize', width: 800, height: 600, deviceScaleFactor: 2 });
  });

  it('accepts resize without deviceScaleFactor', () => {
    expect(parseBrowserWsMessage({ type: 'resize', width: 1024, height: 768 }).ok).toBe(true);
  });

  it('rejects missing / non-positive / out-of-range fields', () => {
    expect(parseBrowserWsMessage({ type: 'resize', height: 600 }).ok).toBe(false); // no width
    expect(parseBrowserWsMessage({ type: 'resize', width: -1, height: 600 }).ok).toBe(false);
    expect(parseBrowserWsMessage({ type: 'resize', width: 800.5, height: 600 }).ok).toBe(false); // non-int
    expect(parseBrowserWsMessage({ type: 'resize', width: 800, height: 600, deviceScaleFactor: 4 }).ok).toBe(false); // >3
    expect(parseBrowserWsMessage({ type: 'resize', width: 800, height: 600, deviceScaleFactor: 0.5 }).ok).toBe(false); // <1
  });
});

describe('browser-ws-messages: download', () => {
  it('accepts a completed download with size', () => {
    const r = parseBrowserWsMessage({ type: 'download', filename: 'report.pdf', href: '/media/browser/downloads/x.pdf', size: 4096, state: 'completed' });
    expect(r.ok).toBe(true);
  });

  it('accepts started/failed without size', () => {
    expect(parseBrowserWsMessage({ type: 'download', filename: 'a', href: '/x', state: 'started' }).ok).toBe(true);
    expect(parseBrowserWsMessage({ type: 'download', filename: 'a', href: '/x', state: 'failed' }).ok).toBe(true);
  });

  it('rejects an unknown state', () => {
    expect(parseBrowserWsMessage({ type: 'download', filename: 'a', href: '/x', state: 'paused' }).ok).toBe(false);
  });
});

describe('browser-ws-messages: set_engine (client -> server)', () => {
  it('accepts native / chromium', () => {
    expect(parseBrowserWsMessage({ type: 'set_engine', engine: 'native' }).ok).toBe(true);
    expect(parseBrowserWsMessage({ type: 'set_engine', engine: 'chromium' }).ok).toBe(true);
  });

  it('rejects an unknown engine or a missing field', () => {
    expect(parseBrowserWsMessage({ type: 'set_engine', engine: 'firefox' }).ok).toBe(false);
    expect(parseBrowserWsMessage({ type: 'set_engine' }).ok).toBe(false);
  });
});

describe('browser-ws-messages: engine (server -> client)', () => {
  it('accepts an engine with an optional extension count', () => {
    const r = parseBrowserWsMessage({ type: 'engine', engine: 'chromium', extensions: 42 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ type: 'engine', engine: 'chromium', extensions: 42 });
    expect(parseBrowserWsMessage({ type: 'engine', engine: 'native' }).ok).toBe(true);
  });

  it('rejects a negative / non-integer extension count', () => {
    expect(parseBrowserWsMessage({ type: 'engine', engine: 'chromium', extensions: -1 }).ok).toBe(false);
    expect(parseBrowserWsMessage({ type: 'engine', engine: 'chromium', extensions: 2.5 }).ok).toBe(false);
  });
});

describe('browser-ws-messages: set_stream (client -> server)', () => {
  it('accepts active true/false', () => {
    expect(parseBrowserWsMessage({ type: 'set_stream', active: false }).ok).toBe(true);
    expect(parseBrowserWsMessage({ type: 'set_stream', active: true }).ok).toBe(true);
  });
  it('rejects a missing / non-boolean active', () => {
    expect(parseBrowserWsMessage({ type: 'set_stream' }).ok).toBe(false);
    expect(parseBrowserWsMessage({ type: 'set_stream', active: 'yes' }).ok).toBe(false);
  });
});

describe('browser-ws-messages: union still discriminates', () => {
  it('parses a frame and rejects an unknown type', () => {
    expect(parseBrowserWsMessage({ type: 'frame', data: 'abc', metadata: { timestamp: 1 } }).ok).toBe(true);
    expect(parseBrowserWsMessage({ type: 'bogus' }).ok).toBe(false);
  });
});
