import { describe, expect, test } from 'bun:test';
import { createNativeDomHost, DRAIN_JS, DRAIN_FAST_MS, DRAIN_IDLE_MS, type NativeDomHostOptions } from './nativeDomHost';

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
        page.queue.push({ type: 4 }, { type: 2 });
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

describe('native DOM host', () => {
  test('a start arms the recorder and the first drain sends meta + snapshot', async () => {
    const r = rig();
    r.host.handle({ type: 'host_dom_start' });
    await r.turn();
    const batch = frames(r.sent).find((f) => f.type === 'host_dom_events');
    expect(batch?.events).toEqual([{ type: 4 }, { type: 2 }]);
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
    expect(batch?.events).toEqual([{ type: 4 }, { type: 2 }]);
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
