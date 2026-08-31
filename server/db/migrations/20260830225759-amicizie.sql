-- 20260830225759-amicizie.sql
--
-- Il prefisso è un timestamp UTC (YYYYMMDDHHMMSS), non un contatore: è quello
-- che rende impossibile la collisione fra card in parallelo. Non rinominarlo.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- A SECOND RELATION, NEXT TO THE FOLLOW AND NOT INSTEAD OF IT.
--
-- The 20260821162529 argued for an asymmetric follow and against a mutual
-- edge, and the argument was right about what it was answering: "I want to see
-- what this person is doing" does not need an invitation, an acceptance and a
-- refusal to be expressed, and making somebody answer a request before you can
-- read their profile is a toll on a gesture that costs them nothing.
--
-- What that argument does NOT cover is the other sentence, the one a follow
-- cannot say: "we know each other". That one is mutual by definition, and a
-- relation that is mutual by definition cannot be stored as two independent
-- rows that happen to point at each other. Two follows in opposite directions
-- look like a friendship and are not one: neither side ever agreed to
-- anything, and either side can create half of it alone.
--
-- So the two coexist and mean different things. The follow keeps feeding the
-- profile page and the reachable set exactly as before, untouched by this
-- file. The friendship is the one that is ASKED FOR and ANSWERED, and it is
-- the only one of the two that can be refused.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── THE FRIENDSHIP ROW.
--
-- ONE ROW PER PAIR AND NOT TWO. The direction is not the relation here, it is
-- the HISTORY of it: `requester_id` records who asked, which is the only thing
-- that tells the two people apart afterwards. Storing a friendship as two
-- symmetric rows would need both of them written in one transaction and both
-- of them kept in step forever, and the day they drift the pair is friends in
-- one direction only, which is a state this relation does not have.
--
-- The primary key is the ORDERED pair, so the same two people can hold two
-- rows: one in each direction. That is not an accident, it is what makes a
-- refusal survivable. After A asks and B refuses, the row A->B stays declined
-- and B is still free to ask in their turn, which writes B->A. Anything that
-- reads a pair therefore has to look at both directions and pick, and
-- `server/lib/friendships.ts` is the single place that does.
--
-- STATE AS TEXT AND NOT THREE BOOLEANS, because the three values are mutually
-- exclusive and a set of flags can be asked to hold a combination that means
-- nothing. No CHECK constraint on it, for the same reason the 20260821162529
-- put no self-follow CHECK on `follows`: the caller has to answer with a
-- reason anyway, so the rule lives once in TypeScript where the message is.
-- A CHECK here would turn a refusal we can explain into an exception we would
-- have to swallow, and a swallowed exception looks exactly like success.
--
-- `decided_at` IS NULLABLE AND `created_at` IS NOT, because "when it was
-- asked" always exists and "when it was answered" is precisely the thing a
-- pending row does not have yet. A sentinel zero would be a third meaning of
-- the same column, and every reader would have to know about it.
--
-- ON DELETE CASCADE on both sides, like the follow edge: a request from or to
-- a person who no longer exists is not a weaker request, it is garbage that
-- would keep an unanswerable row in somebody's inbox.
--
-- LOCAL TABLE, no `origin`/`rev`/`synced_at`. There is nothing to synchronise
-- yet, and adding the sync columns now would claim a remote authority that
-- does not exist.
CREATE TABLE IF NOT EXISTS friendships (
  requester_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  addressee_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  state        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  decided_at   INTEGER,
  PRIMARY KEY (requester_id, addressee_id)
);

-- The primary key leads with `requester_id`, so it already answers "what have
-- I asked for". This index answers the OTHER question, "who is waiting for me
-- to answer", which is the one the app asks on every poll of every open
-- window. Without it the inbox is a full scan of the table on a timer.
CREATE INDEX IF NOT EXISTS idx_friendships_addressee ON friendships(addressee_id);
