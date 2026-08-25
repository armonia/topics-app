/**
 * Il fatto unico e la query sola.
 *
 * Cosa va provato qui non e' il CRUD: e' che «cosa e' aperto» abbia UNA
 * risposta, che le divergenze fra il fatto e i registri vengano dette invece
 * che sospettate, e che il riconcilio le chiuda nella direzione giusta — un
 * riconcilio che riapre una chat archiviata sarebbe peggio del guasto.
 *
 * @covers RETIRE-01
 * @covers RETIRE-03
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";
import {
  clearRetirement,
  isRetired,
  listOpen,
  recordRetirement,
  reconcile,
  retiredIds,
} from "./retirement";

let db: Database;

const mig = (name: string) => readFileSync(join(import.meta.dir, "..", "db", "migrations", name), "utf-8");

function addTopic(id: string, opts: { archived?: boolean; name?: string; updatedAt?: string } = {}) {
  db.run(
    "INSERT INTO topics (id, name, slug, session_key, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, opts.name ?? id, id, `sk-${id}`, opts.archived ? 1 : 0, "2026-01-01", opts.updatedAt ?? "2026-01-01"],
  );
}

function addTerminal(id: string, opts: { status?: string; topicId?: string } = {}) {
  db.run(
    "INSERT INTO terminal_sessions (id, name, cwd, type, status, topic_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, id, "/w", "shell", opts.status ?? "active", opts.topicId ?? null, "2026-01-01"],
  );
}

beforeEach(() => {
  db = new Database(":memory:");
  // Lo schema minimo che la query interroga. Non l'intero 001: qui interessa
  // che le colonne su cui si decide esistano con i loro default.
  db.run(`CREATE TABLE topics (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL, session_key TEXT NOT NULL UNIQUE,
    project_path TEXT, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.run(`CREATE TABLE terminal_sessions (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'shell',
    topic_id TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL)`);
});

/** La migration vera, backfill compreso. */
function applyMigration() {
  db.run(mig("089-retirements.sql"));
}

describe("089 — il backfill", () => {
  test("ogni topic archiviato nasce gia' ritirato, con la sua data", () => {
    addTopic("vecchio", { archived: true, updatedAt: "2026-07-15T10:00:00Z" });
    addTopic("vivo");
    applyMigration();

    expect(isRetired(db, "topic", "vecchio")).toBe(true);
    expect(isRetired(db, "topic", "vivo")).toBe(false);
    const row = db.query("SELECT retired_at FROM retirements WHERE ref_id = 'vecchio'").get() as { retired_at: string };
    expect(row.retired_at).toBe("2026-07-15T10:00:00Z");
  });

  test("senza backfill la prima query direbbe «tutto aperto» — con, non lo dice", () => {
    for (let i = 0; i < 5; i++) addTopic(`a${i}`, { archived: true });
    applyMigration();
    expect(listOpen(db).topics).toHaveLength(0);
    expect(listOpen(db).divergences).toHaveLength(0);
  });
});

describe("il fatto: prima scrittura vince", () => {
  beforeEach(applyMigration);

  test("ri-ritirare non sposta la data e dichiara «non e' nuovo»", () => {
    expect(recordRetirement(db, "topic", "t", "2026-08-01T00:00:00Z", "tab-close")).toBe(true);
    expect(recordRetirement(db, "topic", "t", "2026-08-09T00:00:00Z", "reconcile")).toBe(false);
    const row = db.query("SELECT retired_at, reason FROM retirements WHERE ref_id = 't'").get() as any;
    expect(row.retired_at).toBe("2026-08-01T00:00:00Z");
    expect(row.reason).toBe("tab-close");
  });

  test("il rientro e' esplicito e reversibile", () => {
    recordRetirement(db, "pane", "p1");
    expect(clearRetirement(db, "pane", "p1")).toBe(true);
    expect(clearRetirement(db, "pane", "p1")).toBe(false);
    expect(isRetired(db, "pane", "p1")).toBe(false);
  });

  test("le specie non si mescolano", () => {
    recordRetirement(db, "topic", "x");
    recordRetirement(db, "terminal", "x");
    expect(retiredIds(db, "topic")).toEqual(new Set(["x"]));
    expect(retiredIds(db, "pane")).toEqual(new Set());
  });
});

describe("listOpen — una domanda, una risposta", () => {
  beforeEach(applyMigration);

  test("aperto = il registro ce l'ha E il fatto non lo ha ritirato", () => {
    addTopic("aperto");
    addTopic("chiuso", { archived: true });
    recordRetirement(db, "topic", "chiuso");
    addTerminal("term-vivo");
    // Ritirata E senza riga: e' lo stato PULITO di una sessione chiusa — il
    // ritiro ha fatto anche la sua conseguenza. Se la riga ci fosse ancora,
    // sarebbe una divergenza (ed e' il test qui sotto).
    recordRetirement(db, "terminal", "term-morto");

    const inv = listOpen(db);
    expect(inv.topics.map((t) => t.id)).toEqual(["aperto"]);
    expect(inv.terminals.map((t) => t.id)).toEqual(["term-vivo"]);
    expect(inv.divergences).toHaveLength(0);
  });

  test("la sessione viva per una tab chiusa a luglio esce come divergenza, non come sessione aperta", () => {
    addTerminal("orfana");
    recordRetirement(db, "terminal", "orfana", "2026-07-20T00:00:00Z", "tab-close");

    const inv = listOpen(db);
    expect(inv.terminals).toHaveLength(0);
    expect(inv.divergences).toEqual([
      { kind: "terminal", refId: "orfana", reason: "registry-open-fact-retired", label: "orfana" },
    ]);
  });

  test("il topic «aperto» che era chiuso da settimane esce come divergenza", () => {
    addTopic("panea", { name: "Panea" });
    recordRetirement(db, "topic", "panea", "2026-07-14T00:00:00Z", "task-release");

    const inv = listOpen(db);
    expect(inv.topics).toHaveLength(0);
    expect(inv.divergences[0]).toMatchObject({ kind: "topic", refId: "panea", reason: "registry-open-fact-retired" });
  });

  test("archiviato da una strada che non timbrava: divergenza nell'altro verso", () => {
    addTopic("muto", { archived: true });
    const inv = listOpen(db);
    expect(inv.topics).toHaveLength(0);
    expect(inv.divergences[0]).toMatchObject({ refId: "muto", reason: "registry-closed-fact-open" });
  });
});

describe("reconcile — la direzione non e' simmetrica", () => {
  beforeEach(applyMigration);

  test("fatto ritirato + registro aperto → si chiude il registro", () => {
    addTopic("t");
    addTerminal("s");
    recordRetirement(db, "topic", "t");
    recordRetirement(db, "terminal", "s");
    const archived: string[] = [];
    const retired: string[] = [];

    const res = reconcile(db, { archiveTopic: (id) => archived.push(id), retireTerminal: (id) => retired.push(id) });

    expect(archived).toEqual(["t"]);
    expect(retired).toEqual(["s"]);
    expect(res).toMatchObject({ topicsArchived: 1, terminalsRetired: 1, examined: 2 });
  });

  test("registro chiuso + fatto muto → si timbra il fatto, NON si riapre la chat", () => {
    addTopic("archiviato", { archived: true });
    const archived: string[] = [];

    reconcile(db, { archiveTopic: (id) => archived.push(id), retireTerminal: () => {} });

    expect(archived).toEqual([]);
    expect(isRetired(db, "topic", "archiviato")).toBe(true);
    expect(db.query("SELECT archived FROM topics WHERE id = 'archiviato'").get()).toEqual({ archived: 1 });
  });

  test("convergente: il secondo giro non fa niente", () => {
    addTopic("t");
    addTerminal("s");
    recordRetirement(db, "topic", "t");
    recordRetirement(db, "terminal", "s");
    const deps = {
      archiveTopic: (id: string) => db.run("UPDATE topics SET archived = 1 WHERE id = ?", [id]),
      retireTerminal: (id: string) => db.run("DELETE FROM terminal_sessions WHERE id = ?", [id]),
    };

    reconcile(db, deps);
    const second = reconcile(db, deps);

    expect(second).toMatchObject({ topicsArchived: 0, terminalsRetired: 0, topicsStamped: 0, examined: 0 });
    expect(listOpen(db).divergences).toHaveLength(0);
  });

  test("un topic che esplode non impedisce di ritirare le sessioni, che sono quelle che consumano", () => {
    addTopic("boom");
    addTerminal("s");
    recordRetirement(db, "topic", "boom");
    recordRetirement(db, "terminal", "s");
    const retired: string[] = [];

    const res = reconcile(db, {
      archiveTopic: () => { throw new Error("db busy"); },
      retireTerminal: (id) => retired.push(id),
    });

    expect(retired).toEqual(["s"]);
    expect(res.terminalsRetired).toBe(1);
  });
});
