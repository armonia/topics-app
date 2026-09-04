/**
 * Le statistiche del profilo, contro le migration VERE.
 *
 * Il DB del test è una copia in memoria dello schema di produzione, non una
 * tabellina scritta per l'occasione: metà del valore di queste query è che
 * leggono colonne che esistono (`tasks.agent_cache_read_tokens`,
 * `messages.cache_read_tokens`), ed è precisamente la cosa che un finto DB non
 * può provare. Il precedente è nel commento in cima al file: il cruscotto
 * leggeva tre tabelle vere che nessuno scriveva, e i test passavano tutti.
 *
 * @covers PROFILE-01, PROFILE-02
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Database } from "bun:sqlite";
import { initDatabase, closeDatabase, getDatabase } from "../db";
import {
  computeProfileStats, computePresenceCounts, streak,
  profileStatsCached, resetProfileStatsCache, PROFILE_STATS_TTL_MS,
} from "./profile-stats";
import { projectIdForPath } from "../../shared/board";

let tmpRoot: string;
let db: Database;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "profile-stats-test-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(import.meta.dir, "..", "db", "migrations");
  for (const f of readdirSync(realMigDir)) {
    if (!f.endsWith(".sql")) continue;
    writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
  process.env.DATA_DIR = join(tmpRoot, "data");
  initDatabase(tmpRoot);
  db = getDatabase();
});

afterAll(() => {
  closeDatabase();
  delete process.env.DATA_DIR;
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  for (const t of ["messages", "tasks", "topics", "projects"]) db.run(`DELETE FROM ${t}`);
});

const ORA = Date.UTC(2026, 7, 11, 12, 0, 0); // 2026-08-11T12:00:00Z
const iso = (msFa: number) => new Date(ORA - msFa).toISOString();
const GIORNO = 86_400_000;

function topic(id: string, archived = 0) {
  db.run(
    "INSERT INTO topics (id, name, slug, session_key, created_at, updated_at, archived) VALUES (?,?,?,?,?,?,?)",
    [id, id, id, `sk-${id}`, iso(0), iso(0), archived],
  );
}

function progetto(id: string, name: string, path = `/tmp/${id}`) {
  db.run(
    "INSERT INTO projects (id, name, slug, path, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    [id, name, id, path, iso(0), iso(0)],
  );
}

function messaggio(over: {
  id: string;
  role?: string;
  ageMs?: number;
  prompt?: number;
  completion?: number;
  cacheRead?: number | null;
  costCents?: number | null;
}) {
  db.run(
    `INSERT INTO messages (id, session_key, role, content, timestamp,
                           usage_prompt_tokens, usage_completion_tokens, cache_read_tokens, cost_cents)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      over.id, "sk-a", over.role ?? "assistant", "", iso(over.ageMs ?? 0),
      over.prompt ?? 0, over.completion ?? 0,
      over.cacheRead === undefined ? 0 : over.cacheRead,
      over.costCents ?? null,
    ],
  );
}

function task(over: {
  id: string;
  project?: string;
  status?: string;
  dispatch?: string | null;
  tokens?: number;
  cache?: number;
  ms?: number;
  completedAgeMs?: number | null;
  inProgressAgeMs?: number | null;
}) {
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at,
                        dispatch_state, agent_tokens, agent_cache_read_tokens, agent_ms,
                        completed_at, in_progress_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      over.id, over.project ?? "p1", over.id, over.status ?? "done", iso(0), iso(0),
      over.dispatch ?? null, over.tokens ?? 0, over.cache ?? 0, over.ms ?? 0,
      over.completedAgeMs == null ? null : iso(over.completedAgeMs),
      over.inProgressAgeMs == null ? null : iso(over.inProgressAgeMs),
    ],
  );
}

describe("computeProfileStats", () => {
  test("su un DB vuoto sono zeri, e non un'eccezione", () => {
    const s = computeProfileStats(db, ORA);
    expect(s.sessions).toEqual({ total: 0, open: 0 });
    expect(s.tokens.total).toBe(0);
    expect(s.activity.firstSeen).toBeNull();
    expect(s.activity.last30).toHaveLength(30);
  });

  test("le sessioni sono i topic, e «aperte» vuol dire non archiviate", () => {
    topic("a"); topic("b"); topic("c", 1);
    const s = computeProfileStats(db, ORA);
    expect(s.sessions).toEqual({ total: 3, open: 2 });
  });

  test("i token sommano chat E board, e la cache si conta UNA volta sola", () => {
    // La riga di chat è coerente col contratto: `usage_prompt_tokens` è il
    // TOTALE letto e comprende già la rilettura (1.000 dei 1.100). Prima questo
    // test la scriveva come `prompt: 100, cacheRead: 1000` — una forma che il
    // server non produce, perché il prompt non può essere più piccolo della
    // cache che contiene — e in cambio del numero giusto benediceva la somma
    // sbagliata. Sul DB di produzione valeva 18,03 miliardi contro 9,89 veri.
    messaggio({ id: "m1", prompt: 1100, completion: 50, cacheRead: 1000 });
    // Per i TASK invece la somma ci vuole: `agent_tokens` nasce da
    // `billableTokens`, che la rilettura la esclude per costruzione
    // (`services/dispatch-usage.ts`). Due tabelle, due convenzioni.
    task({ id: "t1", tokens: 300, cache: 2000, completedAgeMs: GIORNO });
    const s = computeProfileStats(db, ORA);
    expect(s.tokens.chat).toBe(1150);   // 1.100 letti + 50 prodotti
    expect(s.tokens.agents).toBe(2300); // 300 fatturabili + 2.000 riletti
    expect(s.tokens.total).toBe(3450);
  });

  test("un turno quasi tutto rilettura non vale il doppio di se stesso", () => {
    // La forma vera di un turno agentico: il 99,9% del letto è rilettura.
    // Se la cache si sommasse di nuovo, questo numero raddoppierebbe — ed è
    // esattamente quello che il pannello mostrava.
    messaggio({ id: "agentico", prompt: 1_000_000, completion: 0, cacheRead: 999_000 });
    const s = computeProfileStats(db, ORA);
    expect(s.tokens.chat).toBe(1_000_000);
    expect(s.tokens.chat).not.toBe(1_999_000);
  });

  test("il costo somma solo le righe attendibili, e CONTA quelle che ha escluso", () => {
    messaggio({ id: "ok", cacheRead: 500, costCents: 250 });      // $2,50 misurati
    messaggio({ id: "vecchia", cacheRead: null, costCents: 9000 }); // gonfiata, esclusa
    const s = computeProfileStats(db, ORA);
    expect(s.cost.measuredUsd).toBe(2.5);
    expect(s.cost.uncertainRows).toBe(1);
  });

  test("le ore d'agente vengono da `agent_ms`, arrotondate al decimo", () => {
    task({ id: "t1", ms: 5_400_000 }); // 1,5 h
    task({ id: "t2", ms: 1_800_000 }); // 0,5 h
    expect(computeProfileStats(db, ORA).agentHours).toBe(2);
  });

  test("i task si contano per stato; i progetti archiviati non contano", () => {
    progetto("p1", "Uno");
    progetto("p2", "Due");
    db.run("UPDATE projects SET archived = 1 WHERE id = 'p2'");
    task({ id: "t1", status: "done" });
    task({ id: "t2", status: "in_progress" });
    task({ id: "t3", status: "todo" });
    const s = computeProfileStats(db, ORA);
    expect(s.tasks).toEqual({ total: 3, done: 1, inProgress: 1 });
    expect(s.projects).toBe(1);
  });

  test("la serie ha 30 giorni CONSECUTIVI, zeri compresi", () => {
    messaggio({ id: "m1", ageMs: 2 * GIORNO, prompt: 10 });
    messaggio({ id: "m2", ageMs: 0, prompt: 5 });
    const s = computeProfileStats(db, ORA);
    expect(s.activity.last30).toHaveLength(30);
    expect(s.activity.last30.at(-1)).toEqual({ date: "2026-08-11", tokens: 5 });
    expect(s.activity.last30.at(-3)).toEqual({ date: "2026-08-09", tokens: 10 });
    expect(s.activity.last30.at(-2)!.tokens).toBe(0); // il giorno vuoto c'è
  });

  test("un giorno in cui ha lavorato solo la board è un giorno attivo", () => {
    task({ id: "t1", tokens: 42, completedAgeMs: GIORNO });
    const s = computeProfileStats(db, ORA);
    expect(s.activity.activeDays).toBe(1);
    expect(s.activity.last30.at(-2)!.tokens).toBe(42);
  });
});

describe("streak", () => {
  test("conta i giorni consecutivi fino a oggi", () => {
    const g = new Set(["2026-08-11", "2026-08-10", "2026-08-09", "2026-08-07"]);
    expect(streak(g, ORA)).toBe(3);
  });

  test("la mattina in cui non hai ancora aperto l'app la serie di ieri è ancora viva", () => {
    const g = new Set(["2026-08-10", "2026-08-09"]);
    expect(streak(g, ORA)).toBe(2);
  });

  test("saltato un giorno intero, la serie è finita", () => {
    const g = new Set(["2026-08-09", "2026-08-08"]);
    expect(streak(g, ORA)).toBe(0);
  });

  test("nessun giorno attivo ⇒ zero, non uno", () => {
    expect(streak(new Set(), ORA)).toBe(0);
  });
});

describe("computePresenceCounts", () => {
  test("le sessioni al lavoro sono i turni VIVI, non una stima", () => {
    topic("a"); topic("b"); topic("c", 1);
    const c = computePresenceCounts(db, 2);
    expect(c.openSessions).toBe(2);
    expect(c.workingSessions).toBe(2);
  });

  test("i task al lavoro sono quelli che la board sta eseguendo, non tutti gli aperti", () => {
    progetto("p1", "Armonia-CRM", "/tmp/crm");
    task({ id: "t1", project: projectIdForPath("/tmp/crm"), status: "in_progress", dispatch: "working", inProgressAgeMs: 60_000 });
    task({ id: "t2", status: "in_progress", dispatch: "queued" });
    task({ id: "t3", status: "todo", dispatch: null });
    const c = computePresenceCounts(db, 0);
    expect(c.activeTasks).toBe(1);
    expect(c.focusProject).toBe("Armonia-CRM");
  });

  test("board ferma: il progetto in primo piano è quello del topic più recente", () => {
    progetto("p1", "Pix", "/tmp/pix");
    db.run(
      "INSERT INTO topics (id, name, slug, session_key, created_at, updated_at, archived, project_path) VALUES (?,?,?,?,?,?,0,?)",
      ["a", "a", "a", "sk-a", iso(GIORNO), iso(GIORNO), "/tmp/pix"],
    );
    const c = computePresenceCounts(db, 0);
    expect(c.activeTasks).toBe(0);
    expect(c.focusProject).toBe("Pix");
  });

  test("il progetto del task al lavoro vince sul topic piu' recente, e lo nomina giusto", () => {
    // `tasks.project_id` is the board SLUG (`<folder>-<hash>`), `projects.id` is
    // a UUID: the old join on `p.id` matched nothing, so this branch was always
    // empty and the presence answered with the OTHER project - the one of the
    // most recently touched topic - in the status bar and in Rich Presence.
    progetto("11111111-1111-4111-8111-111111111111", "foo", "/x/foo");
    progetto("22222222-2222-4222-8222-222222222222", "bar", "/x/bar");
    db.run(
      "INSERT INTO topics (id, name, slug, session_key, created_at, updated_at, archived, project_path) VALUES (?,?,?,?,?,?,0,?)",
      ["b", "b", "b", "sk-b", iso(0), iso(0), "/x/bar"],
    );
    task({ id: "t1", project: projectIdForPath("/x/foo"), status: "in_progress", dispatch: "working", inProgressAgeMs: 60_000 });
    expect(computePresenceCounts(db, 0).focusProject).toBe("foo");
  });

  test("niente progetti ⇒ null, che il livello `detailed` sa degradare", () => {
    topic("a");
    expect(computePresenceCounts(db, 1).focusProject).toBeNull();
  });
});

/**
 * THE SCANS ARE PAID FOR ONCE EVERY FIFTEEN SECONDS.
 *
 * `computeProfileStats` is not "nine queries on indexed tables", as the comment
 * that refused a cache claimed: the `COUNT(*) WHERE role='assistant'`, the two
 * SUMs over the token columns and the `GROUP BY date(timestamp)` all come out
 * as `SCAN messages`, on a 350 MB table. Three routes called it uncached, and
 * one of them - `/api/public-profile` - is reachable by anyone holding the
 * token, with no throttle: a reload loop on that URL held the server's single
 * event loop for as long as it liked.
 *
 * The measure is NOT a stopwatch (a loaded machine is not a proof): the
 * database is changed underneath and the answer is asked again. If it does not
 * change, the queries did not run.
 */
describe("profileStatsCached", () => {
  test("inside the window the queries stop running", () => {
    resetProfileStatsCache();
    messaggio({ id: "m1" });
    const first = profileStatsCached(db, ORA);
    expect(first.messages.total).toBe(1);

    messaggio({ id: "m2" });
    expect(profileStatsCached(db, ORA + 1_000).messages.total,
      "one more row inside the window: the answer is the same").toBe(1);
    // And the bare function, the one every other test in this file uses, sees
    // the real database straight away.
    expect(computeProfileStats(db, ORA).messages.total).toBe(2);
  });

  test("past the window it recomputes", () => {
    resetProfileStatsCache();
    messaggio({ id: "m1" });
    expect(profileStatsCached(db, ORA).messages.total).toBe(1);
    messaggio({ id: "m2" });
    expect(profileStatsCached(db, ORA + PROFILE_STATS_TTL_MS).messages.total).toBe(2);
  });

  test("another database does not inherit the first one's numbers", () => {
    resetProfileStatsCache();
    messaggio({ id: "m1" });
    expect(profileStatsCached(db, ORA).messages.total).toBe(1);
    const otherDb = new (db.constructor as new (path: string) => Database)(":memory:");
    otherDb.run("CREATE TABLE topics (id TEXT)");
    // On a DB without the expected tables the function degrades to zeros: what
    // matters is that it does NOT answer with the other one's cache.
    expect(profileStatsCached(otherDb, ORA).messages.total).toBe(0);
    otherDb.close();
    resetProfileStatsCache();
  });
});
