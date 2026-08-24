/**
 * THE FOLLOW GRAPH, and the five switches that decide what a profile shows.
 *
 * ── WHY A FOLLOW AND NOT A FRIENDSHIP ───────────────────────────────────────
 * The edge is ASYMMETRIC on purpose. A mutual relation needs an invitation, an
 * acceptance, a pending state and a refusal, which is four states and two
 * round trips to express "I want to see what this person is doing". A follow
 * needs one row, and the person followed learns about it from a counter
 * instead of from a request they have to answer. It is also the honest shape:
 * reading somebody's work is not a claim on their attention.
 *
 * The edge does NOT grant anything. It widens the set of profiles a person can
 * open, and nothing else: no project, no task, no file. Access is still
 * `grants` plus `org_members`, exactly where it was, which is why this file
 * touches neither.
 *
 * ── WHY PRIVACY LIVES HERE TOO ──────────────────────────────────────────────
 * Because the two are one question. "Who can reach me" and "what do they see
 * once they do" are answered on the same screen and by the same person, and
 * splitting them across two modules is how one of the two ends up being asked
 * by only half the callers. The routes read both from here, once per request.
 *
 * ── THE DEFENSIVE SHAPE, AND WHY EVERY FUNCTION HAS IT ──────────────────────
 * Every read is wrapped in try/catch with a sane fallback, the same shape
 * `server/lib/person-stats.ts` uses and for the same reason: this code runs
 * against databases older than the migration that created `follows` and the
 * five `people.show_*` columns. A missing table must degrade to "no edges" and
 * a missing column to the defaults, never to an exception that reaches the
 * route and turns a profile screen into a white page.
 *
 * The fallbacks fall the SAFE way, which is not always the same direction:
 * absent edges read as "follows nobody", absent columns read as the DEFAULTS
 * of the migration, and that means `showEmail` falls to false. An address is
 * the one field here whose accidental publication cannot be undone, so on a
 * schema we cannot interrogate it stays closed.
 */
import type { Database } from "bun:sqlite";
import type { ProfilePrivacy, ConteggiFollow as Conteggi } from "../../shared/profile";

/**
 * The two shapes that cross the wire are DECLARED IN `shared/`, and re-exported
 * from here so a caller on this side has one import. They are not written twice:
 * `tests/unit/no-type-mirrors.test.ts` fails on a type declared once per side,
 * because a hand-copied shape carries a "keep in sync" comment and then does
 * not. A re-export is not a declaration, which is exactly why this is the way
 * out that gate leaves open.
 */
export type { ProfilePrivacy } from "../../shared/profile";

/** Minimal shape of the database, so tests can pass an in-memory SQLite. */
type Db = Pick<Database, "query">;

/**
 * The defaults, kept in step with the DEFAULT clauses of the migration.
 *
 * They are duplicated here rather than read back from the schema because this
 * object is also the answer for a database that does not HAVE those columns,
 * which is precisely the case where the schema cannot be asked. The one that
 * differs is `showEmail`: an address is a durable off-platform identifier that
 * a spammer wants and that an invite may have filled in on the person's
 * behalf, so publishing it has to be something somebody chose.
 */
export const PRIVACY_DEFAULTS: ProfilePrivacy = {
  showProfile: true,
  showStats: true,
  showEmail: false,
  showFollowers: true,
  showPresence: true,
};

/** Column name per field, in one place: the reader and the writer share it. */
const COLONNE: Record<keyof ProfilePrivacy, string> = {
  showProfile: "show_profile",
  showStats: "show_stats",
  showEmail: "show_email",
  showFollowers: "show_followers",
  showPresence: "show_presence",
};

const CAMPI = Object.keys(COLONNE) as (keyof ProfilePrivacy)[];

/** SQLite has no boolean: anything other than 0 is a yes. */
const acceso = (v: unknown): boolean => Number(v) !== 0;

/**
 * Follow. `true` means the edge is there afterwards, whether this call put it
 * there or a previous one did: re-following is not an error, it is the same
 * fact stated twice. `false` means it is NOT there, which happens for a
 * self-follow and on a database that cannot hold the row.
 *
 * NO SELF-FOLLOW, and the rule is here rather than in a CHECK on the table
 * because the caller has to answer with a reason anyway. A constraint in SQL
 * would turn a refusal we can explain into an exception we would have to
 * swallow, and a swallowed exception is indistinguishable from success.
 *
 * IDEMPOTENT by the primary key, not by a preliminary SELECT: `INSERT OR
 * IGNORE` cannot race with a second writer, and a read-then-write can.
 */
export function follow(db: Db, followerId: string, followeeId: string, now = Date.now()): boolean {
  if (!followerId || !followeeId || followerId === followeeId) return false;
  try {
    db.query("INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)")
      .run(followerId, followeeId, now);
    return true;
  } catch {
    // No `follows` table, or a person who no longer exists on the other end of
    // the foreign key. Either way the edge is not there, which is what the
    // caller is told.
    return false;
  }
}

/** Unfollow. `false` if there was nothing to remove, or nowhere to remove it from. */
export function unfollow(db: Db, followerId: string, followeeId: string): boolean {
  try {
    db.query("DELETE FROM follows WHERE follower_id = ? AND followee_id = ?")
      .run(followerId, followeeId);
    return true;
  } catch {
    return false;
  }
}

/**
 * AN EDGE YOU CANNOT RENDER IS NOT AN EDGE, and this is why every read below
 * joins `people` instead of counting rows.
 *
 * Two ways a row can be there and still be nothing to show, and both had to be
 * excluded for the same reason:
 *
 *  · REVOKED. The 084 revokes a person with a tombstone instead of deleting
 *    the row, so the `ON DELETE CASCADE` on `follows` almost never fires: the
 *    edges of a revoked person stay in the table. That is the RIGHT storage,
 *    because lifting the revocation has to give the graph back and a cascade
 *    would have thrown it away. It is the wrong thing to READ.
 *  · HIDDEN. Somebody with `show_profile = 0` is omitted from the two list
 *    routes, so counting them would put a number over a list that does not
 *    contain them.
 *
 * In both cases the failure is the same and it is the one this file exists to
 * avoid: the header says three followers while the list underneath renders
 * two. A number the screen next to it cannot explain is worse than no number.
 *
 * THE VIEWER IS PART OF THE QUESTION, which is why it is an argument and not a
 * detail. The list routes exempt the viewer's own row from the visibility
 * filter (you are always visible to yourself), so the count has to exempt
 * exactly the same row or the two disagree again for the one person who would
 * definitely notice. `null` matches nothing in SQL, so a viewerless call just
 * counts the publicly visible edges.
 */
const EDGE_VISIBILE = "p.revoked_at IS NULL AND (p.show_profile != 0 OR p.id = ?)";

/**
 * The two counters of one person, as THIS viewer would see the lists.
 *
 * Two queries and not one: they read opposite ends of the edge, so a single
 * statement would have to walk one of the two directions without an index.
 * `followers` uses `idx_follows_followee`, `following` uses the primary key,
 * and both are a seek before the join to `people` on its own primary key.
 */
export function conteggiFollow(db: Db, personId: string, viewerId: string | null = null): Conteggi {
  try {
    const f = db.query(
      `SELECT COUNT(*) AS n FROM follows f JOIN people p ON p.id = f.follower_id
        WHERE f.followee_id = ? AND ${EDGE_VISIBILE}`).get(personId, viewerId) as { n: number } | undefined;
    const s = db.query(
      `SELECT COUNT(*) AS n FROM follows f JOIN people p ON p.id = f.followee_id
        WHERE f.follower_id = ? AND ${EDGE_VISIBILE}`).get(personId, viewerId) as { n: number } | undefined;
    return { followers: Number(f?.n ?? 0), following: Number(s?.n ?? 0) };
  } catch {
    // Zero here reads as "follows nobody, followed by nobody", which on a
    // database without the table is as true as anything else we could say.
    // `follows` and `show_profile` are born in the SAME migration, so there is
    // no schema where the table exists and the column does not.
    return { followers: 0, following: 0 };
  }
}

/**
 * Does the first person follow the second?
 *
 * The raw edge, with no join: every caller has already resolved both people as
 * live (a revoked target is a 404 well before this), so the join would only
 * cost a lookup to answer the same thing. This is the one read where "is the
 * row there" and "is it worth rendering" are the same question.
 */
export function segue(db: Db, followerId: string, followeeId: string): boolean {
  if (!followerId || !followeeId) return false;
  try {
    return !!db.query("SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?")
      .get(followerId, followeeId);
  } catch {
    return false;
  }
}

/**
 * The LIVE people who follow this person, newest edge first.
 *
 * Revoked only, NOT `show_profile`: this feeds the reachable set, and hiding
 * your profile does not blind you. A hidden person still sees the people they
 * follow; it is the other direction that closes. Whether a row is worth
 * DRAWING is asked again by the route, one person at a time.
 */
export function idFollower(db: Db, personId: string): string[] {
  try {
    const righe = db.query(
      `SELECT f.follower_id AS id FROM follows f JOIN people p ON p.id = f.follower_id
        WHERE f.followee_id = ? AND p.revoked_at IS NULL
        ORDER BY f.created_at DESC`).all(personId) as Array<{ id: string }>;
    return righe.map((r) => r.id);
  } catch {
    return [];
  }
}

/** The LIVE people this person follows, newest edge first. Same rule as above. */
export function idSeguiti(db: Db, personId: string): string[] {
  try {
    const righe = db.query(
      `SELECT f.followee_id AS id FROM follows f JOIN people p ON p.id = f.followee_id
        WHERE f.follower_id = ? AND p.revoked_at IS NULL
        ORDER BY f.created_at DESC`).all(personId) as Array<{ id: string }>;
    return righe.map((r) => r.id);
  } catch {
    return [];
  }
}

/**
 * What this person has decided to show.
 *
 * The five columns are selected by name rather than with `SELECT *` so that a
 * database missing even one of them throws HERE, where the fallback is the
 * documented default set, instead of yielding a row with undefined fields that
 * every caller would then have to second-guess.
 *
 * An unknown person also gets the defaults. The routes ask "does this person
 * exist" separately, and answering that question twice with two different
 * shapes is how the two answers eventually disagree.
 */
export function privacyPersona(db: Db, personId: string): ProfilePrivacy {
  try {
    const r = db.query(
      "SELECT show_profile, show_stats, show_email, show_followers, show_presence FROM people WHERE id = ?",
    ).get(personId) as Record<string, unknown> | undefined;
    if (!r) return { ...PRIVACY_DEFAULTS };
    return {
      showProfile: acceso(r.show_profile),
      showStats: acceso(r.show_stats),
      showEmail: acceso(r.show_email),
      showFollowers: acceso(r.show_followers),
      showPresence: acceso(r.show_presence),
    };
  } catch {
    // Schema older than the migration that added the five columns. Same
    // defensive shape as `statistichePersona`: the profile screen degrades to
    // the documented defaults instead of failing, and `showEmail` stays closed
    // because that is the field whose accidental publication is permanent.
    return { ...PRIVACY_DEFAULTS };
  }
}

/**
 * Write a PARTIAL set of switches and return the resulting state.
 *
 * Partial because the client sends only what the person just toggled: a full
 * object would make a stale screen able to re-open a switch somebody closed on
 * another device. Keys that are absent, unknown, or not actually booleans are
 * dropped rather than coerced, and the coercion is the part that matters: a
 * body carrying the string "false" would be truthy, and the switch it flipped
 * open would be a privacy switch.
 *
 * The `rev`/`updated_at` bump is the same one every other write to `people`
 * does: a row that changes without moving its revision is a row an open socket
 * will never notice has changed.
 */
export function impostaPrivacy(
  db: Db,
  personId: string,
  patch: Partial<ProfilePrivacy>,
  now = Date.now(),
): ProfilePrivacy {
  const set: string[] = [];
  const valori: number[] = [];
  for (const campo of CAMPI) {
    const v = patch[campo];
    if (typeof v !== "boolean") continue;
    set.push(`${COLONNE[campo]} = ?`);
    valori.push(v ? 1 : 0);
  }
  if (set.length) {
    try {
      db.query(`UPDATE people SET ${set.join(", ")}, rev = rev + 1, updated_at = ? WHERE id = ?`)
        .run(...valori, now, personId);
    } catch {
      // Nothing was written, so nothing is claimed: the read below reports the
      // state that actually holds, which on an unmigrated database is the
      // defaults.
    }
  }
  return privacyPersona(db, personId);
}
