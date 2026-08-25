/**
 * Socket-level proof of the native-pane transport: the SAME real modules
 * (createNativeDelegateRegistry + handleNativeDelegationFrame on the server side,
 * executeNativeBrowserOp on the client side) round-tripping a browser_op over a
 * REAL Bun WebSocket with literal JSON framing — the one link the in-process
 * integration test (browser-native-delegate.integration.test.ts) can't cover.
 *
 * The server here is a MINIMAL stand-in for server.ts's /ws/browser glue (parse →
 * handleNativeDelegationFrame → unregister on close — the ~15 lines confirmed by
 * inspection to match server.ts lines ~852-967), deliberately WITHOUT booting the
 * full server (whose BrowserService Chromium :19222 / MCP spawns / proxy :3334 are
 * shared singletons with the user's prod). Ephemeral port → zero prod impact.
  * @covers NATDEL-02
 */
import { test, expect } from 'bun:test';
import { createNativeDelegateRegistry, handleNativeDelegationFrame } from './browser-native-delegate';
import { executeNativeBrowserOp, type Invoke } from '../client/src/lib/shell/tauriBrowserOps';

test('native-delegate round-trips a browser_op over a REAL WebSocket (literal JSON framing)', async () => {
  const registry = createNativeDelegateRegistry({ timeoutMs: 5000 });

  // Structural types so the file is self-typed without pulling in `bun` type defs.
  type Upgrader = { upgrade(req: Request, opts: { data: { ctxId: string } }): boolean };
  type WS = { data: { ctxId: string }; send(s: string): void };

  const server = Bun.serve({
    port: 0, // ephemeral — never collides with prod :3333 / :3399 / anything
    fetch(req: Request, srv: Upgrader) {
      const url = new URL(req.url);
      if (url.pathname.startsWith('/ws/browser/')) {
        const ctxId = decodeURIComponent(url.pathname.split('/ws/browser/')[1] || '');
        if (srv.upgrade(req, { data: { ctxId } })) return undefined;
        return new Response('upgrade failed', { status: 500 });
      }
      if (url.pathname === '/trigger') {
        const ctx = url.searchParams.get('ctx') || '';
        const tool = url.searchParams.get('tool') || '';
        // Exactly the server-side trigger: dispatch delegates to the registered pane.
        return registry.delegateOp(ctx, tool, { expression: '40+2' }).then((r) => Response.json({ r }));
      }
      return new Response('nope', { status: 404 });
    },
    websocket: {
      // Mirror of server.ts's browser-WS message branch (delegation path only).
      message(ws: WS, message: string | Uint8Array) {
        const ctxId = ws.data.ctxId;
        const raw = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
        handleNativeDelegationFrame(raw, ctxId, (m) => { ws.send(JSON.stringify(m)); }, registry);
      },
      close(ws: WS) {
        registry.unregister(ws.data.ctxId);
      },
    },
  });

  try {
    const base = `http://127.0.0.1:${server.port}`;
    const wsUrl = `ws://127.0.0.1:${server.port}/ws/browser/test-ctx`;

    // The native executor end: a REAL WebSocket that registers + runs each
    // browser_op through the REAL executeNativeBrowserOp with a mock Tauri invoke.
    const invoke: Invoke = async (cmd) => (cmd === 'browser_eval_js' ? '42' : '') as never;
    const client = new WebSocket(wsUrl);
    client.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === 'browser_op') {
        void executeNativeBrowserOp('test-ctx', m.tool, m.args, invoke).then((out) =>
          client.send(JSON.stringify({ type: 'browser_op_result', opId: m.opId, ...out })),
        );
      }
    };
    await new Promise<void>((res, rej) => {
      client.onopen = () => { client.send(JSON.stringify({ type: 'register_native_executor' })); res(); };
      client.onerror = (e) => rej(e);
    });

    // Let the register frame land server-side, then confirm the registry saw it.
    await Bun.sleep(100);
    expect(registry.isDelegated('test-ctx')).toBe(true);

    // Trigger an op over HTTP → it must travel out over the real socket to the
    // client, execute, and travel back as browser_op_result.
    const resp = (await fetch(`${base}/trigger?ctx=test-ctx&tool=browser_eval`).then((r) => r.json())) as { r: unknown };
    expect(resp.r).toBe('42');

    client.close();
    await Bun.sleep(50);
    expect(registry.isDelegated('test-ctx')).toBe(false); // close → unregister over the socket lifecycle
  } finally {
    server.stop(true);
  }
});
