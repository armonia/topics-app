/**
 * The two routes that expose Claude Code session state to the client.
 *
 * @covers CCS-01
 *
 * Only CCS-01: this file exercises the canonical record through its HTTP read
 * surface. CCS-05 (the `session:state` WS broadcast contract) is NOT proven
 * here — the tracker is built with a no-op broadcast — and claiming it would
 * be the exact disease this gate exists to cure.
 *
 * Why this file exists. On 2026-08-25 an audit of the 310 HTTP routes found an
 * asymmetry worth a test: the state machine underneath is very well covered
 * (`claude-session-state.test.ts` 98 tests, `claude-session-tracker.test.ts`
 * 50, all ten hook events named), but `GET /api/claude-sessions` and
 * `GET /api/claude-sessions/by-key/:sessionKey` — **the whole HTTP surface of
 * that state, 2 routes out of 2** — were named by nothing. The machine could
 * be perfect and the client still receive an empty or half-shaped snapshot,
 * with every gate green.
 *
 * What is pinned here is the SNAPSHOT CONTRACT, not the state machine: the
 * shape a client rebuilds its local cache from on connect. Two properties earn
 * a test, and both are silent when they break:
 *
 *  - the snapshot carries the TRANSCRIPT POINTER (`jsonlPath`, `jsonlOffset`).
 *    The route's own comment says why it is there — answering "is this session
 *    tail-covered?" without server logs. A field quietly dropped from the map
 *    literal takes that answer away and nothing else notices.
 *  - a session that does not exist is a 404, not an empty 200. An empty 200
 *    reads to the client as "the session exists and is idle", which is exactly
 *    the wrong thing to believe about a session that is gone.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";
import { createClaudeSessionTracker, type ClaudeSessionTracker } from "../../server/lib/claude-session-tracker";

const ROOT = testTmpDir("claude-sessions-routes");
beforeAll(() => setupTestDataDir(join(ROOT, "data")));
afterAll(() => cleanupTestDataDir(ROOT));

const T0 = 1_700_000_000_000;
const REPO_ROOT = join(import.meta.dir, "..", "..");

/**
 * The same in-memory schema `claude-session-tracker.test.ts` builds: the two
 * tables plus the real migrations that shape them. Real migrations and not a
 * hand-written CREATE, for the reason `auth-routes.test.ts` already documents —
 * a schema rewritten from memory stops noticing when a CHECK drifts away from
 * the TypeScript union, which has happened twice in this repo.
 */
function dbFresco(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE topics (session_key TEXT PRIMARY KEY)`);
  db.run(`
    CREATE TABLE claude_code_sessions (
      session_key TEXT PRIMARY KEY,
      claude_session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (session_key) REFERENCES topics(session_key) ON DELETE CASCADE
    )
  `);
  const migDir = join(REPO_ROOT, "server", "db", "migrations");
  for (const prefix of ["027-", "096-"]) {
    const file = readdirSync(migDir).find((f) => f.startsWith(prefix))!;
    const sql = readFileSync(join(migDir, file), "utf-8")
      .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";").map((s) => s.trim()).filter(Boolean)) db.run(statement);
  }
  return db;
}

function seed(db: Database, sessionKey: string, claudeSessionId: string, jsonlPath?: string) {
  db.prepare(`INSERT INTO topics VALUES (?)`).run(sessionKey);
  db.prepare(`
    INSERT INTO claude_code_sessions (session_key, claude_session_id, created_at, updated_at, phase, phase_updated_at, jsonl_path)
    VALUES (?, ?, ?, ?, 'starting', ?, ?)
  `).run(sessionKey, claudeSessionId, new Date(T0).toISOString(), new Date(T0).toISOString(), new Date(T0).toISOString(), jsonlPath ?? null);
}

type Router = ReturnType<typeof import("../../server/routes/claude-hooks").createClaudeHooksRouter>;

async function call(router: Router, path: string) {
  const url = new URL(`http://h${path}`);
  const res = await router(new Request(url), url, url.pathname, "GET");
  if (!res) throw new Error(`no route handled GET ${path}`);
  return res;
}

interface Snapshot {
  sessionKey: string;
  claudeSessionId: string;
  phase: string;
  jsonlPath: string | null;
  jsonlOffset: number | null;
}

describe("l'istantanea delle sessioni Claude", () => {
  let db: Database;
  let tracker: ClaudeSessionTracker;
  let router: Router;

  beforeEach(async () => {
    db = dbFresco();
    tracker = createClaudeSessionTracker({ db, broadcast: () => {}, coalesceWindowMs: 20, dedupWindowMs: 100, rateLimitPerSec: 50 });
    const ctx = await createTestAppContext();
    const { createClaudeHooksRouter } = await import("../../server/routes/claude-hooks");
    router = createClaudeHooksRouter(ctx, tracker);
  });

  test("a mani vuote e' una lista vuota, non un errore", async () => {
    const res = await call(router, "/api/claude-sessions");
    expect(res.status).toBe(200);
    const { sessions } = (await res.json()) as { sessions: Snapshot[] };
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions).toEqual([]);
  });

  test("ogni sessione porta il puntatore al transcript, non solo la fase", async () => {
    seed(db, "topic:uno", "cli-uno", "/tmp/finto/uno.jsonl");
    seed(db, "topic:due", "cli-due");

    const res = await call(router, "/api/claude-sessions");
    expect(res.status).toBe(200);
    const { sessions } = (await res.json()) as { sessions: Snapshot[] };
    expect(sessions).toHaveLength(2);

    const one = sessions.find((s) => s.sessionKey === "topic:uno")!;
    expect(one).toBeTruthy();
    expect(one.claudeSessionId).toBe("cli-uno");
    expect(one.phase).toBe("starting");

    // The pointer: it is the field the route's own comment declares it serves
    // on purpose, and it is the one that disappears quietly if somebody thins
    // out the map literal.
    expect(Object.keys(one)).toContain("jsonlPath");
    expect(Object.keys(one)).toContain("jsonlOffset");
    expect(one.jsonlPath).toBe("/tmp/finto/uno.jsonl");

    // A session with no transcript does NOT carry the key: `JSON.stringify`
    // strips the `undefined`s, so on the wire `jsonlPath` simply is not there.
    // That is fine - the client reads `undefined` in both cases - and it has to
    // be said here, because a test demanding `null` would fail on correct
    // behaviour and would get switched off instead of read.
    const due = sessions.find((s) => s.sessionKey === "topic:due")!;
    expect(due.jsonlPath ?? null).toBeNull();
  });

  test("una sessione sola si chiede per chiave, e quella che non c'e' e' 404", async () => {
    seed(db, "topic:tre", "cli-tre");

    const found = await call(router, "/api/claude-sessions/by-key/topic:tre");
    expect(found.status).toBe(200);
    const { session } = (await found.json()) as { session: Snapshot };
    expect(session.sessionKey).toBe("topic:tre");
    expect(session.claudeSessionId).toBe("cli-tre");

    // 404 and not an empty 200: to a client a 200 with no session reads as
    // "it is there, and it is idle", which is the wrong thing to believe about
    // a session that no longer exists.
    const missing = await call(router, "/api/claude-sessions/by-key/topic:mai-esistita");
    expect(missing.status).toBe(404);
  });

  test("l'istantanea segue la fase che gli hook fanno cambiare", async () => {
    // The link between the two halves: the state machine is tested elsewhere,
    // here what gets tested is that the route reports the CURRENT STATE and not
    // a copy frozen at the first round.
    seed(db, "topic:quattro", "cli-quattro");

    const before = (await (await call(router, "/api/claude-sessions/by-key/topic:quattro")).json()) as { session: Snapshot };
    expect(before.session.phase).toBe("starting");

    tracker.ingestHook({ hook_event_name: "UserPromptSubmit", session_id: "cli-quattro" } as never);

    const after = (await (await call(router, "/api/claude-sessions/by-key/topic:quattro")).json()) as { session: Snapshot };
    expect(after.session.phase, "la rotta serve una copia congelata invece dello stato vivo").not.toBe("starting");
  });
});
