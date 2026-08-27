/**
 * SUSPECT (A): the `wsClients` Set and the `browserWsClients` Map.
 *
 * `wsClients` (server/utils.ts) holds every chat socket; `browserWsClients`
 * (server.ts) is a Map of contextId -> Set of `/ws/browser/:contextId` sockets.
 * Both are process-lifetime globals that every broadcast walks, so an entry
 * that outlives its tab is a socket object pinned forever AND one more
 * iteration on every frame the server sends.
 *
 * THIS IS THE REAL SERVER, not a replica of the handler bodies. The `open` and
 * `close` handlers live inline in `server.ts`, which boots on import, so the
 * measurement spawns `bun run server.ts` as a child process with an isolated
 * APP_DATA_DIR and a free port, opens and closes real WebSockets against it,
 * and reads the counters back off the server's own HTTP surface
 * (`GET /api/system/status`). Nothing here re-implements anything: the numbers
 * come from the same Set and Map that production broadcasts iterate.
 *
 * The browser registry was NOT reported by that endpoint. It is now
 * (`connections.browserWsContexts` / `browserWsSockets`, grafted in server.ts
 * next to the registry, typed on AppContext) - a Map of Sets whose keys can
 * only be inspected from inside the process is a thing that can grow with
 * nobody able to see it.
 *
 * ISOLATION, and it is not optional. A server booted from this cwd with the
 * default socket attaches to the PRODUCTION PTY bridge and its startup
 * reconcile kills every bridge session missing from its (empty) DB - that is
 * how nine live terminals died on 2026-06-22. Three independent guards below:
 * TOPICS_DISABLE_PTY_BRIDGE=1 (the bridge is never contacted), an explicit
 * TOPICS_PTY_SOCKET, and a private DATA_DIR (which the socket hash folds in).
 * The env is built from scratch rather than spread from `process.env`, so an
 * inherited TOPICS_TUNNEL_PORT cannot make the child bind the live app's port.
 *
 * NOT COVERED, and saying so beats pretending: the half-open socket. A TCP
 * break that never delivers a `close` frame is reaped by the 30 s heartbeat
 * after a 90 s pong timeout (server.ts), which no 30 s test can wait for.
 * What is measured here is the tab-closes path, which is the one that runs
 * thousands of times a day.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { testTmpDir, PROJECT_ROOT } from "./helpers";

/** The one line an aggregator parses. Same shape in all three leak measurements. */
function leakCounterLine(suspect: string, counter: string, before: number, after: number, cycles: number): void {
  const verdict = after === before ? "ok" : "LEAK";
  console.log(`LEAK-COUNTER ${suspect} | ${counter} | before=${before} after=${after} cycles=${cycles} | ${verdict}`);
}

const CYCLES = 25;

interface Connections {
  wsClients: number;
  browserWsContexts: number;
  browserWsSockets: number;
}

const ROOT = testTmpDir("leak-ws-registries");
let port = 0;
let server: ReturnType<typeof Bun.spawn> | null = null;

/** A port nobody holds: bind on 0, read what the kernel gave, release it. */
function freePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const p = probe.port;
  probe.stop(true);
  return p;
}

async function connections(): Promise<Connections> {
  const res = await fetch(`http://127.0.0.1:${port}/api/system/status`);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).connections as Connections;
}

/**
 * Open a socket, run `onOpen` if given, close it, resolve once the close has
 * actually happened on this end. Polling the counter afterwards covers the
 * server side, so no sleep is needed anywhere.
 */
function openThenClose(url: string, onOpen?: (ws: WebSocket) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error(`websocket timed out: ${url}`)), 10_000);
    ws.onopen = () => { onOpen?.(ws); ws.close(); };
    ws.onclose = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error(`websocket failed: ${url}`)); };
  });
}

/** Open N sockets on the same context, hand them back still open. */
function openAll(urls: string[]): Promise<WebSocket[]> {
  return Promise.all(urls.map((url) => new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error(`websocket timed out: ${url}`)), 10_000);
    ws.onopen = () => {
      clearTimeout(timer);
      // Pause this viewer's stream BEFORE the 250 ms screencast grace elapses.
      // Without it the server would launch a headless Chromium per context to
      // stream frames to a socket about to close - real behaviour, but minutes
      // of Chromium churn for a measurement about two Maps.
      ws.send(JSON.stringify({ type: "set_stream", active: false }));
      resolve(ws);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error(`websocket failed: ${url}`)); };
  })));
}

function closeAndWait(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    ws.onclose = () => resolve();
    ws.close();
  });
}

/** Poll until the predicate holds or the budget runs out; returns the last read. */
async function settle(ok: (c: Connections) => boolean): Promise<Connections> {
  let last = await connections();
  for (let i = 0; i < 100 && !ok(last); i++) {
    await new Promise((r) => setTimeout(r, 50));
    last = await connections();
  }
  return last;
}

beforeAll(async () => {
  port = freePort();
  const dataDir = join(ROOT, "data");
  const home = join(ROOT, "home");
  const openclaw = join(ROOT, "openclaw");
  const topicsHome = join(ROOT, "topics-home");
  const publicDir = join(ROOT, "public");
  for (const d of [dataDir, home, openclaw, topicsHome, publicDir]) mkdirSync(d, { recursive: true });

  server = Bun.spawn(["bun", "run", "server.ts"], {
    cwd: PROJECT_ROOT,
    // Built from scratch, NOT spread from process.env: see the header.
    env: {
      PATH: process.env.PATH ?? "",
      BUN_PORT: String(port),
      PORT: String(port),
      DATA_DIR: dataDir,
      TOPICS_DATA_DIR: dataDir,
      HOME: home,
      OPENCLAW_DIR: openclaw,
      TOPICS_HOME: topicsHome,
      TOPICS_PUBLIC_DIR: publicDir,
      // No orphan-Chromium sweep: the bottom of that chain is a SIGKILL on pids
      // read out of `ps`, and this test has no business sending signals.
      TOPICS_BROWSER_SWEEP: "0",
      TOPICS_DISABLE_PTY_BRIDGE: "1",
      TOPICS_PTY_SOCKET: join(ROOT, "pty.sock"),
      // The stream-json broker is a DETACHED daemon that outlives its spawner
      // by a 90 s grace window. Leaving one behind per run is how daemons pile
      // up; this measurement has no turns to broker, so it is simply off.
      TOPICS_AI_BRIDGE: "0",
      TOPICS_AI_BRIDGE_SOCKET: join(ROOT, "ai.sock"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  for (let i = 0; i < 300; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/system/status`);
      if (res.ok) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`the spawned server never answered on ${port}`);
}, 30_000);

afterAll(async () => {
  server?.kill("SIGTERM");
  await server?.exited;
});

describe("suspect (A): the two WebSocket registries of the real server", () => {
  test(`${CYCLES} chat sockets open and close leave wsClients where it started`, async () => {
    const before = (await connections()).wsClients;

    for (let i = 0; i < CYCLES; i++) {
      await openThenClose(`ws://127.0.0.1:${port}/ws`);
    }

    const after = (await settle((c) => c.wsClients === before)).wsClients;
    leakCounterLine("ws-registries", "wsClients.size", before, after, CYCLES);
    expect(after).toBe(before);
  }, 30_000);

  test("a live chat socket IS counted, so the counter can fail", async () => {
    // Same argument as everywhere else: a counter that reads zero because it
    // is wired to nothing would pass the test above forever.
    const before = (await connections()).wsClients;
    const [ws] = await Promise.all([
      new Promise<WebSocket>((resolve, reject) => {
        const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        const timer = setTimeout(() => reject(new Error("websocket timed out")), 10_000);
        sock.onopen = () => { clearTimeout(timer); resolve(sock); };
        sock.onerror = () => { clearTimeout(timer); reject(new Error("websocket failed")); };
      }),
    ]);
    const live = await settle((c) => c.wsClients === before + 1);
    expect(live.wsClients).toBe(before + 1);
    await closeAndWait(ws);
    const back = await settle((c) => c.wsClients === before);
    expect(back.wsClients).toBe(before);
  }, 20_000);

  test(`${CYCLES} browser panes open and close leave no contextId and no socket behind`, async () => {
    const start = await connections();

    for (let i = 0; i < CYCLES; i++) {
      await openThenClose(`ws://127.0.0.1:${port}/ws/browser/leak-ctx-${i}`, (ws) => {
        ws.send(JSON.stringify({ type: "set_stream", active: false }));
      });
    }

    const after = await settle((c) => c.browserWsContexts === start.browserWsContexts && c.browserWsSockets === start.browserWsSockets);
    leakCounterLine("ws-registries", "browserWsClients.size (contextId keys)", start.browserWsContexts, after.browserWsContexts, CYCLES);
    leakCounterLine("ws-registries", "browserWsClients total sockets", start.browserWsSockets, after.browserWsSockets, CYCLES);
    expect(after.browserWsContexts).toBe(start.browserWsContexts);
    expect(after.browserWsSockets).toBe(start.browserWsSockets);
  }, 30_000);

  test("two viewers on ONE context: the key survives the first close and goes on the last", async () => {
    // The interesting half of that Map. `close` removes the socket from the
    // Set and deletes the KEY only when the Set empties, so a shared pane
    // (desktop plus phone, or a pane plus an E2E spy) is the case where the
    // key delete can be wrong in either direction: too early blacks out the
    // other viewer, too late is the leak.
    const start = await connections();
    const ctxId = "leak-ctx-shared";
    const url = `ws://127.0.0.1:${port}/ws/browser/${ctxId}`;
    const [a, b] = await openAll([url, url]);

    const both = await settle((c) => c.browserWsSockets === start.browserWsSockets + 2);
    expect(both.browserWsContexts).toBe(start.browserWsContexts + 1);
    expect(both.browserWsSockets).toBe(start.browserWsSockets + 2);

    await closeAndWait(a!);
    const one = await settle((c) => c.browserWsSockets === start.browserWsSockets + 1);
    expect(one.browserWsContexts).toBe(start.browserWsContexts + 1);
    expect(one.browserWsSockets).toBe(start.browserWsSockets + 1);

    await closeAndWait(b!);
    const none = await settle((c) => c.browserWsSockets === start.browserWsSockets);
    expect(none.browserWsContexts).toBe(start.browserWsContexts);
    expect(none.browserWsSockets).toBe(start.browserWsSockets);
  }, 20_000);

  test("terminal sockets never enter wsClients in the first place", async () => {
    // The third branch of the same `open` handler. It returns before
    // `wsClients.add`, and `close` returns before `wsClients.delete`: the two
    // early exits have to agree, or a terminal tab would either leak an entry
    // or (worse) delete somebody else's.
    const before = await connections();
    for (let i = 0; i < CYCLES; i++) {
      await openThenClose(`ws://127.0.0.1:${port}/ws/terminal/leak-term-${i}`);
    }
    const after = await settle((c) => c.wsClients === before.wsClients);
    leakCounterLine("ws-registries", "wsClients.size after terminal sockets", before.wsClients, after.wsClients, CYCLES);
    expect(after.wsClients).toBe(before.wsClients);
  }, 30_000);
});
