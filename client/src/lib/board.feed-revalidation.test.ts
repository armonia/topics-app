/**
 * The global feed is revalidated, not re-downloaded.
 *
 * Every open window re-reads `GET /api/all-boards/tasks` (~155 KB) on task
 * events, reconnects and returns to view, up to 70 times an hour (server log
 * 13-14/10). A network
 * read now sends the last ETag back and, on 304, hands out the rows it already
 * holds: the same array, so the store's diff stops at the first identity check.
 *
 * @covers KANBAN-98
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { __resetFeedRevalidation, boardApi, type BoardTask } from './board';

const realFetch = globalThis.fetch;
let sent: { url: string; ifNoneMatch: string | null }[] = [];
let queue: Response[] = [];

function feed(tag: string, texts: string[]): Response {
  const tasks = texts.map((text, i) => ({ id: `t${i}`, text }));
  return new Response(JSON.stringify({ tasks }), { status: 200, headers: { ETag: tag, 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  __resetFeedRevalidation();
  sent = [];
  queue = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    sent.push({ url: String(input), ifNoneMatch: headers.get('If-None-Match') });
    const next = queue.shift();
    if (!next) throw new Error('no reply queued');
    return next;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('boardApi.listAll revalidation', () => {
  test('a 304 hands back the very rows of the last 200', async () => {
    queue.push(feed('"a1"', ['one', 'two']));
    const first = await boardApi.listAll();
    expect(sent[0]!.ifNoneMatch).toBeNull();

    queue.push(new Response(null, { status: 304, headers: { ETag: '"a1"' } }));
    const second = await boardApi.listAll();
    expect(sent[1]!.ifNoneMatch).toBe('"a1"');
    expect(second).toBe(first as BoardTask[]);
  });

  test('a changed feed replaces the held rows and their ETag', async () => {
    queue.push(feed('"a1"', ['one']));
    await boardApi.listAll();
    queue.push(feed('"b2"', ['one', 'new card']));
    const changed = await boardApi.listAll();
    expect(changed.map((t) => t.text)).toEqual(['one', 'new card']);

    queue.push(new Response(null, { status: 304, headers: { ETag: '"b2"' } }));
    await boardApi.listAll();
    expect(sent[2]!.ifNoneMatch).toBe('"b2"');
  });

  test('a boot read seeds the ETag, so the first re-read after a boot is a 304', async () => {
    queue.push(feed('"a1"', ['one']));
    const boot = await boardApi.listAll(undefined, { ttlMs: 2000 });
    expect(sent[0]!.ifNoneMatch).toBeNull();

    queue.push(new Response(null, { status: 304, headers: { ETag: '"a1"' } }));
    expect(await boardApi.listAll()).toBe(boot);
    expect(sent[1]!.ifNoneMatch).toBe('"a1"');
  });

  test('a boot read never sends the ETag: the coalescer shares its request with other callers', async () => {
    queue.push(feed('"a1"', ['one']));
    await boardApi.listAll();
    queue.push(feed('"b2"', ['one', 'two']));
    const boot = await boardApi.listAll(undefined, { ttlMs: 2000 });
    expect(sent[1]!.ifNoneMatch).toBeNull();
    expect(boot.map((t) => t.text)).toEqual(['one', 'two']);
  });

  test('filtered reads never revalidate', async () => {
    queue.push(feed('"a1"', ['one']));
    await boardApi.listAll();
    queue.push(feed('"a1"', ['one']));
    await boardApi.listAll('todo');
    expect(sent[1]!.url).toContain('?status=todo');
    expect(sent[1]!.ifNoneMatch).toBeNull();
  });

  test('a failed read keeps throwing, and the next read still revalidates', async () => {
    queue.push(feed('"a1"', ['one']));
    const held = await boardApi.listAll();
    queue.push(new Response(JSON.stringify({ error: 'boom' }), { status: 500 }));
    await expect(boardApi.listAll()).rejects.toThrow('boom');
    queue.push(new Response(null, { status: 304, headers: { ETag: '"a1"' } }));
    expect(await boardApi.listAll()).toBe(held);
  });
});
