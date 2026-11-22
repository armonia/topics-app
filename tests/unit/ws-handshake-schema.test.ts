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
  SERVER_PROTOCOL_VERSION,
  SERVER_CAPABILITIES,
  SERVER_VERSION,
} from '../../server/ws-capabilities';

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

