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
 * The real server only sees ROWS here (nothing registers a question in its
 * memory): that the same chat is not ALSO counted as a stream, and every other
 * rule of the split, is proven where the registry can be driven, in
 * `server/boot/quiescence.test.ts`.
 *
 * Four things to pin down:
 *   - the answer has the promised shape (`idle`, `inFlight`, `holding`,
 *     `unrecoverable`, `waitingOnPerson`, `alreadyWaiting`) and a server at rest
 *     says "idle";
 *   - a row left `partial = 1` for hours is not a turn, and a chat parked on a
 *     question nobody answered is not WORK: `idle` stays true, the question is
 *     counted apart (RGATE-12). The rows are written from outside, into the
 *     database the server has open, like a restart leaves them;
 *   - same door as the other `/__daemon/*` routes: no bearer, 401;
 *   - it is REALLY read-only: after several GETs no wait has started
 *     (`alreadyWaiting` stays false) and the process is still alive. A GET that
 *     started the wait on a server at rest would see it leave the `for(;;)` on
 *     the first lap and SIGTERM itself: that is the mutant this test must turn
 *     red.
 *
 * @covers RGATE-08, RGATE-12
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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
      waitingOnPerson: 0,
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

/**
 * An assistant row as a turn that never ended leaves it. Written into the
 * server's own database from a second connection (WAL: both may be open).
 */
function seedPartialRow(opts: { id: string; sessionKey: string; ageHours: number; tool?: Record<string, unknown> }): void {
  const db = new Database(join(ROOT, "data", "topics.db"));
  try {
    const at = new Date(Date.now() - opts.ageHours * 3_600_000).toISOString();
    const toolCalls = opts.tool ? JSON.stringify([{ id: `${opts.id}-tool`, name: "ask_user_question", startedAt: Date.parse(at), ...opts.tool }]) : null;
    db.run(
      "INSERT INTO messages (id, session_key, role, content, tool_calls, partial, timestamp, sort_order) VALUES (?, ?, 'assistant', '', ?, 1, ?, 1)",
      [opts.id, opts.sessionKey, toolCalls, at],
    );
  } finally {
    db.close();
  }
}

/** Leave the database as found, so the next test starts from the same rows. */
function clearSeededRows(): void {
  const db = new Database(join(ROOT, "data", "topics.db"));
  try { db.run("DELETE FROM messages WHERE partial = 1"); } finally { db.close(); }
}

/**
 * The gate reads the rows through a probe it caches for 5 s
 * (`QUIESCENCE_BROKER_PROBE_MS`, server/boot/quiescence.ts): poll until it has
 * looked. The fixed 6 s waits below are that window plus a second.
 */
async function idleUntil(accept: (body: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 20_000;
  let body: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const res = await fetch(`${server.baseUrl}/__daemon/idle`, { headers: bearer() });
    body = await res.json() as Record<string, unknown>;
    if (accept(body)) return body;
    await new Promise((r) => setTimeout(r, 500));
  }
  return body;
}

describe("GET /__daemon/idle over rows a turn left behind", () => {
  afterEach(clearSeededRows);

  test("a row left partial for hours, with nothing running behind it, is not counted", async () => {
    seedPartialRow({ id: "stale-partial", sessionKey: "topic:5ca1ab1e", ageHours: 10 });
    // Look past the probe's cache: the answer must not move.
    await new Promise((r) => setTimeout(r, 6_000));
    const res = await fetch(`${server.baseUrl}/__daemon/idle`, { headers: bearer() });
    const body = await res.json();
    expect(body.idle).toBe(true);
    expect(body.holding).toBeNull();
    expect(body.waitingOnPerson).toBe(0);
  }, 30_000);

  test("a chat parked on an unanswered question is listed, and is not work", async () => {
    seedPartialRow({ id: "open-question", sessionKey: "topic:0b0e0b0e", ageHours: 10, tool: { status: "waiting_for_input" } });
    const body = await idleUntil((b) => b.waitingOnPerson === 1);
    // Ten hours of silence on a question that has no clock: nothing is
    // computing, so the machine is idle; the sentence still names who waits.
    expect(body.waitingOnPerson).toBe(1);
    expect(body.idle).toBe(true);
    expect(body.holding).toBe("1 chat ferma/e su una domanda (topic:0b0e0b0e)");
    expect(body.inFlight).toBe(0);
    expect(body.unrecoverable).toBe(0);
  }, 30_000);

  test("a question whose asker is gone holds nothing, and says nothing", async () => {
    // `askerGone`: no process is blocked on it any more, so it is not parked.
    seedPartialRow({ id: "orphan-question", sessionKey: "topic:0f0f0f0f", ageHours: 3, tool: { status: "waiting_for_input", askerGone: true } });
    await new Promise((r) => setTimeout(r, 6_000));
    const res = await fetch(`${server.baseUrl}/__daemon/idle`, { headers: bearer() });
    const body = await res.json();
    expect(body.waitingOnPerson).toBe(0);
    expect(body.holding).toBeNull();
    expect(body.idle).toBe(true);
  }, 30_000);
});

