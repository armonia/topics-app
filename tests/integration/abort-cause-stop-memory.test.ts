/**
 * A STOP IS THE PERSON'S ONLY WHEN THE PERSON PRESSED IT (card C9).
 *
 * On 25/09 the stall judge of a headless reattach found the home chat 3019832f
 * "stuck" while it only waited for its background agent, and recycled it
 * through `/api/chat/abort`: the route signed the stop as the person's, the
 * CLI got SIGINT and logged "user stop". With the durable Stop the resume sweep
 * reads after a restart (`logStopPressed`), that recycle would also have kept
 * the message from ever being resumed: a recoverable failure made permanent.
 *
 * The route runs for real on a real database; the provider is a real registry
 * entry whose `abort` records the reason it was given. The restart is the
 * turn-end registry emptied, as a boot finds it.
 *
 * @covers RESUME-02
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import { createTopicsRouter } from "../../server/routes/topics";
import { internalAbortRequest } from "../../server/lib/abort-cause";
import { riprendiTurniInterrotti } from "../../server/lib/ripresa-boot";
import { STOP_PRESSED_LOG_TITLE } from "../../server/lib/cancelled-notice";
import { readTurnEnd, resetTurnEndRegistry } from "../../server/providers/turn-end-registry";
import { registerProvider, removeProvider } from "../../server/providers";
import type { AbortReason } from "../../server/providers/types";
import type { Topic } from "../../server/types";

const TEST_DATA = testTmpDir("abort-cause-data");
beforeAll(() => setupTestDataDir(TEST_DATA));

const reasons: AbortReason[] = [];
const provider = registerProvider({ type: "openai", apiKey: "" } as never) as unknown as Record<string, unknown>;
Object.defineProperty(provider, "connected", { configurable: true, get: () => true });
provider.abort = async (_sk: string, _runId: string | undefined, reason: AbortReason) => { reasons.push(reason); };
afterAll(() => { try { removeProvider("openai"); } catch { /* already gone */ } });

/** A chat whose last word is a message five minutes old, with its turn live. */
async function liveChat(sessionKey: string) {
  const ctx = await createTestAppContext();
  const topic: Topic = {
    id: `t-${sessionKey}`, name: "stop memory", slug: "stop-memory", parentId: null, links: [],
    sessionKey, color: "#5865f2", icon: "MessageSquare",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    archived: false, provider: "openai",
  } as Topic;
  ctx.saveSingleTopic(topic);
  ctx.saveLocalMessages(sessionKey, [{
    id: `${sessionKey}-u1`, role: "user", content: "Due cose per il vortice",
    timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
  }]);
  ctx.startStream(sessionKey, `${sessionKey}-partial`, new AbortController());
  const router = createTopicsRouter(ctx);
  const abort = (req: Request) => {
    const url = new URL(req.url);
    return router(req, url, url.pathname, "POST") as Promise<Response>;
  };
  const stopsOnRecord = () => (ctx.db.query(
    "SELECT COUNT(*) AS n FROM activity_log WHERE session_key = ? AND title = ?",
  ).get(sessionKey, STOP_PRESSED_LOG_TITLE) as { n: number }).n;
  /** The first sweep after a boot: the registry is empty, the database is not.
   *  The database is shared by the file, so only THIS chat's resend counts. */
  const resentAfterRestart = async (): Promise<boolean> => {
    resetTurnEndRegistry();
    let resent = false;
    const log = console.log, warn = console.warn;
    console.log = () => {}; console.warn = () => {};
    try {
      await riprendiTurniInterrotti(
        {
          db: ctx.db,
          getTopicBySessionKey: (key) => ctx.getTopicBySessionKey(key),
          isStreaming: () => false,
          providerBusy: () => false,
          bootedAtMs: Date.now(),
        },
        async (req) => {
          const body = await req.clone().json().catch(() => null) as { sessionKey?: string } | null;
          if (body?.sessionKey === sessionKey) resent = true;
          return new Response(null, { status: 200 });
        },
        { responseMs: 500, streamMs: 500 },
      );
    } finally { console.log = log; console.warn = warn; }
    return resent;
  };
  return { abort, stopsOnRecord, resentAfterRestart };
}

describe("who stopped the turn is said by whoever stopped it", () => {
  test("the stall judge's recycle is not a person's Stop, and the message is resumed after a restart", async () => {
    const sk = "topic:c9-stall";
    const chat = await liveChat(sk);
    reasons.length = 0;
    // What `abortHeadlessTurn` sends when the judge finds the turn stuck.
    const resp = await chat.abort(internalAbortRequest(sk, "stall"));
    expect(resp.status).toBe(200);

    expect(readTurnEnd(sk)?.info).toMatchObject({ end: "cancelled", cause: "stall" });
    expect(reasons).toEqual(["watchdog"]);
    expect(chat.stopsOnRecord()).toBe(0);
    expect(await chat.resentAfterRestart()).toBe(true);
  });

  test("the person's Stop from the client is kept, and holds across a restart", async () => {
    const sk = "topic:c9-person";
    const chat = await liveChat(sk);
    reasons.length = 0;
    // The client's request: no cause, as the Stop button sends it.
    const resp = await chat.abort(new Request("http://topics.test/api/chat/abort", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey: sk }),
    }));
    expect(resp.status).toBe(200);

    expect(readTurnEnd(sk)?.info).toMatchObject({ end: "cancelled", cause: "user" });
    expect(reasons).toEqual(["user"]);
    expect(chat.stopsOnRecord()).toBe(1);
    expect(await chat.resentAfterRestart()).toBe(false);
  });
});
