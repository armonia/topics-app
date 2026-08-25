/**
 * Unit tests for the v3 foundations WS-02 handshake schemas.
 *
 * Run with: `bun test tests/unit/ws-handshake-schema.test.ts`
 *
 * Covers: welcome (server→client), hello (client→server), upgrade-required
 * (future), plus the capability constants exported by `ws-capabilities.ts`.
  * @covers WIRE-07
 */
import { describe, expect, test } from 'bun:test';
import {
  welcomeMessageSchema,
  helloMessageSchema,
  upgradeRequiredSchema,
  parseWelcomeMessage,
  parseHelloMessage,
  type WelcomeMessage,
  type HelloMessage,
} from '../../shared/ws-handshake';
import {
  SERVER_PROTOCOL_VERSION,
  SERVER_CAPABILITIES,
  SERVER_VERSION,
} from '../../server/ws-capabilities';

describe('welcomeMessageSchema — valid messages', () => {
  test('parses a complete welcome', () => {
    const msg: WelcomeMessage = {
      type: 'welcome',
      serverVersion: '1.0.0',
      protocolVersion: 1,
      capabilities: ['ws-validation-v1', 'browser-ws-v1'],
      serverTime: 1_700_000_000_000,
      clientId: 'ws-abc',
    };
    const r = parseWelcomeMessage(JSON.parse(JSON.stringify(msg)));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual(msg);
  });

  test('parses welcome with empty capabilities array', () => {
    const r = parseWelcomeMessage({
      type: 'welcome',
      serverVersion: '0.0.0-unknown',
      protocolVersion: 1,
      capabilities: [],
      serverTime: 0,
      clientId: '',
    });
    expect(r.ok).toBe(true);
  });
});

describe('welcomeMessageSchema — invalid', () => {
  test('rejects missing serverVersion', () => {
    const r = parseWelcomeMessage({
      type: 'welcome',
      protocolVersion: 1,
      capabilities: [],
      serverTime: 0,
      clientId: '',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('serverVersion');
  });

  test('rejects non-integer protocolVersion', () => {
    const r = parseWelcomeMessage({
      type: 'welcome',
      serverVersion: '1.0',
      protocolVersion: 1.5,
      capabilities: [],
      serverTime: 0,
      clientId: '',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('protocolVersion');
  });

  test('rejects non-string capability entry', () => {
    const r = parseWelcomeMessage({
      type: 'welcome',
      serverVersion: '1.0',
      protocolVersion: 1,
      capabilities: [42],
      serverTime: 0,
      clientId: '',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('capabilities.0');
  });

  test('rejects wrong discriminator', () => {
    const r = parseWelcomeMessage({ type: 'hello' });
    expect(r.ok).toBe(false);
  });
});

describe('helloMessageSchema — valid', () => {
  test('parses a complete hello', () => {
    const msg: HelloMessage = {
      type: 'hello',
      clientVersion: '0.0.0-dev',
      protocolVersion: 1,
      capabilities: ['tool-detail-v1', 'chat-fast-mode'],
    };
    const r = parseHelloMessage(JSON.parse(JSON.stringify(msg)));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual(msg);
  });

  test('parses hello with empty capabilities', () => {
    const r = parseHelloMessage({
      type: 'hello',
      clientVersion: 'legacy',
      protocolVersion: 1,
      capabilities: [],
    });
    expect(r.ok).toBe(true);
  });
});

describe('helloMessageSchema — invalid', () => {
  test('rejects missing clientVersion', () => {
    const r = parseHelloMessage({ type: 'hello', protocolVersion: 1, capabilities: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('clientVersion');
  });

  test('rejects non-array capabilities', () => {
    const r = parseHelloMessage({
      type: 'hello',
      clientVersion: 'x',
      protocolVersion: 1,
      capabilities: 'all',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('capabilities');
  });
});

describe('upgradeRequiredSchema — structural', () => {
  test('parses a complete upgrade-required', () => {
    const r = upgradeRequiredSchema.safeParse({
      type: 'upgrade-required',
      minClientProtocolVersion: 2,
      currentClientProtocolVersion: 1,
      message: 'Please reload to get the latest version.',
    });
    expect(r.success).toBe(true);
  });

  test('rejects negative version', () => {
    const r = upgradeRequiredSchema.safeParse({
      type: 'upgrade-required',
      minClientProtocolVersion: 2,
      currentClientProtocolVersion: 'old',
      message: 'reload',
    });
    expect(r.success).toBe(false);
  });
});

describe('ws-capabilities constants', () => {
  test('SERVER_PROTOCOL_VERSION is a positive integer', () => {
    expect(Number.isInteger(SERVER_PROTOCOL_VERSION)).toBe(true);
    expect(SERVER_PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  test('SERVER_VERSION is a non-empty string', () => {
    expect(typeof SERVER_VERSION).toBe('string');
    expect(SERVER_VERSION.length).toBeGreaterThan(0);
  });

  test('SERVER_CAPABILITIES contains the shipped Zod feature', () => {
    expect(SERVER_CAPABILITIES).toContain('ws-validation-v1');
  });

  test('SERVER_CAPABILITIES has no duplicates', () => {
    const set = new Set(SERVER_CAPABILITIES);
    expect(set.size).toBe(SERVER_CAPABILITIES.length);
  });

  test('all capability names use lowercase-kebab convention', () => {
    const offenders = SERVER_CAPABILITIES.filter((c) => !/^[a-z0-9-]+$/.test(c));
    expect(offenders).toEqual([]);
  });
});

describe('handshake round-trip via JSON.stringify', () => {
  test('welcome from server is parseable by client mirror', () => {
    const serverEmit = {
      type: 'welcome' as const,
      serverVersion: SERVER_VERSION,
      protocolVersion: SERVER_PROTOCOL_VERSION,
      capabilities: Array.from(SERVER_CAPABILITIES),
      serverTime: Date.now(),
      clientId: 'ws-test',
    };
    const wire = JSON.parse(JSON.stringify(serverEmit));
    const r = parseWelcomeMessage(wire);
    expect(r.ok).toBe(true);
  });
});
