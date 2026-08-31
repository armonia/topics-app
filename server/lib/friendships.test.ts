/**
 * @covers FRIEND-01
 *
 * THE FRIENDSHIP GRAPH, on a schema built by hand.
 *
 * Four things are worth a test here, and the obvious one ("a request becomes a
 * friendship") is not among them.
 *
 *  · THE RELATION IS MUTUAL BUT THE STATE IS NOT. One row, two people, two
 *    different situations. An implementation that reported the same state to
 *    both sides would pass any test that only ever looks from one side, and it
 *    would put an Accept button in front of the person who sent the request.
 *  · A REFUSAL HAS TO MEAN SOMETHING. The row survives it, the refused person
 *    cannot ask again, and the person who refused still can. Delete the row on
 *    refusal and every test about counts still passes.
 *  · TWO PEOPLE ASKING EACH OTHER ARE AGREEING. The second request has to land
 *    as an acceptance, not as a second row nobody will ever answer.
 *  · THE OLD DATABASE. Every function has to survive a schema without
 *    `friendships`, because that is any installation that has not run the
 *    migration. The test builds that schema on purpose, so "it degrades" is
 *    measured instead of asserted in a comment.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  request, accept, decline, cancel, state, friends, incoming, outgoing,
} from "./friendships";

/** The two tables these functions touch, and only the columns they read. */
function fullSchema(): Database {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE people (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      -- The tombstone of the 084: a revoked person keeps their rows and
      -- disappears from every list. The reads here have to honour it.
      revoked_at INTEGER
    )`);
  db.run(`
    CREATE TABLE friendships (
      requester_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      addressee_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      state        TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      decided_at   INTEGER,
      PRIMARY KEY (requester_id, addressee_id)
    )`);
  db.run("CREATE INDEX idx_friendships_addressee ON friendships(addressee_id)");
  for (const id of ["ada", "bea", "cy"]) {
    db.run("INSERT INTO people (id, display_name) VALUES (?, ?)", [id, id]);
  }
  return db;
}

/** An installation that has not run the migration: no table at all. */
function oldSchema(): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE people (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, revoked_at INTEGER)");
  db.run("INSERT INTO people (id, display_name) VALUES ('ada', 'ada')");
  return db;
}

const rowCount = (db: Database): number =>
  (db.query("SELECT COUNT(*) AS n FROM friendships").get() as { n: number }).n;

describe("asking and being asked", () => {
  let db: Database;
  beforeEach(() => { db = fullSchema(); });

  test("a request is one row, and the two people read it differently", () => {
    expect(request(db, "ada", "bea", 10)).toEqual({ state: "pending_out", refused: null });

    expect(state(db, "ada", "bea")).toBe("pending_out");
    expect(state(db, "bea", "ada")).toBe("pending_in");
    expect(rowCount(db)).toBe(1);

    expect(outgoing(db, "ada")).toEqual([{ id: "bea", since: 10 }]);
    expect(incoming(db, "bea")).toEqual([{ id: "ada", since: 10 }]);
    // Nothing is a friendship yet: a request must not widen anybody's reach.
    expect(friends(db, "ada")).toEqual([]);
    expect(friends(db, "bea")).toEqual([]);
  });

  test("befriending yourself is refused with a reason, and leaves no row", () => {
    const r = request(db, "ada", "ada", 10);
    expect(r.state).toBe("none");
    expect(r.refused?.status).toBe(400);
    expect(rowCount(db)).toBe(0);
  });

  test("asking twice is asking once, and the original moment survives", () => {
    request(db, "ada", "bea", 10);
    expect(request(db, "ada", "bea", 999)).toEqual({ state: "pending_out", refused: null });

    expect(rowCount(db)).toBe(1);
    expect(outgoing(db, "ada")).toEqual([{ id: "bea", since: 10 }]);
  });

  test("BOTH asking is agreeing: the second request accepts the first", () => {
    request(db, "ada", "bea", 10);
    expect(request(db, "bea", "ada", 20)).toEqual({ state: "friends", refused: null });

    // One row, not two: the two gestures were the same intention.
    expect(rowCount(db)).toBe(1);
    expect(state(db, "ada", "bea")).toBe("friends");
    expect(state(db, "bea", "ada")).toBe("friends");
    expect(friends(db, "ada")).toEqual(["bea"]);
    expect(friends(db, "bea")).toEqual(["ada"]);
    // Neither side is left waiting for an answer that already arrived.
    expect(incoming(db, "ada")).toEqual([]);
    expect(outgoing(db, "bea")).toEqual([]);
  });

  test("a stranger is `none`, and so am I to myself", () => {
    expect(state(db, "ada", "cy")).toBe("none");
    expect(state(db, "ada", "ada")).toBe("none");
  });
});

describe("answering", () => {
  let db: Database;
  beforeEach(() => { db = fullSchema(); request(db, "ada", "bea", 10); });

  test("only the addressee can accept: the sender gets a 409", () => {
    const r = accept(db, "ada", "bea", 20);
    expect(r.refused?.status).toBe(409);
    expect(r.state).toBe("pending_out");
    expect(state(db, "bea", "ada")).toBe("pending_in");
  });

  test("accepting writes the moment it was answered, and keeps the moment it was asked", () => {
    expect(accept(db, "bea", "ada", 20)).toEqual({ state: "friends", refused: null });

    const row = db.query("SELECT state AS st, created_at AS c, decided_at AS d FROM friendships").get() as
      { st: string; c: number; d: number };
    expect(row).toEqual({ st: "accepted", c: 10, d: 20 });
  });

  test("accepting a friendship that already holds is not an error", () => {
    accept(db, "bea", "ada", 20);
    expect(accept(db, "bea", "ada", 99)).toEqual({ state: "friends", refused: null });
    // The moment it was answered does not move: it happened once.
    expect((db.query("SELECT decided_at AS d FROM friendships").get() as { d: number }).d).toBe(20);
  });

  test("accepting a request nobody sent is a 409, not a silent success", () => {
    const r = accept(db, "ada", "cy", 20);
    expect(r.refused?.status).toBe(409);
    expect(r.state).toBe("none");
    expect(friends(db, "ada")).toEqual([]);
  });

  test("refusing KEEPS the row: that is what stops the request coming back", () => {
    expect(decline(db, "bea", "ada", 20)).toEqual({ state: "none", refused: null });

    expect(rowCount(db)).toBe(1);
    const row = db.query("SELECT state AS st, decided_at AS d FROM friendships").get() as
      { st: string; d: number };
    expect(row).toEqual({ st: "declined", d: 20 });
  });

  test("the refusal is not announced: it reads as a request still out", () => {
    decline(db, "bea", "ada", 20);

    // The sender is told something the client draws exactly like `pending_out`.
    expect(state(db, "ada", "bea")).toBe("declined_out");
    // And it is NOT in the outgoing list, or the sender would learn from the
    // list disappearing what the state was careful not to say.
    expect(outgoing(db, "ada")).toEqual([]);
    // The refuser has no relation at all: that is the state in which asking is
    // allowed, and they are the one person who may.
    expect(state(db, "bea", "ada")).toBe("none");
    expect(incoming(db, "bea")).toEqual([]);
  });

  test("REFUSED MEANS REFUSED: the same person cannot ask again", () => {
    decline(db, "bea", "ada", 20);

    const r = request(db, "ada", "bea", 30);
    expect(r.refused?.status).toBe(409);
    expect(r.state).toBe("declined_out");
    // Nothing new was written and nothing was reopened.
    expect(rowCount(db)).toBe(1);
    expect(incoming(db, "bea")).toEqual([]);
  });

  test("the person who refused can still ask in their turn", () => {
    decline(db, "bea", "ada", 20);

    expect(request(db, "bea", "ada", 30)).toEqual({ state: "pending_out", refused: null });
    // An open question beats a closed past: the sender of the old refused
    // request must see something they can accept, not their own refusal.
    expect(state(db, "ada", "bea")).toBe("pending_in");
    expect(incoming(db, "ada")).toEqual([{ id: "bea", since: 30 }]);
  });

  test("agreeing after a refusal leaves ONE row, so a later unfriend is not haunted by it", () => {
    decline(db, "bea", "ada", 20);
    request(db, "bea", "ada", 30);
    accept(db, "ada", "bea", 40);

    expect(rowCount(db)).toBe(1);
    expect(state(db, "ada", "bea")).toBe("friends");

    cancel(db, "ada", "bea");
    // Both are free again: the old refusal did not survive the friendship.
    expect(rowCount(db)).toBe(0);
    expect(request(db, "ada", "bea", 50).state).toBe("pending_out");
  });

  test("refusing twice is refusing once, and refusing nothing is a 409", () => {
    decline(db, "bea", "ada", 20);
    expect(decline(db, "bea", "ada", 99)).toEqual({ state: "none", refused: null });
    expect((db.query("SELECT decided_at AS d FROM friendships").get() as { d: number }).d).toBe(20);

    expect(decline(db, "cy", "ada", 20).refused?.status).toBe(409);
  });
});

describe("undoing", () => {
  let db: Database;
  beforeEach(() => { db = fullSchema(); });

  test("withdrawing my own request removes it, and both are free again", () => {
    request(db, "ada", "bea", 10);
    expect(cancel(db, "ada", "bea")).toEqual({ state: "none", refused: null });

    expect(rowCount(db)).toBe(0);
    expect(incoming(db, "bea")).toEqual([]);
    expect(request(db, "bea", "ada", 20).state).toBe("pending_out");
  });

  test("unfriending works from EITHER side, and leaves nothing behind", () => {
    request(db, "ada", "bea", 10);
    accept(db, "bea", "ada", 20);

    // The one who did NOT send the original request ends it.
    expect(cancel(db, "ada", "bea")).toEqual({ state: "none", refused: null });
    expect(rowCount(db)).toBe(0);
    expect(friends(db, "bea")).toEqual([]);
  });

  test("I cannot cancel away a refusal I was given", () => {
    request(db, "ada", "bea", 10);
    decline(db, "bea", "ada", 20);

    cancel(db, "ada", "bea");

    expect(rowCount(db)).toBe(1);
    expect(state(db, "ada", "bea")).toBe("declined_out");
    expect(request(db, "ada", "bea", 30).refused?.status).toBe(409);
  });

  test("I cannot withdraw a request somebody sent ME", () => {
    request(db, "bea", "ada", 10);

    cancel(db, "ada", "bea");

    // Still there, still mine to answer: refusing is `rifiuta`, and a refusal
    // is remembered while a cancellation is not.
    expect(rowCount(db)).toBe(1);
    expect(incoming(db, "ada")).toEqual([{ id: "bea", since: 10 }]);
  });

  test("cancelling what is not there is not an error", () => {
    expect(cancel(db, "ada", "cy")).toEqual({ state: "none", refused: null });
  });
});

describe("the three lists", () => {
  let db: Database;
  beforeEach(() => { db = fullSchema(); });

  test("one read, three answers, newest first", () => {
    request(db, "ada", "bea", 10);
    accept(db, "bea", "ada", 15);
    request(db, "ada", "cy", 20);
    db.run("INSERT INTO people (id, display_name) VALUES ('dee', 'dee')");
    request(db, "dee", "ada", 30);

    expect(friends(db, "ada")).toEqual(["bea"]);
    expect(outgoing(db, "ada")).toEqual([{ id: "cy", since: 20 }]);
    expect(incoming(db, "ada")).toEqual([{ id: "dee", since: 30 }]);

    db.run("INSERT INTO people (id, display_name) VALUES ('eve', 'eve')");
    request(db, "eve", "ada", 40);
    expect(incoming(db, "ada").map((r) => r.id)).toEqual(["eve", "dee"]);
  });

  test("a REVOKED person leaves the lists, and the row stays for the day it is lifted", () => {
    request(db, "ada", "bea", 10);
    accept(db, "bea", "ada", 15);
    request(db, "cy", "ada", 20);
    db.run("UPDATE people SET revoked_at = 1 WHERE id = 'bea'");

    expect(friends(db, "ada")).toEqual([]);
    expect(incoming(db, "ada")).toEqual([{ id: "cy", since: 20 }]);
    expect(rowCount(db)).toBe(2);

    db.run("UPDATE people SET revoked_at = NULL WHERE id = 'bea'");
    expect(friends(db, "ada")).toEqual(["bea"]);
  });

  test("deleting a person takes their requests with them", () => {
    db.run("PRAGMA foreign_keys = ON");
    request(db, "ada", "bea", 10);
    request(db, "cy", "bea", 11);

    db.run("DELETE FROM people WHERE id = 'ada'");

    expect(rowCount(db)).toBe(1);
    expect(incoming(db, "bea")).toEqual([{ id: "cy", since: 11 }]);
  });
});

describe("a schema older than the migration", () => {
  let db: Database;
  beforeEach(() => { db = oldSchema(); });

  test("nothing throws, and nothing claims a relation that is not there", () => {
    expect(() => request(db, "ada", "bea", 10)).not.toThrow();
    expect(request(db, "ada", "bea", 10)).toEqual({ state: "none", refused: null });
    expect(accept(db, "ada", "bea", 10)).toEqual({ state: "none", refused: null });
    expect(decline(db, "ada", "bea", 10)).toEqual({ state: "none", refused: null });
    expect(cancel(db, "ada", "bea")).toEqual({ state: "none", refused: null });
    expect(state(db, "ada", "bea")).toBe("none");
    expect(friends(db, "ada")).toEqual([]);
    expect(incoming(db, "ada")).toEqual([]);
    expect(outgoing(db, "ada")).toEqual([]);
  });

  test("the rule that does not need the table still holds", () => {
    // A self-request is refused before anything is read, so the reason reaches
    // the caller even on a database that could not have stored the row.
    expect(request(db, "ada", "ada", 10).refused?.status).toBe(400);
  });
});
