/**
 * AFTER A SERVER RESTART THE DELEGATION MUST RESTART BY ITSELF.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * A native browser pane is drivable by an agent only while it is REGISTERED as
 * the executor of its context on `/ws/browser/:contextId`. That socket was
 * opened once at mount and never reopened. The server restarts many times a day
 * (the file watcher SIGTERMs it on every save under `server/`), and after each
 * restart the pane stayed mounted, looked normal, and quietly answered no
 * tool-call at all until someone closed and reopened it.
 *
 * ── Why this file does not mount anything ───────────────────────────────────
 * The trap in testing this is the FALSE GREEN: a test that reopens the pane
 * exercises the mount path, which was never broken - it passed before the fix
 * and it passes after. So here the supervisor is started ONCE and never
 * restarted: everything below happens on the same "mounted pane", and the only
 * thing that can make a second socket appear is the reconnection under test.
 *
 * @covers BROWSER-NATIVE-RECONNECT-01
 */
import { describe, expect, test } from 'bun:test';
import {
  reconnectDelayMs,
  startNativeExecutorSocket,
  type DelegatedOpOutcome,
  type ExecutorSocketHandlers,
} from './nativeExecutorSocket';

/** A socket whose lifetime the test decides, so a "server restart" is one call. */
class FakeSocket {
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string, readonly handlers: ExecutorSocketHandlers) {}
  send(text: string): void { this.sent.push(text); }
  close(): void { this.closed = true; }
  /** The server accepted the connection. */
  open(): void { this.handlers.onOpen(); }
  /** The server went away (SIGTERM, sleep, network). */
  die(): void { this.handlers.onDead(); }
  frame(payload: unknown): void { this.handlers.onMessage(JSON.stringify(payload)); }
  frames(): Array<Record<string, unknown>> { return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>); }
  types(): string[] { return this.frames().map((f) => String(f.type)); }
}

interface Harness {
  sockets: FakeSocket[];
  /** Pending reconnect timers, in the order they were armed. */
  pending: Array<{ ms: number; fire: () => void }>;
  /** Fire the oldest pending timer: the clock is the test's, never real time. */
  tick(): number;
  ops: Array<{ tool: string; args: unknown }>;
  pill: boolean[];
  run: { stop(): void };
}

function harness(runOp?: (tool: string, args: unknown) => Promise<DelegatedOpOutcome>): Harness {
  const sockets: FakeSocket[] = [];
  const pending: Array<{ ms: number; fire: () => void }> = [];
  const ops: Array<{ tool: string; args: unknown }> = [];
  const pill: boolean[] = [];
  const run = startNativeExecutorSocket({
    url: 'ws://127.0.0.1:3333/ws/browser/ctx-1',
    createSocket: (url, handlers) => {
      const s = new FakeSocket(url, handlers);
      sockets.push(s);
      return s;
    },
    schedule: (fn, ms) => {
      const entry = { ms, fire: fn };
      pending.push(entry);
      return () => {
        const i = pending.indexOf(entry);
        if (i >= 0) pending.splice(i, 1);
      };
    },
    runOp: async (tool, args) => {
      ops.push({ tool, args });
      return runOp ? await runOp(tool, args) : { result: { ok: true } };
    },
    onAgentActive: (active) => { pill.push(active); },
  });
  return {
    sockets,
    pending,
    tick: () => {
      const next = pending.shift();
      if (!next) throw new Error('no reconnect was armed');
      next.fire();
      return next.ms;
    },
    ops,
    pill,
    run,
  };
}

describe('native pane executor socket', () => {
  test('the pane registers as executor as soon as the socket opens', () => {
    const h = harness();
    expect(h.sockets).toHaveLength(1);
    h.sockets[0].open();
    expect(h.sockets[0].types()).toEqual(['register_native_executor']);
  });

  test('THE DEFECT: after the server restarts, a LATER tool-call runs, with no remount', async () => {
    const h = harness();
    h.sockets[0].open();

    // The server restarts. Nothing else happens: the pane is not touched, not
    // reopened, not remounted - exactly the situation of someone who saved a
    // file under `server/` while a browser pane sat there.
    h.sockets[0].die();
    expect(h.pill.at(-1)).toBe(false); // BROWSER-AGENT-PILL-01: it stops claiming.

    // Time passes on the backoff ladder, and the pane knocks again by itself.
    expect(h.tick()).toBe(1000);
    expect(h.sockets).toHaveLength(2);
    h.sockets[1].open();
    expect(h.sockets[1].types()).toEqual(['register_native_executor']);

    // The whole point: the NEXT delegated tool-call works, on the same pane.
    h.sockets[1].frame({ type: 'browser_op', opId: 'op-9', tool: 'browser_act', args: { action: 'click' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.ops).toEqual([{ tool: 'browser_act', args: { action: 'click' } }]);
    expect(h.sockets[1].frames().at(-1)).toEqual({ type: 'browser_op_result', opId: 'op-9', result: { ok: true } });
    // And it never needed a second pane: one socket died, one replaced it.
    expect(h.sockets).toHaveLength(2);
  });

  test('a server that stays down is retried on a widening ladder, capped', () => {
    const h = harness();
    const delays: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      h.sockets.at(-1)!.die();
      delays.push(h.tick());
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 10000, 10000]);
    // A reconnect that SUCCEEDS starts the ladder over, so the next restart is
    // answered in a second and not in ten.
    h.sockets.at(-1)!.open();
    h.sockets.at(-1)!.die();
    expect(h.tick()).toBe(1000);
  });

  test('an op that arrives on a socket that has since died is not answered into the void', async () => {
    let release: (out: DelegatedOpOutcome) => void = () => {};
    const h = harness(() => new Promise((res) => { release = res; }));
    h.sockets[0].open();
    h.sockets[0].frame({ type: 'browser_op', opId: 'op-1', tool: 'browser_get_text', args: {} });
    h.sockets[0].die();
    h.tick();
    h.sockets[1].open();
    release({ result: { text: 'late' } });
    await Promise.resolve();
    await Promise.resolve();
    // The old socket got nothing after its death, and the new one is not
    // handed a result for an opId the fresh server has never heard of.
    expect(h.sockets[0].types()).toEqual(['register_native_executor']);
    expect(h.sockets[1].types()).toEqual(['register_native_executor']);
  });

  test('a rejected registration stands down instead of knocking forever', () => {
    // The server closes us because a LIVE executor already serves this context:
    // we are a second pane. Retrying on a ladder would be a hijack loop.
    const h = harness();
    h.sockets[0].open();
    h.sockets[0].frame({ type: 'register_native_executor_rejected', contextId: 'ctx-1', reason: 'already served' });
    h.sockets[0].die();
    expect(h.pending).toHaveLength(0);
    expect(h.sockets).toHaveLength(1);
  });

  test('unmounting stops the loop: no socket is opened after the pane is gone', () => {
    const h = harness();
    h.sockets[0].open();
    h.sockets[0].die();
    expect(h.pending).toHaveLength(1);
    h.run.stop();
    expect(h.pending).toHaveLength(0);
    expect(h.sockets).toHaveLength(1);
  });

  test('the pill follows the frames while the socket lives', () => {
    const h = harness();
    h.sockets[0].open();
    h.sockets[0].frame({ type: 'agent_active', active: true, action: 'click' });
    h.sockets[0].frame({ type: 'agent_active', active: false });
    expect(h.pill).toEqual([true, false]);
  });

  test('the backoff is exponential and bounded', () => {
    expect(reconnectDelayMs(0)).toBe(1000);
    expect(reconnectDelayMs(3)).toBe(8000);
    expect(reconnectDelayMs(50)).toBe(10000);
  });
});

describe('the pushed viewer count rides the executor socket', () => {
  test('a `viewers` frame reaches onViewers; open and death are announced as a channel', () => {
    const sockets: FakeSocket[] = [];
    const viewers: number[] = [];
    const channel: boolean[] = [];
    const run = startNativeExecutorSocket({
      url: 'ws://127.0.0.1:3333/ws/browser/ctx-1',
      createSocket: (url, handlers) => { const s = new FakeSocket(url, handlers); sockets.push(s); return s; },
      schedule: () => () => {},
      runOp: async () => ({ result: null }),
      onAgentActive: () => {},
      onViewers: (n) => { viewers.push(n); },
      onChannel: (up) => { channel.push(up); },
    });
    const s = sockets[0]!;
    s.open();
    expect(channel).toEqual([true]);
    s.frame({ type: 'viewers', count: 2 });
    s.frame({ type: 'agent_active', active: true });
    s.frame({ type: 'viewers', count: 0 });
    expect(viewers, 'only the viewers frames, in order').toEqual([2, 0]);
    s.die();
    expect(channel, 'a dead socket pushes nothing: the poll must know').toEqual([true, false]);
    run.stop();
  });

  test('stop withdraws the channel of the socket it closes', () => {
    const sockets: FakeSocket[] = [];
    const channel: boolean[] = [];
    const run = startNativeExecutorSocket({
      url: 'ws://127.0.0.1:3333/ws/browser/ctx-1',
      createSocket: (url, handlers) => { const s = new FakeSocket(url, handlers); sockets.push(s); return s; },
      schedule: () => () => {},
      runOp: async () => ({ result: null }),
      onAgentActive: () => {},
      onChannel: (up) => { channel.push(up); },
    });
    sockets[0]!.open();
    run.stop();
    expect(channel).toEqual([true, false]);
  });
});
