/**
 * Protocol contract of the browser pane socket for the two native-grade
 * streaming variants: `resize` (client to server) and `download` (server to client).
 * @covers BROWSER-CHAT-02
 */
import { describe, it, expect } from 'bun:test';
import { parseBrowserWsMessage } from '../shared/browser-ws-messages';

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

// Frame a sé, e non un alias di set_stream: quello è la pausa del transport (il
// WebRTC lo manda mentre guarda eccome), questo è «la mia pane è sullo schermo»
// ed è l'unico ingresso del conteggio spettatori cross-device.
describe('browser-ws-messages: set_watching (client -> server)', () => {
  it('accepts active true/false', () => {
    expect(parseBrowserWsMessage({ type: 'set_watching', active: false }).ok).toBe(true);
    expect(parseBrowserWsMessage({ type: 'set_watching', active: true }).ok).toBe(true);
  });
  it('rejects a missing / non-boolean active', () => {
    expect(parseBrowserWsMessage({ type: 'set_watching' }).ok).toBe(false);
    expect(parseBrowserWsMessage({ type: 'set_watching', active: 'yes' }).ok).toBe(false);
  });
});

describe('browser-ws-messages: set_render (client -> server)', () => {
  it('accepts video / dom', () => {
    expect(parseBrowserWsMessage({ type: 'set_render', mode: 'video' }).ok).toBe(true);
    expect(parseBrowserWsMessage({ type: 'set_render', mode: 'dom' }).ok).toBe(true);
  });
  it('rejects an unknown mode or a missing field', () => {
    expect(parseBrowserWsMessage({ type: 'set_render', mode: 'pixels' }).ok).toBe(false);
    expect(parseBrowserWsMessage({ type: 'set_render' }).ok).toBe(false);
  });
});

describe('browser-ws-messages: render_mode (server -> client)', () => {
  it('accepts video / dom', () => {
    expect(parseBrowserWsMessage({ type: 'render_mode', mode: 'dom' }).ok).toBe(true);
    expect(parseBrowserWsMessage({ type: 'render_mode', mode: 'video' }).ok).toBe(true);
  });
  it('rejects an unknown mode', () => {
    expect(parseBrowserWsMessage({ type: 'render_mode', mode: 'nope' }).ok).toBe(false);
  });
});

describe('browser-ws-messages: dom_event (server -> client)', () => {
  it('accepts an opaque rrweb event untouched (no deep validation)', () => {
    const full = { type: 'dom_event' as const, event: { type: 2, data: { node: { id: 1 } }, timestamp: 111 } };
    const r = parseBrowserWsMessage(full);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual(full);
    // Any JSON payload is allowed — the client's Replayer owns the shape.
    expect(parseBrowserWsMessage({ type: 'dom_event', event: [1, 2, 3] }).ok).toBe(true);
    expect(parseBrowserWsMessage({ type: 'dom_event', event: 'meta' }).ok).toBe(true);
  });
});

describe('browser-ws-messages: focus_field (server -> client)', () => {
  it('accepts the field descriptor the video branch dresses its keyboard with', () => {
    const msg = {
      type: 'focus_field' as const,
      field: { tag: 'input', type: 'email', inputMode: '', enterKeyHint: 'go', inForm: true },
    };
    const r = parseBrowserWsMessage(msg);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual(msg);
  });
  it('accepts it WITHOUT a field: nothing writable took focus', () => {
    expect(parseBrowserWsMessage({ type: 'focus_field' }).ok).toBe(true);
  });
  it('needs a tag when a field is there, and keeps the flags booleans', () => {
    expect(parseBrowserWsMessage({ type: 'focus_field', field: { type: 'email' } }).ok).toBe(false);
    expect(parseBrowserWsMessage({ type: 'focus_field', field: { tag: 'input', disabled: 'si' } }).ok).toBe(false);
  });
});

describe('browser-ws-messages: focus_query (client -> server)', () => {
  it('accepts the bare question the video branch asks after a DataChannel click', () => {
    // Il click non passa più dal server (va sul canale dati della
    // PeerConnection), quindi la lettura del campo a fuoco va chiesta a voce:
    // senza questa variante nell'union il pane resta con la tastiera generica.
    const r = parseBrowserWsMessage({ type: 'focus_query' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ type: 'focus_query' });
  });
});

describe('browser-ws-messages: union still discriminates', () => {
  it('parses a frame and rejects an unknown type', () => {
    expect(parseBrowserWsMessage({ type: 'frame', data: 'abc', metadata: { timestamp: 1 } }).ok).toBe(true);
    expect(parseBrowserWsMessage({ type: 'bogus' }).ok).toBe(false);
  });
});
