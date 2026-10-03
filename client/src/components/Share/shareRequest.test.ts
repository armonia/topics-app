/**
 * Every write of the share panel reports its failure the same way.
 *
 * Revoking a link and removing an access used to be a bare try/finally around
 * the DELETE: a 4xx/5xx was ignored and a network error became an unhandled
 * rejection (both are called with `void`), so the row stayed and the person saw
 * nothing. They now go through the same reader as «share».
 *
 * @covers AUTHERR-01
 */
import { describe, expect, test } from 'bun:test';
import { shareRequestError } from './shareRequest';

const json = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('shareRequestError', () => {
  test('a successful write has no error', async () => {
    expect(await shareRequestError(json(200, { ok: true }))).toBeNull();
  });

  test('a refusal is read off the body code', async () => {
    expect(await shareRequestError(json(403, { error: 'device_not_guest' }))).toBe('auth.err.device_not_guest');
  });

  test('a refusal without a JSON body is still an error', async () => {
    const key = await shareRequestError(async () => new Response('<html>502</html>', { status: 502 }));
    expect(key).toBe('auth.err.generic');
  });

  test('a network failure is an error, not a rejection', async () => {
    const key = await shareRequestError(async () => { throw new TypeError('Failed to fetch'); });
    expect(key).toBe('auth.err.generic');
  });
});
