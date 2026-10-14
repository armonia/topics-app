/**
 * The global feed is revalidated, not re-downloaded.
 *
 * The desktop app re-read `GET /api/all-boards/tasks` every 5 s for days with
 * no card moving (720 reads an hour of ~155 KB, server log 13-14/10). A network
 * read now sends the last ETag back and, on 304, hands out the rows it already
 * holds: the same array, so the store's diff stops at the first identity check.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { __resetFeedRevalidation, boardApi, type BoardTask } from './board';

const realFetch = globalThis.fetch;
let sent: { url: string; ifNoneMatch: string | null }[] = [];
let replies: Response[] = [];

function feed(etag: string, texts: string[]): Response {
  const tasks = texts.map((text, i) => ({ id: `t${i}`, text }));
  return new Response(JSON.stringify({ tasks }), { status: 200, headers: { ETag: etag, 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  __resetFeedRevalidation();
  sent = [];
  replies = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    sent.push({ url: String(input), ifNoneMatch: headers.get('If-None-Match') });
    const next = replies.shift();
    if (!next) throw new Error('no reply queued');
    return next;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('boardApi.listAll revalidation', () => {
  test('a 304 hands back the very rows of the last 200', async () => {
    replies.push(feed('"a1"', ['one', 'two']));
    const first = await boardApi.listAll();
    expect(sent[0]!.ifNoneMatch).toBeNull();

    replies.push(new Response(null, { status: 304, headers: { ETag: '"a1"' } }));
    const second = await boardApi.listAll();
    expect(sent[1]!.ifNoneMatch).toBe('"a1"');
    expect(second).toBe(first as BoardTask[]);
  });

  test('a changed feed replaces the held rows and their ETag', async () => {
    replies.push(feed('"a1"', ['one']));
    await boardApi.listAll();
    replies.push(feed('"b2"', ['one', 'new card']));
    const changed = await boardApi.listAll();
    expect(changed.map((t) => t.text)).toEqual(['one', 'new card']);

    replies.push(new Response(null, { status: 304, headers: { ETag: '"b2"' } }));
    await boardApi.listAll();
    expect(sent[2]!.ifNoneMatch).toBe('"b2"');
  });

  test('boot reads and filtered reads never revalidate', async () => {
    replies.push(feed('"a1"', ['one']));
    await boardApi.listAll();
    replies.push(feed('"a1"', ['one']));
    await boardApi.listAll('todo');
    expect(sent[1]!.url).toContain('?status=todo');
    expect(sent[1]!.ifNoneMatch).toBeNull();
  });

  test('a failed read keeps throwing, and the next read still revalidates', async () => {
    replies.push(feed('"a1"', ['one']));
    const held = await boardApi.listAll();
    replies.push(new Response(JSON.stringify({ error: 'boom' }), { status: 500 }));
    await expect(boardApi.listAll()).rejects.toThrow('boom');
    replies.push(new Response(null, { status: 304, headers: { ETag: '"a1"' } }));
    expect(await boardApi.listAll()).toBe(held);
  });
});
