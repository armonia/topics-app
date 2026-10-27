/**
 * `GET /__daemon/idle`: "is a turn in flight?", and nothing else.
 *
 * The conditional restart in the hub must be able to ask before committing.
 * `POST /__daemon/restart-when-idle` answers the same question but opens a wait
 * and then sends the SIGTERM: there was no way to read the state that did not
 * also change it. This is that way, and it is proven on the REAL server (the
 * route lives inline in `server.ts`, which boots on import): a test on a replica
 * of the handler body would not see a `waitForDispatcherQuiescent` added by
 * mistake upstream of it.
 *
 * Three things to pin down:
 *   - the answer has the promised shape (`idle`, `inFlight`, `holding`,
 *     `unrecoverable`, `alreadyWaiting`) and a server at rest says "idle";
 *   - same door as the other `/__daemon/*` routes: no bearer, 401;
 *   - it is REALLY read-only: after several GETs no wait has started
 *     (`alreadyWaiting` stays false) and the process is still alive. A GET that
 *     started the wait on a server at rest would see it leave the `for(;;)` on
 *     the first lap and SIGTERM itself: that is the mutant this test must turn
 *     red.
 *
 * @covers RGATE-08
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { spawnRealServer, testTmpDir, type RealServer } from "./helpers";

const ROOT = testTmpDir("daemon-idle-get");
let server: RealServer;
let token = "";
let pid = 0;

/** The server writes its state (with the token) under `$TOPICS_HOME`, which `spawnRealServer` places here. */
function readDaemonState(): { pid: number; token: string } {
  return JSON.parse(fs.readFileSync(join(ROOT, "topics-home", "daemon-state.json"), "utf-8"));
}

const bearer = () => ({ authorization: `Bearer ${token}` });

function alive(): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

beforeAll(async () => {
  server = await spawnRealServer(ROOT);
  ({ pid, token } = readDaemonState());
}, 90_000);

afterAll(async () => {
  await server?.stop();
});

describe("GET /__daemon/idle", () => {
  test("a server at rest answers idle, with the whole shape", async () => {
    const res = await fetch(`${server.baseUrl}/__daemon/idle`, { headers: bearer() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      idle: true,
      inFlight: 0,
      holding: null,
      unrecoverable: 0,
      alreadyWaiting: false,
    });
  });

  test("it wants the same token as the other /__daemon/* routes", async () => {
    const none = await fetch(`${server.baseUrl}/__daemon/idle`);
    expect(none.status).toBe(401);
    const wrong = await fetch(`${server.baseUrl}/__daemon/idle`, {
      headers: { authorization: `Bearer ${"0".repeat(64)}` },
    });
    expect(wrong.status).toBe(401);
  });

  test("reading it starts no wait and sends no signal", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${server.baseUrl}/__daemon/idle`, { headers: bearer() });
      expect((await res.json()).alreadyWaiting).toBe(false);
    }
    // The wait of a server at rest ends on the first lap (<= 500 ms) and the
    // SIGTERM follows at once: a second and a half of margin, then look.
    await new Promise((r) => setTimeout(r, 1_500));
    expect(alive()).toBe(true);
    const health = await fetch(`${server.baseUrl}/__daemon/healthz`, { headers: bearer() });
    expect(health.status).toBe(200);
    const after = await fetch(`${server.baseUrl}/__daemon/idle`, { headers: bearer() });
    expect((await after.json()).alreadyWaiting).toBe(false);
  }, 30_000);

  test("only GET: a POST to the same path is not a way in", async () => {
    const res = await fetch(`${server.baseUrl}/__daemon/idle`, { method: "POST", headers: bearer() });
    expect(res.status).toBe(404);
    expect(alive()).toBe(true);
  });
});
