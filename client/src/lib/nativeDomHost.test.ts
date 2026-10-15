import { describe, expect, test } from 'bun:test';
import { createNativeDomHost, DRAIN_JS, DRAIN_FAST_MS, DRAIN_IDLE_MS, type NativeDomHostOptions } from './nativeDomHost';
import { BrowserWsChunkAssembler, chunkText } from '../../../shared/browser-ws-chunks';

/** @covers NATIVE-HOST-02 */

/** A pane whose page is a queue, and a clock the test turns by hand. */
function rig(overrides: Partial<NativeDomHostOptions> = {}) {
  const sent: string[] = [];
  const pageScripts: { js: string; preserveFocus?: boolean }[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const page = { armed: false, queue: [] as unknown[] };
  let clock = 0;
  const navigations: string[] = [];
  const host = createNativeDomHost({
    evalInPage: async (js, preserveFocus) => {
      pageScripts.push({ js, preserveFocus });
      if (js === DRAIN_JS) {
        if (!page.armed) return 'unarmed';
        const q = page.queue; page.queue = [];
        return JSON.stringify(q);
      }
      if (js.includes('__topicsDomHost={q:[]')) {
        page.armed = true;
        page.queue.push(...initialEvents);
        return 'armed';
      }
      if (js.includes('window.__topicsDomHost=undefined')) { page.armed = false; page.queue = []; return 'ok'; }
      return 'ok';
    },
    loadRecorder: async () => 'var rrweb={record:function(){}};',
    sendText: (t) => sent.push(t),
    navigate: (action, url) => navigations.push(url ? `${action} ${url}` : action),
    schedule: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return () => { t.live = false; };
    },
    now: () => clock,
    ...overrides,
  });
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
  /** One round: run what is due now, then let its awaits settle. */
  const step = async () => {
    await settle();
    for (const t of timers.filter((x) => x.live)) { t.live = false; t.fn(); }
    await settle();
  };
  /** Rounds until only a regular drain is left (the loop never stops while recording). */
  const turn = async () => {
    for (let i = 0; i < 20; i++) {
      await step();
      if (!timers.some((t) => t.live && t.ms === 0)) return;
    }
  };
  const pending = () => timers.filter((t) => t.live).map((t) => t.ms);
  return { host, sent, pageScripts, page, turn, step, settle, pending, navigations, tick: (ms: number) => { clock += ms; } };
}

const frames = (sent: string[]) => sent.map((t) => JSON.parse(t) as { type: string; events?: unknown[] });
const initialEvents = [
  { type: 4, timestamp: 1, data: { href: 'https://example.com', width: 800, height: 600 } },
  { type: 2, timestamp: 2, data: { node: { type: 0, id: 1, childNodes: [] } } },
];

describe('native DOM host', () => {
  test('a start arms the recorder and the first drain sends meta + snapshot', async () => {
    const r = rig();
    r.host.handle({ type: 'host_dom_start' });
    await r.turn();
    const batch = frames(r.sent).find((f) => f.type === 'host_dom_events');
    expect(batch?.events).toEqual(initialEvents);
  });

  /** @covers NATIVE-HOST-05 @covers NATDEL-04 */
  test('pieces from the page are put back together here: only rebuilt rrweb events leave, never the page\'s keys', async () => {
    const small = { type: 3, timestamp: 4, data: { source: 2 } };
    const large = { type: 2, timestamp: 5, data: { node: { type: 3, id: 10, textContent: 'z'.repeat(300_000) } } };
    const withExtraKey = { ...small, timestamp: 6, extra: 'not an rrweb key' };
    const pieces = chunkText(JSON.stringify([small, large, withExtraKey]), 'page-made')
      .map((piece) => JSON.stringify({ ...piece, type: 'host_page', url: 'https://elsewhere.example' }));
    let armed = false;
    const r = rig({
      evalInPage: async (js) => {
        if (js === DRAIN_JS) return armed ? (pieces.shift() ?? '[]') : 'unarmed';
        if (js.includes('__topicsDomHost={q:[]')) { armed = true; return 'armed'; }
        return 'ok';
      },
    });
    r.host.handle({ type: 'host_dom_start' });
    for (let i = 0; i < 8 && pieces.length; i++) { r.tick(DRAIN_IDLE_MS); await r.step(); }
    const sent = r.sent.map((t) => JSON.parse(t) as Record<string, unknown>);
    expect(sent.some((f) => f.type === 'host_page' || 'url' in f)).toBe(false);
    const chunks = sent.filter((f) => f.type === 'host_dom_events_chunk');
    expect(chunks.length).toBeGreaterThan(1);
    for (const f of chunks) expect(Object.keys(f).sort()).toEqual(['data', 'id', 'index', 'total', 'type']);
    const assembler = new BrowserWsChunkAssembler();
    let rebuilt: string | null = null;
    for (const f of chunks) rebuilt = assembler.add(f as never) ?? rebuilt;
    expect(JSON.parse(rebuilt!)).toEqual([small, large]);
  });

  test('the drain stays fast while the page moves and slows down when it is still', async () => {
    const r = rig();
    r.host.handle({ type: 'host_dom_start' });
    await r.turn();
    // Snapshot just sent: the page is busy, the next drain is a fast one.
    expect(r.pending()).toEqual([DRAIN_FAST_MS]);
    r.tick(5_000);
    await r.step();
    expect(r.pending()).toEqual([DRAIN_IDLE_MS]);
    r.host.handle({ type: 'host_input', action: 'scroll', payload: { deltaY: 40 } });
    await r.settle();
    // What the input changed is drained at once, and the cadence is fast again.
    expect(r.pending()).toContain(0);
    await r.step();
    expect(r.pending()).toEqual([DRAIN_FAST_MS]);
  });

  test('a stop ends the drains and detaches the recorder', async () => {
    const r = rig();
    r.host.handle({ type: 'host_dom_start' });
    await r.turn();
    r.host.handle({ type: 'host_dom_stop' });
    await r.turn();
    expect(r.page.armed).toBe(false);
    const drainsAfter = r.pageScripts.length;
    r.page.queue.push({ type: 3 });
    await r.turn();
    expect(r.pageScripts.length).toBe(drainsAfter);
  });

  test('a start always begins from a fresh recorder: one left running would never resend the snapshot', async () => {
    const r = rig();
    r.page.armed = true; // left over by a socket that died
    r.page.queue.push({ type: 3 });
    r.host.handle({ type: 'host_dom_start' });
    await r.turn();
    const batch = frames(r.sent).find((f) => f.type === 'host_dom_events');
    expect(batch?.events).toEqual(initialEvents);
  });

  test('inputs run in order, keep the Mac\'s key focus, and are followed by a drain', async () => {
    const r = rig();
    r.host.handle({ type: 'host_dom_start' });
    await r.turn();
    r.host.handle({ type: 'host_input', action: 'click', payload: { x: 1, y: 2 } });
    r.host.handle({ type: 'host_input', action: 'type', payload: { text: 'ciao' } });
    await r.turn();
    const inputs = r.pageScripts.filter((e) => e.preserveFocus);
    expect(inputs.map((e) => e.js.match(/\("(click|type)"/)?.[1])).toEqual(['click', 'type']);
    const lastInput = r.pageScripts.lastIndexOf(inputs[1]);
    expect(r.pageScripts.slice(lastInput + 1).some((e) => e.js === DRAIN_JS)).toBe(true);
  });

  test('the page reaches the server only once the declaration is accepted', () => {
    const r = rig();
    r.host.declare();
    r.host.notePage({ url: 'https://a.example', title: 'A' });
    expect(frames(r.sent).map((f) => f.type)).toEqual(['native_dom_host']);
    r.host.handle({ type: 'native_dom_host_ack' });
    expect(frames(r.sent).map((f) => f.type)).toEqual(['native_dom_host', 'host_page']);
    r.host.notePage({ url: 'https://a.example', title: 'A' });
    expect(r.sent).toHaveLength(2);
  });

  test('a viewer\'s navigation goes through the pane\'s own toolbar path', () => {
    const r = rig();
    r.host.handle({ type: 'host_nav', action: 'navigate', url: 'https://b.example' });
    r.host.handle({ type: 'host_nav', action: 'back' });
    expect(r.navigations).toEqual(['navigate https://b.example', 'back']);
  });

  test('a dead socket voids the recording', async () => {
    const changes: boolean[] = [];
    const r = rig({ onRecordingChange: (on) => changes.push(on) });
    r.host.handle({ type: 'host_dom_start' });
    await r.turn();
    r.host.reset();
    expect(changes).toEqual([true, false]);
    expect(r.host.accepted()).toBe(false);
  });

  test('frames that are not the host\'s are left to the socket', () => {
    const r = rig();
    expect(r.host.handle({ type: 'agent_active', active: true })).toBe(false);
    expect(DRAIN_FAST_MS).toBeLessThan(DRAIN_IDLE_MS);
  });
});

/** @covers BROWSER-DOM-SCROLL-02 */
describe('native DOM host: a page slower than the viewer\'s scroll', () => {
  /** The scroll inputs that reached the page, in order, with what they carried. */
  const scrollsRun = (r: ReturnType<typeof rig>) => r.pageScripts
    .filter((e) => e.preserveFocus)
    .map((e) => {
      const [, action = '', payload = '{}'] = e.js.match(/\("(\w+)",(\{.*\})\)$/) ?? [];
      return { action, ...(JSON.parse(payload) as Partial<Record<'x' | 'y' | 'deltaX' | 'deltaY' | 'node' | 'scrollTop' | 'scrollLeft', number>> & { wheels?: unknown[] }) };
    });
  const placed = (scrollTop: number, deltaY: number) => ({ type: 'host_input', action: 'scroll', payload: { x: 5, y: scrollTop, deltaY, node: 1, scrollTop, scrollLeft: 0 } });

  test('scrolls waiting for their turn reach the page as one, at the latest place, each wheel still its own event', async () => {
    const r = rig();
    r.host.handle(placed(10, 10));
    r.host.handle(placed(22, 12));
    r.host.handle(placed(33, 11));
    await r.turn();
    expect(scrollsRun(r)).toEqual([{
      action: 'scroll', x: 5, y: 33, deltaX: 0, deltaY: 33, node: 1, scrollTop: 33, scrollLeft: 0,
      wheels: [{ x: 5, y: 10, deltaX: 0, deltaY: 10 }, { x: 5, y: 22, deltaX: 0, deltaY: 12 }, { x: 5, y: 33, deltaX: 0, deltaY: 11 }],
    }]);
  });

  test('two distances add up, and a distance never takes a place in', async () => {
    const r = rig();
    r.host.handle({ type: 'host_input', action: 'scroll', payload: { x: 1, y: 1, deltaY: 10 } });
    r.host.handle({ type: 'host_input', action: 'scroll', payload: { x: 2, y: 2, deltaY: 5 } });
    r.host.handle(placed(40, 25));
    r.host.handle({ type: 'host_input', action: 'scroll', payload: { x: 3, y: 3, deltaY: 7 } });
    await r.turn();
    expect(scrollsRun(r).map((s) => [s.deltaY, s.scrollTop])).toEqual([[15, undefined], [25, 40], [7, undefined]]);
  });

  test('a scroll does not fold past another input, nor past a new size for the page', async () => {
    const r = rig();
    r.host.handle(placed(10, 10));
    r.host.handle({ type: 'host_input', action: 'click', payload: { x: 1, y: 1 } });
    r.host.handle(placed(20, 10));
    r.host.handle({ type: 'host_viewport', width: 800, height: 600 });
    r.host.handle(placed(30, 10));
    await r.turn();
    expect(scrollsRun(r).map((s) => `${s.action}${s.scrollTop ?? ''}`)).toEqual(['scroll10', 'click', 'scroll20', 'scroll30']);
  });
});

/** @covers NATIVE-HOST-04 */
describe('native DOM host: the layout of the device using the page', () => {
  const sizes = () => {
    const seen: string[] = [];
    return { seen, setViewport: (v: { width: number; height: number } | null) => { seen.push(v ? `${v.width}x${v.height}` : 'own'); } };
  };

  test('a size from the server is applied after the inputs already queued', async () => {
    const log: string[] = [];
    let releaseInput!: () => void;
    const r = rig({
      evalInPage: async (_js, preserveFocus) => {
        if (preserveFocus) { await new Promise<void>((done) => { releaseInput = done; }); log.push('input'); }
        return 'ok';
      },
      setViewport: (v) => { log.push(v ? `${v.width}x${v.height}` : 'own'); },
    });
    r.host.handle({ type: 'host_input', action: 'click', payload: { x: 10, y: 20 } });
    r.host.handle({ type: 'host_viewport', width: 1180, height: 820 });
    await r.settle();
    expect(log).toEqual([]);
    releaseInput();
    await r.settle();
    expect(log).toEqual(['input', '1180x820']);
  });

  test('the Mac using its pane takes the layout back, and the server hears of every use', async () => {
    const v = sizes();
    const r = rig({ setViewport: v.setViewport });
    r.host.handle({ type: 'native_dom_host_ack' });
    r.host.handle({ type: 'host_viewport', width: 1180, height: 820 });
    await r.settle();
    r.host.noteLocalUse();
    r.host.noteLocalUse();
    expect(v.seen).toEqual(['1180x820', 'own']);
    expect(frames(r.sent).filter((f) => f.type === 'host_local_use')).toHaveLength(2);
  });

  test('laid out for nobody, a use still reaches the server: a size on its way must not land after it', () => {
    const v = sizes();
    const r = rig({ setViewport: v.setViewport });
    r.host.handle({ type: 'native_dom_host_ack' });
    r.host.noteLocalUse();
    expect(v.seen).toEqual([]);
    expect(frames(r.sent).map((f) => f.type)).toEqual(['host_local_use']);
  });

  test('a use while the socket is down goes with the next declaration; one before its answer, right after it', () => {
    const r = rig();
    r.host.handle({ type: 'native_dom_host_ack' });
    r.host.reset();
    r.host.noteLocalUse();
    expect(frames(r.sent)).toEqual([]);
    r.host.declare();
    expect(r.sent).toEqual([JSON.stringify({ type: 'native_dom_host', used: true })]);
    r.host.noteLocalUse();
    r.host.handle({ type: 'native_dom_host_ack' });
    expect(frames(r.sent).map((f) => f.type)).toEqual(['native_dom_host', 'host_local_use']);
    r.host.declare();
    expect(r.sent.at(-1)).toBe(JSON.stringify({ type: 'native_dom_host' }));
  });

  test('a size still queued behind an input does not land after the Mac took the page back', async () => {
    const v = sizes();
    let releaseInput!: () => void;
    const r = rig({
      evalInPage: async (_js, preserveFocus) => {
        if (preserveFocus) await new Promise<void>((done) => { releaseInput = done; });
        return 'ok';
      },
      setViewport: v.setViewport,
    });
    r.host.handle({ type: 'host_input', action: 'click', payload: { x: 1, y: 1 } });
    r.host.handle({ type: 'host_viewport', width: 1180, height: 820 });
    await r.settle();
    r.host.noteLocalUse();
    releaseInput();
    await r.settle();
    expect(v.seen).toEqual(['own']);
  });

  test('the server giving the page back, or the socket dying, returns it to the pane', async () => {
    const v = sizes();
    const r = rig({ setViewport: v.setViewport });
    r.host.handle({ type: 'host_viewport', width: 1180, height: 820 });
    await r.settle();
    r.host.handle({ type: 'host_viewport' });
    await r.settle();
    r.host.handle({ type: 'host_viewport', width: 820, height: 1180 });
    await r.settle();
    r.host.reset();
    expect(v.seen).toEqual(['1180x820', 'own', '820x1180', 'own']);
  });
});
