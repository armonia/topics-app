/**
 * The `[pane-attach]` trace reaches the server in order, survives a server that
 * is down for a while, and never grows without bound.
 *
 * @covers BROWSER-CHAT-04
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  __flushPaneAttachTraceForTests,
  __queuedPaneAttachTraceForTests,
  __setPaneAttachTraceSendForTests,
  installPaneAttachTraceSink,
  tracePaneAttach,
  type TraceEvent,
} from './paneAttachTrace';

const quiet = spyOn(console, 'info').mockImplementation(() => {});

afterEach(() => {
  __setPaneAttachTraceSendForTests(null);
});

describe('paneAttachTrace', () => {
  it('without a sink it only writes to the console', () => {
    tracePaneAttach('navigate received', { projectPath: '/p' });
    expect(quiet).toHaveBeenCalled();
    expect(__queuedPaneAttachTraceForTests()).toEqual([]);
  });

  it('sends the events in order, at most fifty per request', async () => {
    const sent: TraceEvent[][] = [];
    __setPaneAttachTraceSendForTests(async (events) => { sent.push(events); return true; });
    for (let i = 0; i < 60; i++) tracePaneAttach(`e${i}`, { i });
    await __flushPaneAttachTraceForTests();
    await __flushPaneAttachTraceForTests();
    expect(sent.map((b) => b.length)).toEqual([50, 10]);
    expect(sent.flat().map((e) => e.event)).toEqual(Array.from({ length: 60 }, (_, i) => `e${i}`));
    expect(__queuedPaneAttachTraceForTests()).toEqual([]);
  });

  it('keeps the lines while the server is down and sends them once it is back', async () => {
    let up = false;
    const sent: string[] = [];
    __setPaneAttachTraceSendForTests(async (events) => {
      if (!up) throw new Error('connection refused');
      sent.push(...events.map((e) => e.event));
      return true;
    });
    tracePaneAttach('pane socket released', { contextId: 'c' });
    await __flushPaneAttachTraceForTests();
    expect(sent).toEqual([]);
    tracePaneAttach('project window unmounted', { projectPath: '/p' });
    up = true;
    await __flushPaneAttachTraceForTests();
    expect(sent).toEqual(['pane socket released', 'project window unmounted']);
  });

  it('holds at most two hundred lines while down, and says how many it dropped', async () => {
    let up = false;
    const sent: TraceEvent[] = [];
    __setPaneAttachTraceSendForTests(async (events) => {
      if (!up) return false;
      sent.push(...events);
      return true;
    });
    for (let i = 0; i < 230; i++) tracePaneAttach(`e${i}`);
    await __flushPaneAttachTraceForTests();
    expect(__queuedPaneAttachTraceForTests()).toHaveLength(200);
    up = true;
    for (let n = 0; n < 6; n++) await __flushPaneAttachTraceForTests();
    expect(sent[0]).toMatchObject({ event: 'trace lines dropped', fields: { count: 30 } });
    expect(sent.slice(1).map((e) => e.event)).toEqual(Array.from({ length: 200 }, (_, i) => `e${i + 30}`));
  });

  it('a refusal turns the sink off instead of retrying forever', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => new Response(null, { status: 403 })) as unknown as typeof fetch);
    try {
      installPaneAttachTraceSink(() => 'tab-1');
      tracePaneAttach('force-open received', { host: '/p' });
      await __flushPaneAttachTraceForTests();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/api/client-trace');
      expect((init.headers as Record<string, string>)['X-Client-Id']).toBe('tab-1');
      tracePaneAttach('navigate received');
      expect(__queuedPaneAttachTraceForTests()).toEqual([]);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
