/**
 * THE FRIENDSHIP GRAPH: the relation that is asked for and answered.
 *
 * ── WHY THIS EXISTS NEXT TO `follows.ts` AND NOT INSTEAD OF IT ──────────────
 * The two say different sentences. A follow says "I read you": it needs no
 * answer, it costs the person followed nothing, and making them approve it
 * would be a toll on a gesture that takes nothing from them. A friendship says
 * "we know each other", and that one is mutual by definition, so it cannot be
 * two independent rows pointing at each other. Two follows in opposite
 * directions look like a friendship and are not: neither side ever agreed.
 *
 * So the follow stays exactly as it was, feeding the profile page and the
 * reachable set, and this file adds the second relation beside it. Only this
 * one has a request, an acceptance and a refusal, because only this one is
 * about the other person's consent.
 *
 * ── THE FIVE STATES ARE RELATIVE TO THE VIEWER ──────────────────────────────
 * One row, two people, two different situations: the one who asked is waiting,
 * the one who was asked owes an answer. Every read here therefore takes the
 * viewer as its first person and returns the state ALREADY resolved for them.
 * The alternative, shipping the raw row and letting each screen work out which
 * end it is standing on, is how an Accept button eventually appears in front
 * of the person who sent the request.
 *
 * ── A PAIR CAN HOLD TWO ROWS, AND THAT IS THE POINT ─────────────────────────
 * The primary key is the ORDERED pair, so A->B and B->A can both exist. That
 * is what makes a refusal survivable: after A asks and B refuses, the row A->B
 * stays declined forever (which is what stops A from asking again) while B is
 * still free to ask in their turn. Every read below therefore looks at BOTH
 * directions and picks with `RANK`, and no caller outside this file should
 * ever read the table directly.
 *
 * ── THE DEFENSIVE SHAPE ─────────────────────────────────────────────────────
 * Every read is wrapped, the same shape `server/lib/follows.ts` uses and for
 * the same reason: this code runs against databases older than the migration
 * that created `friendships`. A missing table degrades to "no friends" and to
 * "no pending anything", never to an exception that reaches a route and turns
 * a screen into a white page. The fallback falls the safe way here too: an
 * unreadable database claims no relation, so nothing is unlocked by a failure.
 */
import type { Database } from "bun:sqlite";
import type { FriendshipState, FriendshipEdge } from "../../shared/friendship";

/**
 * The wire shapes are DECLARED IN `shared/` and re-exported from here, so a
 * caller on this side has one import. `tests/unit/no-type-mirrors.test.ts`
 * fails on a type declared once per side, and a re-export is not a
 * declaration: it is the way out that gate deliberately leaves open.
 */
export type { FriendshipState, FriendshipEdge } from "../../shared/friendship";

/** Minimal shape of the database, so tests can pass an in-memory SQLite. */
type Db = Pick<Database, "query">;

/**
 * What a gesture did, and what holds afterwards.
 *
 * `state` is always RE-READ from the table rather than assumed, exactly like
 * the follow route re-reads `segue` after writing: a write that hit a database
 * without the table reports nothing, and answering with the state we intended
 * would leave the client drawing a relation that does not exist.
 *
 * `refused` carries the status and the message together because the rule and
 * its reason belong in the same place. A route that had to decide which code a
 * refusal deserves would be a second copy of the rule, and the second copy is
 * the one that drifts.
 */
export interface FriendshipOutcome {
  state: FriendshipState;
  /** `null` when the gesture went through. */
  refused: { status: number; message: string } | null;
}

/** How the table spells the three situations a row can be in. */
type RowState = "pending" | "accepted" | "declined";

/** One row of the pair, already turned around so that `mine` means "I asked". */
interface PairRow {
  other: string;
  st: RowState;
  created: number;
  decided: number | null;
  /** 1 when this row is the one I sent, 0 when it is the one I received. */
  mine: 0 | 1;
}

/**
 * WHICH STATE WINS when the two rows of a pair disagree.
 *
 * They can, and only in one direction that matters: A asked and was refused
 * (A->B declined), then B asked in their turn (B->A pending). From A's side
 * that is both `declined_out` and `pending_in`, and the answer has to be
 * `pending_in` or A could never accept the request sitting in front of them.
 * The general rule is the same one a person would apply: an OPEN question
 * beats a closed past, and an agreement beats both.
 *
 * `pending_in` above `pending_out` is defensive rather than reachable:
 * `richiedi` turns a crossing pair of requests into an acceptance, so the two
 * never coexist. If a future writer breaks that, the pair reads as something
 * somebody can act on instead of as a request nobody can answer.
 */
const RANK: Record<FriendshipState, number> = {
  friends: 4,
  pending_in: 3,
  pending_out: 2,
  declined_out: 1,
  none: 0,
};

/**
 * One row as I see it, or `null` when it says nothing about me.
 *
 * The `null` case is a rule and not a gap: a declined row I RECEIVED means I
 * am the one who refused, and from my side that relation is simply absent. It
 * has to read as `none`, because `none` is exactly the state in which asking
 * is allowed, and the person who refused is the one person who may ask.
 */
function edgeOf(r: PairRow): FriendshipEdge | null {
  const answered = Number(r.decided ?? r.created);
  if (r.st === "accepted") return { personId: r.other, state: "friends", since: answered };
  // A pending row has no `decided_at` by construction, so `since` is when it
  // was sent, which is the date an inbox actually wants to show.
  if (r.st === "pending") {
    return { personId: r.other, state: r.mine ? "pending_out" : "pending_in", since: Number(r.created) };
  }
  if (r.mine) return { personId: r.other, state: "declined_out", since: answered };
  return null;
}

/** The strongest edge of a set of rows about the same person. */
function strongest(rows: PairRow[]): FriendshipEdge | null {
  let best: FriendshipEdge | null = null;
  for (const r of rows) {
    const e = edgeOf(r);
    if (e && (!best || RANK[e.state] > RANK[best.state])) best = e;
  }
  return best;
}

/**
 * The rows of ONE pair, both directions.
 *
 * A UNION of two point lookups and not an `OR` over the whole table: each half
 * is a primary-key hit, and the `OR` form makes SQLite choose between the two
 * indexes instead of using both. No join to `people` either, for the reason
 * `segue` gives about the follow edge: every caller has already resolved both
 * people, so the join would cost a lookup to answer the same thing.
 */
function pairRows(db: Db, me: string, other: string): PairRow[] {
  return db.query(`
    SELECT addressee_id AS other, state AS st, created_at AS created, decided_at AS decided, 1 AS mine
      FROM friendships WHERE requester_id = ? AND addressee_id = ?
    UNION ALL
    SELECT requester_id AS other, state AS st, created_at AS created, decided_at AS decided, 0 AS mine
      FROM friendships WHERE requester_id = ? AND addressee_id = ?`)
    .all(me, other, other, me) as PairRow[];
}

/**
 * EVERY relation of one person, resolved from their side, strongest first per
 * person.
 *
 * One read and three lists, because the three questions ("who are my friends",
 * "who is waiting for me", "who am I waiting for") are asked together by the
 * one screen that shows them and by the one poll that refreshes it. Three
 * queries would be three instants, and the friends count would disagree with
 * the list under it for exactly as long as somebody was looking.
 *
 * REVOKED PEOPLE ARE OUT, the same rule `idFollower` applies: a relation with
 * a person nobody can render is not a weaker relation, it is a row that would
 * put a number over a list that does not contain it. The edge itself stays in
 * the table, so lifting the revocation gives the graph back.
 *
 * EXPORTED, and the three functions under it are views on top of it. A caller
 * that wants one list should say which one and read the named function; the
 * one caller that wants all three at once reads this, because three calls
 * would be three instants and the counts would disagree with the lists
 * underneath them for as long as somebody was looking.
 */
export function relazioni(db: Db, me: string): FriendshipEdge[] {
  if (!me) return [];
  let rows: PairRow[];
  try {
    rows = db.query(`
      SELECT f.addressee_id AS other, f.state AS st, f.created_at AS created,
             f.decided_at AS decided, 1 AS mine
        FROM friendships f JOIN people p ON p.id = f.addressee_id
       WHERE f.requester_id = ? AND p.revoked_at IS NULL
      UNION ALL
      SELECT f.requester_id AS other, f.state AS st, f.created_at AS created,
             f.decided_at AS decided, 0 AS mine
        FROM friendships f JOIN people p ON p.id = f.requester_id
       WHERE f.addressee_id = ? AND p.revoked_at IS NULL`)
      .all(me, me) as PairRow[];
  } catch {
    // No `friendships` table: this person has no relations, which on a
    // database that cannot hold one is as true as anything else we could say.
    return [];
  }

  const perPerson = new Map<string, PairRow[]>();
  for (const r of rows) {
    const bucket = perPerson.get(r.other);
    if (bucket) bucket.push(r);
    else perPerson.set(r.other, [r]);
  }
  const out: FriendshipEdge[] = [];
  for (const bucket of perPerson.values()) {
    const e = strongest(bucket);
    if (e) out.push(e);
  }
  // Newest first, like the two follow lists: the row somebody wants to act on
  // is almost always the one that just arrived.
  return out.sort((a, b) => b.since - a.since);
}

/** Where I stand with one person. `none` for a stranger, for myself, and on a
 *  database that cannot answer. */
export function stato(db: Db, me: string, other: string): FriendshipState {
  if (!me || !other || me === other) return "none";
  try {
    return strongest(pairRows(db, me, other))?.state ?? "none";
  } catch {
    return "none";
  }
}

/** The people I am actually friends with. This is the list that widens the
 *  reachable set, so it contains accepted relations and nothing else. */
export function amici(db: Db, me: string): string[] {
  return relazioni(db, me).filter((e) => e.state === "friends").map((e) => e.personId);
}

/** Requests waiting for MY answer, newest first. */
export function inArrivo(db: Db, me: string): Array<{ id: string; since: number }> {
  return relazioni(db, me).filter((e) => e.state === "pending_in")
    .map((e) => ({ id: e.personId, since: e.since }));
}

/**
 * Requests I sent that have not been answered, newest first.
 *
 * `declined_out` is NOT in here, and that is deliberate: a refused request
 * still shows to its sender as something they sent, but it is not waiting for
 * anybody, so listing it under "outgoing" would tell the sender they were
 * refused. The state on the profile says the same non-committal thing a
 * pending one does; only this server knows the difference.
 */
export function inUscita(db: Db, me: string): Array<{ id: string; since: number }> {
  return relazioni(db, me).filter((e) => e.state === "pending_out")
    .map((e) => ({ id: e.personId, since: e.since }));
}

/** Whatever holds now, with no refusal attached. */
const settled = (db: Db, me: string, other: string): FriendshipOutcome =>
  ({ state: stato(db, me, other), refused: null });

/**
 * NO SELF-FRIENDSHIP, and the rule lives here with its message rather than in
 * a CHECK on the table, for the reason the follow rule already gives: the
 * caller has to answer with a reason anyway, and a constraint in SQL would
 * turn a refusal we can explain into an exception we would have to swallow.
 */
const NOT_YOURSELF = { status: 400, message: "cannot befriend yourself" };

/**
 * Ask, or answer by asking back.
 *
 * THE ORDER OF THE CHECKS IS THE BEHAVIOUR, so it is written out:
 *
 *  1. Already friends: saying it twice is saying it once.
 *  2. THEY HAVE ASKED ME. Then this gesture is an acceptance, not a second
 *     request. Two people who both press "add friend" mean the same thing, and
 *     a system that answered "you already have a pending request from them"
 *     would be asking them to perform the ritual it prefers.
 *  3. I have already asked: idempotent, and the original timestamp survives.
 *  4. I ASKED AND WAS REFUSED: 409, and this is the rule that gives a refusal
 *     its weight. If the refused person could just ask again, "no" would mean
 *     "not yet" and the block would be a speed bump. The door stays closed on
 *     the side that knocked, and the person who closed it can still open it by
 *     asking in their turn, which is checked BEFORE this one at step 2.
 *
 * Step 2 sits above step 4 for that reason: an open question beats a closed
 * past. A stale row in the other direction is deleted when the pair agrees, so
 * an unfriend later leaves both of them free to ask again instead of
 * resurrecting a refusal they had both moved past.
 */
export function richiedi(db: Db, me: string, other: string, now = Date.now()): FriendshipOutcome {
  if (!me || !other || me === other) return { state: "none", refused: NOT_YOURSELF };
  try {
    const rows = pairRows(db, me, other);
    const mine = rows.find((r) => r.mine === 1);
    const theirs = rows.find((r) => r.mine === 0);

    if (mine?.st === "accepted" || theirs?.st === "accepted") return settled(db, me, other);

    if (theirs?.st === "pending") {
      db.query("UPDATE friendships SET state = 'accepted', decided_at = ? WHERE requester_id = ? AND addressee_id = ?")
        .run(now, other, me);
      dropRow(db, me, other);
      return settled(db, me, other);
    }

    if (mine?.st === "pending") return settled(db, me, other);
    if (mine?.st === "declined") {
      return { state: "declined_out", refused: { status: 409, message: "that request has already been answered" } };
    }

    db.query("INSERT OR IGNORE INTO friendships (requester_id, addressee_id, state, created_at) VALUES (?, ?, 'pending', ?)")
      .run(me, other, now);
    return settled(db, me, other);
  } catch {
    // No table, or a person who no longer exists on the other end of the
    // foreign key. Nothing was written, so nothing is claimed.
    return { state: "none", refused: null };
  }
}

/**
 * Accept. ONLY the addressee of a pending row, because accepting is the answer
 * and the person who asked has nothing left to answer.
 *
 * Idempotent when the pair is already friends, refused with a 409 when there
 * is nothing to accept: a stale screen that agrees with reality should not
 * produce an error, and one that invents a request should not silently
 * succeed.
 */
export function accetta(db: Db, me: string, other: string, now = Date.now()): FriendshipOutcome {
  if (!me || !other || me === other) return { state: "none", refused: NOT_YOURSELF };
  try {
    const rows = pairRows(db, me, other);
    if (rows.some((r) => r.st === "accepted")) return settled(db, me, other);
    const theirs = rows.find((r) => r.mine === 0);
    if (theirs?.st !== "pending") {
      return { state: stato(db, me, other), refused: { status: 409, message: "no pending friend request from that person" } };
    }
    db.query("UPDATE friendships SET state = 'accepted', decided_at = ? WHERE requester_id = ? AND addressee_id = ?")
      .run(now, other, me);
    // The pair agreed, so the pair holds ONE row. Anything I had sent or been
    // refused in the other direction is a past both of them just overruled,
    // and leaving it would make a later unfriend resurrect it.
    dropRow(db, me, other);
    return settled(db, me, other);
  } catch {
    return { state: "none", refused: null };
  }
}

/**
 * Refuse. THE ROW IS KEPT, and that is the whole mechanism: a deleted row
 * would leave the pair looking like strangers, and the request would be back
 * within the minute. What is stored is not spite, it is the answer.
 *
 * The refusal is not announced. `stato` reports `declined_out` to the person allow-italian: names the exported function
 * who asked and `none` to the person who refused, and the client is expected
 * to draw `declined_out` exactly like a request still pending. The asymmetry
 * is the point: only one of the two states lets you ask again.
 */
export function rifiuta(db: Db, me: string, other: string, now = Date.now()): FriendshipOutcome {
  if (!me || !other || me === other) return { state: "none", refused: NOT_YOURSELF };
  try {
    const theirs = pairRows(db, me, other).find((r) => r.mine === 0);
    if (theirs?.st === "declined") return settled(db, me, other);
    if (theirs?.st !== "pending") {
      return { state: stato(db, me, other), refused: { status: 409, message: "no pending friend request from that person" } };
    }
    db.query("UPDATE friendships SET state = 'declined', decided_at = ? WHERE requester_id = ? AND addressee_id = ?")
      .run(now, other, me);
    return settled(db, me, other);
  } catch {
    return { state: "none", refused: null };
  }
}

/**
 * Withdraw my own request, or end a friendship. One gesture and not two,
 * because from the person pressing it there is one meaning: undo this.
 *
 * WHAT IT WILL NOT TOUCH, and why each one is deliberate:
 *
 *  · A DECLINED ROW I SENT. Deleting it would let the refused person clear
 *    their own refusal and ask again, which is the entire rule undone by the
 *    one party it was protecting the other from.
 *  · A PENDING ROW I RECEIVED. That is not mine to withdraw. Answering it is
 *    `rifiuta`, and the difference matters: a refusal is remembered.
 *
 * It never refuses. Removing something that is not there is not an error, the
 * same call `unfollow` makes, and a caller cancelling twice is a caller whose
 * screen was one poll behind.
 */
export function annulla(db: Db, me: string, other: string): FriendshipOutcome {
  if (!me || !other || me === other) return { state: "none", refused: null };
  try {
    db.query(`
      DELETE FROM friendships
       WHERE (requester_id = ? AND addressee_id = ? AND state IN ('pending', 'accepted'))
          OR (requester_id = ? AND addressee_id = ? AND state = 'accepted')`)
      .run(me, other, other, me);
    return settled(db, me, other);
  } catch {
    return { state: "none", refused: null };
  }
}

/** The row I sent, gone. Used when the pair agrees and must hold one row. */
function dropRow(db: Db, me: string, other: string): void {
  db.query("DELETE FROM friendships WHERE requester_id = ? AND addressee_id = ?").run(me, other);
}
