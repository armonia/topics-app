/**
 * Channel senders and usage per person: the four bars of the change.
 *  (a) sender → person created once and reused, owner → default, missing → unchanged
 *  (b) backfill of the senders written in the text, on a synthetic DB
 *  (c) person-usage: subagent inheritance, points split per hour, reset
 *  (d) POST /api/usage/records idempotent
 *  (e) one human seen on two channels folded into one person; the cached list shows it at once
 * The real migration runs on the in-memory DB: the file is tested, not a copy of it.
 * @covers USAGE-27
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorForSender, channelOnlyPeople, mergeChannelPerson, parseSender, senderAllowed } from "../lib/person-identities";
import { backfillMessageSenders, lastSenderTag } from "../../scripts/backfill-message-senders";
import { computeCalls, peopleUsage, personDetail, pointsPerHour, splitPoints, HOUR_MS, type Call } from "./person-usage";
import { createUsageRouter, parseUsageRecord, insertUsageRecord } from "../routes/usage";
import type { PeopleUsage } from "../../shared/person-usage";

const MIGRATION = await Bun.file(join(import.meta.dir, "../db/migrations/20261117150000-person-identities.sql")).text();
const PROJECT_MIGRATION = await Bun.file(join(import.meta.dir, "../db/migrations/20261118100000-usage-project-path.sql")).text();
const OWNER = "owner-1";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE people (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, email TEXT, created_at INTEGER NOT NULL, revoked_at INTEGER,
    origin TEXT NOT NULL DEFAULT 'local', remote_id TEXT, rev INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, synced_at INTEGER)`);
  db.run(`CREATE TABLE installation_owners (person_id TEXT PRIMARY KEY, added_at INTEGER NOT NULL, is_default INTEGER NOT NULL DEFAULT 0)`);
  db.run(`CREATE TABLE devices (id TEXT PRIMARY KEY, person_id TEXT, revoked_at INTEGER)`);
  db.run(`CREATE TABLE org_members (org_id TEXT NOT NULL, person_id TEXT NOT NULL REFERENCES people(id), PRIMARY KEY (org_id, person_id))`);
  db.run(`CREATE TABLE tasks (id TEXT PRIMARY KEY, run_initiator_person_id TEXT)`);
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT NOT NULL, session_key TEXT NOT NULL, provider TEXT, project_path TEXT)`);
  db.run(`CREATE TABLE messages (id TEXT PRIMARY KEY, session_key TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', timestamp TEXT NOT NULL,
    blocks TEXT, usage_prompt_tokens INTEGER, usage_completion_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
    author_person_id TEXT, author_device_id TEXT)`);
  db.run(`CREATE TABLE subagents (id TEXT PRIMARY KEY, parent_session_key TEXT NOT NULL, session_key TEXT, claude_session_id TEXT, cwd TEXT NOT NULL,
    runtime TEXT NOT NULL DEFAULT 'claude-code', created_at TEXT NOT NULL)`);
  db.run(`CREATE TABLE usage_records (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), timestamp INTEGER NOT NULL, session_key TEXT NOT NULL,
    topic_id TEXT, model TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, cost_usd REAL, purpose TEXT, provider TEXT,
    cache_read_tokens INTEGER, cache_creation_tokens INTEGER, cache_creation_1h_tokens INTEGER, duration_ms INTEGER, measured INTEGER NOT NULL DEFAULT 1, error TEXT)`);
  db.exec(MIGRATION);
  db.exec(PROJECT_MIGRATION);
  db.run("INSERT INTO people (id, display_name, created_at, updated_at) VALUES (?, 'Owner', 0, 0)", [OWNER]);
  db.run("INSERT INTO installation_owners (person_id, added_at, is_default) VALUES (?, 0, 1)", [OWNER]);
  return db;
}

describe("(a) sender", () => {
  test("una persona per (canale, id): creata la prima volta, poi riusata", () => {
    const db = makeDb();
    const s = parseSender({ channel: "discord", id: "123", name: "Cliente" })!;
    const a = authorForSender(db, s).authorPersonId;
    const b = authorForSender(db, { ...s, name: "Altro nome" }).authorPersonId;
    expect(a).toBe(b);
    expect(a).not.toBe(OWNER);
    expect((db.query("SELECT COUNT(*) n FROM people").get() as { n: number }).n).toBe(2);
    expect((db.query("SELECT display_name FROM people WHERE id = ?").get(a) as { display_name: string }).display_name).toBe("Cliente");
    // same id on another channel = another person
    expect(authorForSender(db, { channel: "whatsapp", id: "123", name: "X" }).authorPersonId).not.toBe(a);
  });
  test("owner → persona predefinita, senza creare nessuno", () => {
    const db = makeDb();
    expect(authorForSender(db, parseSender({ channel: "discord", id: "9", name: "Io", owner: true })!).authorPersonId).toBe(OWNER);
    expect((db.query("SELECT COUNT(*) n FROM person_identities").get() as { n: number }).n).toBe(0);
  });
  test("assente o malformato → nessun sender (vale la regola di prima)", () => {
    expect(parseSender(undefined)).toBeNull();
    expect(parseSender({ channel: "discord" })).toBeNull();
    expect(parseSender("x")).toBeNull();
  });
  test("WhatsApp: +numero, jid e @c.us sono la stessa persona; nome vuoto = id", () => {
    const db = makeDb();
    const a = authorForSender(db, { channel: "whatsapp", id: "+390000000001", name: "" }).authorPersonId;
    expect(authorForSender(db, { channel: "whatsapp", id: "390000000001@s.whatsapp.net", name: "Z" }).authorPersonId).toBe(a);
    expect(authorForSender(db, { channel: "whatsapp", id: "390000000001@c.us", name: "Z" }).authorPersonId).toBe(a);
    expect((db.query("SELECT display_name n FROM people WHERE id = ?").get(a) as { n: string }).n).toBe("390000000001");
  });
  test("solo il proprietario lo dichiara", () => {
    expect(senderAllowed(null)).toBe(true);
    expect(senderAllowed({ role: "owner" })).toBe(true);
    expect(senderAllowed({ role: "guest" })).toBe(false);
    expect(senderAllowed({ role: "owner", delegatedAuthorizationId: "d" })).toBe(false);
  });
});

describe("(b) backfill", () => {
  test("ultimo tag: canale dalla forma dell'id, proprietario, nome senza virgola", () => {
    expect(lastSenderTag('<messaggio da="Ann (+391234567)">ciao')).toEqual({ name: "Ann", externalId: "391234567", channel: "whatsapp", owner: false });
    expect(lastSenderTag('<messaggio da="Bob, Ditta (10000000000000000001)" proprietario="sì">x')!.owner).toBe(true);
    expect(lastSenderTag('<messaggio da="391234567@s.whatsapp.net">x')).toMatchObject({ channel: "whatsapp", externalId: "391234567", name: "391234567" });
    expect(lastSenderTag('<messaggio da="cli">x')).toMatchObject({ channel: "legacy", externalId: "cli" });
    expect(lastSenderTag("niente tag")).toBeNull();
    // a system tag is nobody; with an external sender and the owner in the same message the external one wins
    expect(lastSenderTag('<messaggio da="-">giro')).toBeNull();
    expect(lastSenderTag('<messaggio da="Ann (+391234567)">a</messaggio><messaggio da="Io (921)" proprietario="sì">b')).toMatchObject({ externalId: "391234567", owner: false });
  });
  test("un id visto col segno di proprietario resta suo anche dove il segno manca", () => {
    const db = makeDb();
    const insert = db.query("INSERT INTO messages (id, session_key, role, content, timestamp, author_person_id) VALUES (?, 's', 'user', ?, '2026-11-01T00:00:00Z', ?)");
    insert.run("m1", '<messaggio da="Io (10000000000000000009)" proprietario="sì">a', OWNER);
    insert.run("m2", '<messaggio da="Io (10000000000000000009)">b', OWNER);
    const r = backfillMessageSenders(db, { apply: true });
    expect(r.changed).toBe(0);
    expect((db.query("SELECT COUNT(*) n FROM people").get() as { n: number }).n).toBe(1);
  });
  test("non sovrascrive un autore che non è il proprietario", () => {
    const db = makeDb();
    db.query("INSERT INTO people (id, display_name, created_at, origin, rev, updated_at) VALUES ('manuale', 'Scelto a mano', 1, 'local', 1, 1)").run();
    db.query("INSERT INTO messages (id, session_key, role, content, timestamp, author_person_id) VALUES ('m1', 's', 'user', ?, '2026-11-01T00:00:00Z', 'manuale')")
      .run('<messaggio da="Ann (10000000000000000001)">a');
    expect(backfillMessageSenders(db, { apply: true }).changed).toBe(0);
    expect((db.query("SELECT author_person_id p FROM messages WHERE id = 'm1'").get() as { p: string }).p).toBe("manuale");
  });
  test("scrive gli autori, dry run non tocca nulla, rieseguibile", () => {
    const db = makeDb();
    const insert = db.query("INSERT INTO messages (id, session_key, role, content, timestamp, author_person_id) VALUES (?, 's', 'user', ?, '2026-11-01T00:00:00Z', ?)");
    insert.run("m1", '<messaggio da="Ann (10000000000000000001)">a', OWNER);
    insert.run("m2", '<messaggio da="Ann (10000000000000000001)">b', OWNER);
    insert.run("m3", '<messaggio da="Io (921)" proprietario="sì">c', null);
    insert.run("m4", "scritto a mano", OWNER);
    const dry = backfillMessageSenders(db, { apply: false });
    expect(dry.changed).toBe(3);
    expect((db.query("SELECT COUNT(*) n FROM people").get() as { n: number }).n).toBe(1);
    const r = backfillMessageSenders(db, { apply: true });
    // two new identities: Ann's and the owner's (921), bound to the owner and not to a new person
    expect(r).toMatchObject({ scanned: 3, changed: 3, ownerRows: 1, created: 2 });
    expect((db.query("SELECT COUNT(*) n FROM people").get() as { n: number }).n).toBe(2);
    const pid = (id: string) => (db.query("SELECT author_person_id p FROM messages WHERE id = ?").get(id) as { p: string }).p;
    expect(pid("m1")).toBe(pid("m2"));
    expect(pid("m1")).not.toBe(OWNER);
    expect(pid("m3")).toBe(OWNER);
    expect(pid("m4")).toBe(OWNER);
    expect(backfillMessageSenders(db, { apply: true }).changed).toBe(0);
  });
});

describe("(c) person-usage", () => {
  const H0 = Date.UTC(2026, 10, 10, 10);
  test("punti per ora: aumenti per account, un calo è un reset che conta il valore nuovo", () => {
    const t = (ms: number) => ms / 1000;
    const points = pointsPerHour([
      { t: t(H0), s: { "claude|a|7d": 10, "claude|b|7d": 50, "codex|a|7d": 1 } },
      { t: t(H0 + 30 * 60_000), s: { "claude|a|7d": 14, "claude|b|7d": 51, "codex|a|7d": 90 } },
      { t: t(H0 + HOUR_MS + 1), s: { "claude|a|7d": 3, "claude|b|7d": 51 } },
    ], H0 - 1, H0 + 2 * HOUR_MS);
    expect(points.get(Math.floor(H0 / HOUR_MS))).toBe(5);
    expect(points.get(Math.floor(H0 / HOUR_MS) + 1)).toBe(3);
  });
  test("un calo di un punto è rumore di lettura, non un reset", () => {
    const t = (ms: number) => ms / 1000;
    const seq = [31, 30, 31, 67, 66, 67, 96, 95, 96];
    const lines = seq.map((v, i) => ({ t: t(H0 + i * 60_000), s: { "claude|a|7d": v } }));
    const total = [...pointsPerHour(lines, H0 - 1, H0 + HOUR_MS).values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(96 - 31);
  });
  test("a dip before the window does not make the return inside it count", () => {
    const t = (ms: number) => ms / 1000;
    const lines = [
      { t: t(H0 - 3 * 60_000), s: { "claude|a|7d": 31 } },
      { t: t(H0 - 2 * 60_000), s: { "claude|a|7d": 30 } },
      { t: t(H0 + 60_000), s: { "claude|a|7d": 31 } },
    ];
    const total = [...pointsPerHour(lines, H0, H0 + HOUR_MS).values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(0);
  });
  test("un reset vero 100 -> 2 conta 2", () => {
    const t = (ms: number) => ms / 1000;
    const points = pointsPerHour([
      { t: t(H0), s: { "claude|a|7d": 100 } },
      { t: t(H0 + 60_000), s: { "claude|a|7d": 2 } },
    ], H0 - 1, H0 + HOUR_MS);
    expect(points.get(Math.floor(H0 / HOUR_MS))).toBe(2);
  });
  test("i punti dell'ora si dividono in proporzione al peso", () => {
    const c = (ts: number, weight: number): Call => ({ ts, weight, personId: null, chatKey: "s", requestId: null, requestText: "", source: "native" });
    const calls = splitPoints([c(H0, 1), c(H0 + 10, 3), c(H0 + HOUR_MS, 5)], new Map([[Math.floor(H0 / HOUR_MS), 8]]));
    expect(calls.map((x) => x.points)).toEqual([2, 6, 0]);
  });
  test("sottoagenti: eredità ricorsiva dall'autore della madre alla nascita, transcript compresi, più i record", () => {
    const db = makeDb();
    db.run("INSERT INTO people (id, display_name, created_at, updated_at) VALUES ('ann', 'Ann', 0, 0)");
    db.run("INSERT INTO topics (id, name, session_key, provider) VALUES ('t1', 'Chat', 'root', 'topics')");
    const iso = (ms: number) => new Date(ms).toISOString();
    const msg = db.query(`INSERT INTO messages (id, session_key, role, content, timestamp, author_person_id, blocks, usage_prompt_tokens, usage_completion_tokens,
      cache_read_tokens, cache_creation_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    msg.run("u1", "root", "user", "fai", iso(H0), "ann", null, null, null, null, null);
    msg.run("u2", "root", "user", "io ora", iso(H0 + 40 * 60_000), OWNER, null, null, null, null, null);
    // a subagent's result does not change the author
    msg.run("u3", "root", "user", "risultato", iso(H0 + 5 * 60_000), OWNER, '[{"kind":"subagent-result"}]', null, null, null, null);
    msg.run("a1", "root", "assistant", "", iso(H0 + 6 * 60_000), null, null, 1000, 10, 800, 100); // real input 100: 100+50+125+80 = 355
    // native child born at +2 min (author Ann), grandchild born at +45 min: inherits from its parent at its birth
    db.run(`INSERT INTO subagents (id, parent_session_key, session_key, cwd, runtime, created_at) VALUES ('c', 'root', 'child', '/x', 'topics', ?)`, [iso(H0 + 2 * 60_000)]);
    db.run(`INSERT INTO subagents (id, parent_session_key, session_key, cwd, runtime, created_at) VALUES ('g', 'child', 'grand', '/x', 'topics', ?)`, [iso(H0 + 3 * 60_000)]);
    msg.run("cu", "child", "user", "prompt dalla madre", iso(H0 + 2 * 60_000), OWNER, null, null, null, null, null);
    msg.run("ca", "child", "assistant", "", iso(H0 + 50 * 60_000), null, null, 100, 0, 0, 0);
    msg.run("ga", "grand", "assistant", "", iso(H0 + 50 * 60_000), null, null, 100, 0, 0, 0);
    // Claude Code subagent born after the owner's message: it is the owner's
    db.run(`INSERT INTO subagents (id, parent_session_key, claude_session_id, cwd, runtime, created_at) VALUES ('cc', 'root', 'csid', '/x', 'claude-code', ?)`, [iso(H0 + 41 * 60_000)]);
    insertUsageRecord(db, parseUsageRecord({ id: "r1", ts: H0 + 55 * 60_000, model: "m", purpose: "channel-turn", inputTokens: 45, sender: { channel: "discord", id: "77", name: "Bea" } }) as never);

    const dir = mkdtempSync(join(tmpdir(), "pu-"));
    try {
      const hist = join(dir, "h.jsonl");
      writeFileSync(hist, [JSON.stringify({ t: H0 / 1000, s: { "claude|a|7d": 0 } }), JSON.stringify({ t: (H0 + 59 * 60_000) / 1000, s: { "claude|a|7d": 10 } })].join("\n"));
      const c = computeCalls(db as never, {
        days: 1, now: H0 + 2 * HOUR_MS, historyFile: hist,
        readTranscript: (_cwd, sid) => (sid === "csid" ? [{ ts: H0 + 42 * 60_000, usage: { input: 400, output: 0, cacheWrite: 0, cacheRead: 0 } }] : []),
      });
      const byName = Object.fromEntries(peopleUsage(c, db as never).people.map((p) => [p.name, p]));
      expect(byName.Ann!.weighted).toBe(355 + 100 + 100);
      expect(byName.Owner!.weighted).toBe(400);
      expect(byName.Bea!.weighted).toBe(45);
      // 10 points in one hour split by weight: 555/1000 to Ann
      expect(byName.Ann!.accountPct).toBe(5.6);
      expect(byName.Owner!.accountPct).toBe(4);
      const detail = personDetail(c, db as never, "ann");
      expect(detail.requests).toHaveLength(1);
      expect(detail.requests[0]).toMatchObject({ chatName: "Chat", requestId: "u1", calls: 3 });
      // no history: it says so and gives only the weighted tokens
      const none = peopleUsage(computeCalls(db as never, { days: 1, now: H0 + 2 * HOUR_MS, historyFile: join(dir, "manca.jsonl"), readTranscript: () => [] }), db as never);
      expect(none.quotaHistory).toBe(false);
      expect(none.people.every((p) => p.accountPct === null)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("(d) POST /api/usage/records", () => {
  const ctxOf = (db: Database, role: "owner" | "guest" = "owner") => ({
    db, json: (b: unknown, status = 200) => Response.json(b, { status }),
    errorResponse: (s: number, m: string) => Response.json({ error: m }, { status: s }),
    requestIdentity: () => ({ role, deviceId: null }),
  }) as never;
  const post = (router: ReturnType<typeof createUsageRouter>, body: unknown) => {
    const req = new Request("http://x/api/usage/records", { method: "POST", body: JSON.stringify(body) });
    return router(req, new URL(req.url), "/api/usage/records", "POST");
  };
  const record = { id: "turn-1", ts: Date.UTC(2026, 10, 10), model: "claude", purpose: "channel-turn", inputTokens: 10, outputTokens: 2, sender: { channel: "discord", id: "5", name: "Cy" } };

  test("idempotente sull'id del chiamante, con l'autore", async () => {
    const db = makeDb();
    const router = createUsageRouter(ctxOf(db));
    expect((await post(router, record))!.status).toBe(201);
    const again = await post(router, record);
    expect(again!.status).toBe(200);
    expect(await again!.json()).toMatchObject({ id: "turn-1", duplicate: true });
    const rows = db.query("SELECT author_person_id p FROM usage_records").all() as Array<{ p: string }>;
    expect(rows).toHaveLength(1);
    expect((db.query("SELECT display_name n FROM people WHERE id = ?").get(rows[0]!.p) as { n: string }).n).toBe("Cy");
  });
  test("rifiuta un corpo incompleto e un ospite", async () => {
    const db = makeDb();
    expect((await post(createUsageRouter(ctxOf(db)), { ...record, sender: undefined }))!.status).toBe(400);
    expect((await post(createUsageRouter(ctxOf(db, "guest")), record))!.status).toBe(403);
  });
});

describe("(e) merging two people", () => {
  // foreign keys on, as in server/db.ts: a reference the merge forgot would stop the DELETE
  const withMergeTables = (db: Database) => { db.run("PRAGMA foreign_keys = ON"); return db; };

  test("the channel person folds into the other: identities, messages, records and tasks follow, the row goes", () => {
    const db = withMergeTables(makeDb());
    const discord = authorForSender(db, { channel: "discord", id: "10000000000000000002", name: "Dee" }).authorPersonId!;
    const whatsapp = authorForSender(db, { channel: "whatsapp", id: "+391234500", name: "Dee" }).authorPersonId!;
    db.run("INSERT INTO messages (id, session_key, role, content, timestamp, author_person_id) VALUES ('w1', 's', 'user', 'x', '2026-11-01T00:00:00Z', ?)", [whatsapp]);
    db.run("INSERT INTO tasks (id, run_initiator_person_id) VALUES ('t1', ?)", [whatsapp]);
    insertUsageRecord(db, parseUsageRecord({ id: "r9", ts: 1, model: "m", purpose: "p", sender: { channel: "whatsapp", id: "391234500", name: "Dee" } }) as never);

    expect(mergeChannelPerson(db, whatsapp, discord)).toEqual({ ok: true, moved: { identities: 1, messages: 1, usageRecords: 1, tasks: 1 } });
    expect(db.query("SELECT 1 FROM people WHERE id = ?").get(whatsapp)).toBeNull();
    // the next message from WhatsApp lands on the merged person, not on a new one
    expect(authorForSender(db, { channel: "whatsapp", id: "391234500@s.whatsapp.net", name: "Dee" }).authorPersonId).toBe(discord);
    expect((db.query("SELECT COUNT(*) n FROM people").get() as { n: number }).n).toBe(2);
  });

  test("refuses the owner, a person with an organisation, a missing person and a merge into itself", () => {
    const db = withMergeTables(makeDb());
    const a = authorForSender(db, { channel: "discord", id: "10000000000000000003", name: "A" }).authorPersonId!;
    const b = authorForSender(db, { channel: "discord", id: "10000000000000000004", name: "B" }).authorPersonId!;
    expect(mergeChannelPerson(db, OWNER, a)).toMatchObject({ ok: false, status: 409 });
    db.run("INSERT INTO org_members (org_id, person_id) VALUES ('org', ?)", [b]);
    expect(mergeChannelPerson(db, b, a)).toMatchObject({ ok: false, status: 409 });
    expect(mergeChannelPerson(db, "missing", a)).toMatchObject({ ok: false, status: 404 });
    expect(mergeChannelPerson(db, a, a)).toMatchObject({ ok: false, status: 400 });
    expect(channelOnlyPeople(db)).toEqual(new Set([a]));
  });

  test("the route answers owner only, and the cached list sees the merge at once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "people-merge-"));
    const prev = process.env.TOPICS_USAGE_HISTORY_DIR;
    process.env.TOPICS_USAGE_HISTORY_DIR = dir;
    try {
      const db = withMergeTables(makeDb());
      const ctx = (role: "owner" | "guest") => ({
        db, json: (b: unknown, status = 200) => Response.json(b, { status }),
        errorResponse: (s: number, m: string) => Response.json({ error: m }, { status: s }),
        requestIdentity: () => ({ role, deviceId: null }),
      }) as never;
      const call = (router: ReturnType<typeof createUsageRouter>, method: string, path: string, body?: unknown) => {
        const req = new Request(`http://x${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
        const url = new URL(req.url);
        return router(req, url, url.pathname, method);
      };
      const router = createUsageRouter(ctx("owner"));
      const now = Date.now();
      for (const [id, chan, ext] of [["k1", "discord", "10000000000000000005"], ["k2", "whatsapp", "391234501"]] as const) {
        await call(router, "POST", "/api/usage/records", { id, ts: now - 1000, model: "m", purpose: "p", inputTokens: 10, sender: { channel: chan, id: ext, name: "Eve" } });
      }
      const before = (await (await call(router, "GET", "/api/usage/people?days=1"))!.json()) as PeopleUsage;
      expect(before.people.filter((p) => p.name === "Eve")).toHaveLength(2);
      expect(before.people.every((p) => p.canMerge)).toBe(true);
      const [from, into] = before.people.map((p) => p.personId!);

      expect((await call(createUsageRouter(ctx("guest")), "POST", "/api/usage/people/merge", { from, into }))!.status).toBe(403);
      const merged = await call(router, "POST", "/api/usage/people/merge", { from, into });
      expect(merged!.status).toBe(200);
      // same router, cache still warm: the answer must already be the merged one
      const after = (await (await call(router, "GET", "/api/usage/people?days=1"))!.json()) as PeopleUsage;
      expect(after.people).toHaveLength(1);
      expect(after.people[0]).toMatchObject({ personId: into, weighted: 20 });
      // a record's label is the request text, its purpose only the fallback
      const detail = (await (await call(router, "GET", `/api/usage/people/${into}?days=1`))!.json()) as { requests: Array<{ request: string }> };
      expect(detail.requests.map((r) => r.request)).toEqual(["p"]);
      await call(router, "POST", "/api/usage/records", { id: "k3", ts: now - 500, model: "m", purpose: "p", label: "Scadenze", inputTokens: 5, sender: { channel: "discord", id: "10000000000000000005", name: "Eve" } });
      const withLabel = (await (await call(router, "GET", `/api/usage/people/${into}?days=1`))!.json()) as { requests: Array<{ request: string }> };
      expect(withLabel.requests.map((r) => r.request).sort()).toEqual(["Scadenze", "p"]);
    } finally {
      if (prev === undefined) delete process.env.TOPICS_USAGE_HISTORY_DIR; else process.env.TOPICS_USAGE_HISTORY_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
