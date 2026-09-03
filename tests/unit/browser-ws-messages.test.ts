/**
 * Unit tests for the browser WS message Zod schema (server side).
 *
 * Run with: `bun test tests/unit/browser-ws-messages.test.ts`
 *
 * Pure module (Zod runtime + types), no DB / no fs / no spawn.
 *
 * Scope: validates that every protocol variant round-trips, that malformed
 * payloads are rejected with a useful error message, and that unknown
 * discriminator values fail. This is the WS-01 contract test from the
 * v3 foundations roadmap (`/.planning/ROADMAP_v3_FOUNDATIONS.md`) —
 * extending main without merging the abandoned branch.
  * @covers WIRE-07
 */
import { describe, expect, test } from 'bun:test';
import {
  browserWsMessageSchema,
  parseBrowserWsMessage,
  isBrowserWsMessage,
  type BrowserWsMessage,
} from '../../shared/browser-ws-messages';

describe('browserWsMessageSchema — valid round-trips', () => {
  const validMessages: BrowserWsMessage[] = [
    {
      type: 'frame',
      data: 'base64payload',
      metadata: { timestamp: 1_700_000_000_000 },
    },
    {
      type: 'frame',
      data: '',
      metadata: {
        timestamp: 0,
        pageScaleFactor: 2,
        deviceWidth: 1920,
        deviceHeight: 1080,
      },
    },
    { type: 'input', action: 'click', payload: { x: 10, y: 20 } },
    { type: 'input', action: 'type', payload: { text: 'hello' } },
    { type: 'input', action: 'scroll', payload: { deltaX: 0, deltaY: 100 } },
    {
      type: 'input',
      action: 'mousemove',
      payload: { x: 5, y: 5, button: 'left' },
    },
    { type: 'input', action: 'keypress', payload: { key: 'Enter' } },
    { type: 'nav', url: 'https://example.com', phase: 'request' },
    { type: 'nav', url: 'https://example.com', phase: 'response' },
    { type: 'agent_active', active: true },
    { type: 'agent_active', active: false },
    { type: 'console', level: 'log', text: 'hello' },
    { type: 'console', level: 'warn', text: 'careful' },
    { type: 'console', level: 'error', text: 'boom' },
    { type: 'take_control' },
  ];

  for (const msg of validMessages) {
    test(`parses ${msg.type}${'action' in msg ? `/${msg.action}` : ''} round-trip via JSON`, () => {
      const json = JSON.stringify(msg);
      const back = JSON.parse(json);
      const result = parseBrowserWsMessage(back);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toEqual(msg);
      }
    });
  }
});

describe('parseBrowserWsMessage — malformed payloads', () => {
  test('rejects non-object values', () => {
    expect(parseBrowserWsMessage(null).ok).toBe(false);
    expect(parseBrowserWsMessage(undefined).ok).toBe(false);
    expect(parseBrowserWsMessage(42).ok).toBe(false);
    expect(parseBrowserWsMessage('frame').ok).toBe(false);
    expect(parseBrowserWsMessage([]).ok).toBe(false);
  });

  test('rejects unknown discriminator', () => {
    const result = parseBrowserWsMessage({ type: 'nonsense', x: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('type');
    }
  });

  test('rejects missing required field on frame', () => {
    const result = parseBrowserWsMessage({ type: 'frame', data: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('metadata');
    }
  });

  test('rejects wrong literal on nav.phase', () => {
    const result = parseBrowserWsMessage({
      type: 'nav',
      url: 'https://x',
      phase: 'pending',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('phase');
    }
  });

  test('rejects wrong literal on input.action', () => {
    const result = parseBrowserWsMessage({
      type: 'input',
      action: 'teleport',
      payload: {},
    });
    expect(result.ok).toBe(false);
  });

  test('rejects wrong type on agent_active.active', () => {
    const result = parseBrowserWsMessage({ type: 'agent_active', active: 'yes' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('active');
    }
  });

  test('rejects wrong button enum on input.payload.button', () => {
    const result = parseBrowserWsMessage({
      type: 'input',
      action: 'click',
      payload: { x: 0, y: 0, button: 'side' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('button');
    }
  });

  test('rejects wrong console level enum', () => {
    const result = parseBrowserWsMessage({
      type: 'console',
      level: 'fatal',
      text: 'boom',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('level');
    }
  });

  test('error message preserves dotted path for nested issues', () => {
    const result = parseBrowserWsMessage({
      type: 'frame',
      data: 'x',
      metadata: { timestamp: 'soon' }, // wrong type, should be number
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('metadata.timestamp');
    }
  });
});

describe('isBrowserWsMessage — backward-compat boolean guard', () => {
  test('returns true for valid messages', () => {
    expect(isBrowserWsMessage({ type: 'take_control' })).toBe(true);
    expect(
      isBrowserWsMessage({ type: 'agent_active', active: true }),
    ).toBe(true);
  });

  test('returns false for invalid messages', () => {
    expect(isBrowserWsMessage(null)).toBe(false);
    expect(isBrowserWsMessage({ type: 'frame' })).toBe(false); // missing fields
    expect(isBrowserWsMessage({ type: 'unknown' })).toBe(false);
  });

  test('narrows the type on true', () => {
    const value: unknown = { type: 'agent_active', active: false };
    if (isBrowserWsMessage(value)) {
      // If the type-guard works, this compiles without `as`.
      const _msg: BrowserWsMessage = value;
      expect(_msg.type).toBe('agent_active');
    }
  });
});

/**
 * `zod` espone le varianti su `.options`, `zod/mini` sotto `.def.options`: lo
 * schema condiviso è in mini (finisce nel bundle client).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function variantsOf(schema: any): any[] {
  return schema.options ?? schema.def?.options ?? [];
}

describe('schema completeness', () => {
  test('all 21 protocol variants are present', () => {
    // Snapshot test: if a new variant is added to the schema, this count
    // must be updated — forcing the test author to also document it.
    // Grew from 6 → 17 with the server↔pane co-browse control channel
    // (resize, download, engine toggle, stream/render toggles, rrweb
    // dom_event, and the WebRTC transport trio), then 18 with `set_watching`
    // (is this pane on screen — the cross-device viewer count's only input,
    // deliberately NOT set_stream), poi 19 con `focus_field` (che campo ha
    // preso il fuoco nella pagina remota dopo il click: sul ramo video è
    // l'unico modo di sapere quale tastiera far aprire al telefono), e 20 con
    // `focus_query`, che quella stessa lettura la CHIEDE: da quando l'input
    // del ramo video viaggia sul DataChannel il click non passa più dal
    // server, e agganciata al click la lettura non partiva più. See the
    // frozen literal list in tests/unit/ws-contract.test.ts for the
    // per-variant rationale.
    const variantCount = variantsOf(browserWsMessageSchema).length;
    expect(variantCount).toBe(21);
  });

  test('every variant uses a unique `type` literal', () => {
    const literals = variantsOf(browserWsMessageSchema).map((opt) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shape: any = (opt as any).shape ?? (opt as any).def?.shape;
      // `zod` mette il valore su `.value`, `zod/mini` in `.def.values[0]`.
      return shape.type.def?.values?.[0] ?? shape.type.value;
    });
    const unique = new Set(literals);
    expect(unique.size).toBe(literals.length);
    expect(unique).toEqual(
      new Set([
        'frame', 'input', 'nav', 'agent_active', 'console', 'take_control',
        'resize', 'download', 'set_engine', 'engine', 'set_stream',
        'set_watching', 'set_render', 'render_mode', 'dom_event',
        'webrtc_offer', 'webrtc_answer', 'webrtc_ice', 'focus_field',
        'focus_query', 'viewers',
      ]),
    );
  });
});
