/**
 * THE FOLLOW GRAPH AND THE FIVE SWITCHES, on a schema built by hand.
 *
 * Two things are worth a test here and they are not the obvious one.
 *
 *  · THE EDGE IS ASYMMETRIC. `a` following `b` must say nothing about `b`
 *    following `a`, and a symmetric implementation passes every count test
 *    while being wrong: the counters would still add up, they would just add
 *    up on both rows.
 *  · THE OLD DATABASE. Every function has to survive a schema without
 *    `follows` and without the five `people.show_*` columns, because that is
 *    the state of any installation that has not run the migration yet. The
 *    test builds that schema on purpose, so "it degrades" is measured instead
 *    of asserted in a comment. The direction of the degradation is the part
 *    that matters: `showEmail` has to fall CLOSED.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  follow, unfollow, conteggiFollow, segue, idFollower, idSeguiti,
  privacyPersona, impostaPrivacy, PRIVACY_DEFAULTS,
} from "./follows";

/** The two tables these functions touch, and only the columns they read. */
function schemaCompleto(): Database {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE people (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      -- La lapide della 084: la tabella follows non puo' esistere senza, perche'
      -- quella migration viene molto prima. I contatori la leggono.
      revoked_at INTEGER,
      rev INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      show_profile   INTEGER NOT NULL DEFAULT 1,
      show_stats     INTEGER NOT NULL DEFAULT 1,
      show_email     INTEGER NOT NULL DEFAULT 0,
      show_followers INTEGER NOT NULL DEFAULT 1,
      show_presence  INTEGER NOT NULL DEFAULT 1
    )`);
  db.run(`
    CREATE TABLE follows (
      follower_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      followee_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (follower_id, followee_id)
    )`);
  for (const id of ["ada", "bea", "cy"]) {
    db.run("INSERT INTO people (id, display_name, updated_at) VALUES (?, ?, 0)", [id, id]);
  }
  return db;
}

/** An installation that has not run the migration: no table, no columns. */
function schemaVecchio(): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE people (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)");
  db.run("INSERT INTO people (id, display_name, updated_at) VALUES ('ada', 'ada', 0)");
  return db;
}

describe("il grafo dei follow", () => {
  let db: Database;
  beforeEach(() => { db = schemaCompleto(); });

  test("seguire e' asimmetrico: l'altro verso resta vuoto", () => {
    expect(follow(db, "ada", "bea", 10)).toBe(true);

    expect(segue(db, "ada", "bea")).toBe(true);
    expect(segue(db, "bea", "ada")).toBe(false);

    expect(conteggiFollow(db, "ada")).toEqual({ followers: 0, following: 1 });
    expect(conteggiFollow(db, "bea")).toEqual({ followers: 1, following: 0 });
  });

  test("seguire due volte e' seguire una volta, e non muove il timestamp", () => {
    follow(db, "ada", "bea", 10);
    follow(db, "ada", "bea", 999);

    const righe = db.query("SELECT created_at AS t FROM follows WHERE follower_id = 'ada'").all() as
      Array<{ t: number }>;
    expect(righe).toHaveLength(1);
    // INSERT OR IGNORE: the second write never happened at all, so the
    // moment the relation was born stays the true one.
    expect(righe[0]!.t).toBe(10);
    expect(conteggiFollow(db, "bea").followers).toBe(1);
  });

  test("seguire se stessi e' rifiutato, e non lascia una riga", () => {
    expect(follow(db, "ada", "ada")).toBe(false);
    expect(conteggiFollow(db, "ada")).toEqual({ followers: 0, following: 0 });
  });

  test("smettere di seguire toglie un verso solo", () => {
    follow(db, "ada", "bea", 10);
    follow(db, "bea", "ada", 11);

    unfollow(db, "ada", "bea");

    expect(segue(db, "ada", "bea")).toBe(false);
    expect(segue(db, "bea", "ada")).toBe(true);
  });

  test("le due liste guardano i due capi opposti dell'arco", () => {
    follow(db, "bea", "ada", 10);
    follow(db, "cy", "ada", 20);
    follow(db, "ada", "cy", 30);

    // Most recent first.
    expect(idFollower(db, "ada")).toEqual(["cy", "bea"]);
    expect(idSeguiti(db, "ada")).toEqual(["cy"]);
    expect(idFollower(db, "cy")).toEqual(["ada"]);
  });

  test("una persona REVOCATA sparisce dal contatore, non solo dall'elenco", () => {
    follow(db, "bea", "ada", 10);
    follow(db, "cy", "ada", 11);
    follow(db, "ada", "bea", 12);
    // Migration 084 revokes with a tombstone, not with a DELETE: the `follows`
    // row stays (and must stay, or lifting the revocation would not give the
    // graph back). But a reader has to see the same number the list next to it
    // draws.
    db.run("UPDATE people SET revoked_at = 1 WHERE id = 'bea'");

    expect(conteggiFollow(db, "ada")).toEqual({ followers: 1, following: 0 });
    expect(idFollower(db, "ada")).toEqual(["cy"]);
    expect(idSeguiti(db, "ada")).toEqual([]);
    // The edge is still there: the revocation can be lifted.
    expect(db.query("SELECT COUNT(*) AS n FROM follows").get()).toEqual({ n: 3 });
  });

  test("cancellare una persona porta via i suoi archi, non lascia contatori appesi", () => {
    db.run("PRAGMA foreign_keys = ON");
    follow(db, "ada", "bea", 10);
    follow(db, "cy", "bea", 11);

    db.run("DELETE FROM people WHERE id = 'ada'");

    expect(conteggiFollow(db, "bea").followers).toBe(1);
    expect(idFollower(db, "bea")).toEqual(["cy"]);
  });
});

describe("le cinque manopole della privacy", () => {
  let db: Database;
  beforeEach(() => { db = schemaCompleto(); });

  test("i default: tutto aperto tranne l'email", () => {
    expect(privacyPersona(db, "ada")).toEqual({
      showProfile: true, showStats: true, showEmail: false,
      showFollowers: true, showPresence: true,
    });
  });

  test("una persona che non esiste prende i default invece di far cadere la chiamata", () => {
    expect(privacyPersona(db, "chi-non-esiste")).toEqual(PRIVACY_DEFAULTS);
  });

  test("la patch e' parziale: tocca cio' che nomina e lascia stare il resto", () => {
    const dopo = impostaPrivacy(db, "ada", { showStats: false, showEmail: true }, 500);

    expect(dopo.showStats).toBe(false);
    expect(dopo.showEmail).toBe(true);
    expect(dopo.showProfile).toBe(true);
    expect(dopo.showFollowers).toBe(true);
    expect(privacyPersona(db, "ada").showStats).toBe(false);
  });

  test("una scrittura muove `rev`: una socket aperta deve poter accorgersene", () => {
    impostaPrivacy(db, "ada", { showProfile: false }, 500);
    const r = db.query("SELECT rev, updated_at AS u FROM people WHERE id = 'ada'").get() as
      { rev: number; u: number };
    expect(r.rev).toBe(1);
    expect(r.u).toBe(500);
  });

  test("un valore che non e' un booleano viene ignorato, non convertito", () => {
    // «"false"» is truthy: coercing it would open a switch somebody had
    // closed, and that is exactly the direction in which a bug here does harm.
    const patch = { showStats: "false", showEmail: 1, showProfile: null } as unknown as
      Parameters<typeof impostaPrivacy>[2];
    const dopo = impostaPrivacy(db, "ada", patch, 500);

    expect(dopo.showStats).toBe(true);
    expect(dopo.showEmail).toBe(false);
    expect(dopo.showProfile).toBe(true);
    // Nothing to write: not even the revision moved.
    expect((db.query("SELECT rev FROM people WHERE id = 'ada'").get() as { rev: number }).rev).toBe(0);
  });

  test("una patch vuota non scrive e restituisce lo stato che c'e'", () => {
    impostaPrivacy(db, "ada", { showFollowers: false }, 500);
    const dopo = impostaPrivacy(db, "ada", {}, 900);
    expect(dopo.showFollowers).toBe(false);
    expect((db.query("SELECT rev FROM people WHERE id = 'ada'").get() as { rev: number }).rev).toBe(1);
  });
});

describe("uno schema anteriore alla migration", () => {
  let db: Database;
  beforeEach(() => { db = schemaVecchio(); });

  test("nessuna funzione dei follow solleva: la schermata dei profili non cade", () => {
    expect(() => follow(db, "ada", "bea", 10)).not.toThrow();
    expect(follow(db, "ada", "bea", 10)).toBe(false);
    expect(unfollow(db, "ada", "bea")).toBe(false);
    expect(segue(db, "ada", "bea")).toBe(false);
    expect(conteggiFollow(db, "ada")).toEqual({ followers: 0, following: 0 });
    expect(idFollower(db, "ada")).toEqual([]);
    expect(idSeguiti(db, "ada")).toEqual([]);
  });

  test("la privacy cade sui default, e l'email cade CHIUSA", () => {
    const p = privacyPersona(db, "ada");
    expect(p).toEqual(PRIVACY_DEFAULTS);
    // The direction matters: on a database we cannot query, the one field
    // whose publication cannot be undone stays closed.
    expect(p.showEmail).toBe(false);
  });

  test("scrivere la privacy non solleva, e non promette di aver scritto", () => {
    expect(() => impostaPrivacy(db, "ada", { showEmail: true }, 500)).not.toThrow();
    expect(impostaPrivacy(db, "ada", { showEmail: true }, 500).showEmail).toBe(false);
  });
});
