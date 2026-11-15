/**
 * THE RESERVE ASKS BEFORE IT IS SPENT.
 *
 * The account engine stops a turn with `reserve_confirmation_required` when only the last subscription is left
 * (hub-service `sb/reserve.rs`). Topics recognises that answer, and only that one, and the yes goes to the
 * engine before the message is sent again: a resend without the yes would stop on the same wall.
 *
 * @covers CHAT-REL-07
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { isReserveStop, confirmReserve, RESERVE_ERROR_TYPE } from './reserveConfirm';

const STOP = `⚠️ API 400: {"type":"error","error":{"type":"${RESERVE_ERROR_TYPE}","message":"Only the reserve is left: reserve@example.test (5% left)."}}`;
const CREDIT = '⚠️ API 400: {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('the reserve stop', () => {
  test('is the engine answer and no other error', () => {
    expect(isReserveStop(STOP)).toBe(true);
    expect(isReserveStop(CREDIT)).toBe(false);
    expect(isReserveStop(null)).toBe(false);
  });

  test('the yes goes to the engine bridge, and only a confirmed answer counts', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') });
      return new Response(JSON.stringify({ ok: true, confirmed: true, until: 1 }), { status: 200 });
    }) as typeof fetch;
    expect(await confirmReserve()).toBe(true);
    expect(calls[0].url).toContain('/api/switchboard/reserve-confirm');
    expect(JSON.parse(calls[0].body)).toEqual({ confirm: true });

    globalThis.fetch = (async () => new Response('{"error":"switchboard not reachable"}', { status: 502 })) as unknown as typeof fetch;
    expect(await confirmReserve()).toBe(false);
  });
});
