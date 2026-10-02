/**
 * THE THREE RAW-TEXT READS REFUSE LIKE EVERY OTHER CALL.
 *
 * `filesApi.content`, `gitApi.diff` and `gitApi.show` read a body as text, so
 * they cannot go through `request()`, and their error path threw the raw body:
 * the editor and the file pane showed `{"error":"Failed to read file: ..."}`
 * to the person instead of the sentence. They now read it with
 * `readErrorBody`, like `request()`.
 *
 * @covers FILES-01
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ApiError, filesApi, gitApi } from './api';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function refuse() {
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ error: 'Failed to read file: nope', code: 'read_failed' }),
    { status: 500, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch;
}

async function errorOf(p: Promise<unknown>): Promise<ApiError> {
  try { await p; } catch (e) { return e as ApiError; }
  throw new Error('expected a rejection');
}

describe('raw-text reads · the refusal is the sentence, not the JSON', () => {
  const calls: [string, () => Promise<unknown>][] = [
    ['filesApi.content', () => filesApi.content('/x/a.ts')],
    ['gitApi.diff', () => gitApi.diff('/x', 'a.ts')],
    ['gitApi.show', () => gitApi.show('/x', 'a.ts', 'HEAD')],
  ];
  for (const [name, call] of calls) {
    test(name, async () => {
      refuse();
      const err = await errorOf(call());
      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(500);
      expect(err.message).toBe('Failed to read file: nope');
      expect(err.code).toBe('read_failed');
    });
  }
});
