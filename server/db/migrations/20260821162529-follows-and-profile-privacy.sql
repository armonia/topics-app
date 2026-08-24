-- 20260821162529-follows-and-profile-privacy.sql
--
-- The prefix is a UTC timestamp (YYYYMMDDHHMMSS), not a counter: that is what
-- makes a collision between parallel cards impossible. Do not rename it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- A PROFILE STOPS BEING A SIDE EFFECT OF THE ORGANISATION.
--
-- Until now "the people I can see" meant "the people of my organisation", and
-- the 084 said so on purpose: `people` grows a row for every person this
-- machine has ever met, so handing it out whole would publish an address book
-- nobody asked to publish. The closed list solved that, and it bought a
-- problem with it: the ONLY way to reach a person was to be billed together
-- with them. Two friends on two different installations could not see each
-- other without one of them joining the other's licence, and an organisation
-- is a licence, not a friendship.
--
-- So the reachable set gets a SECOND source, and this file is the first half
-- of it: an asymmetric follow. Asymmetric because that is the honest shape of
-- the relation. A mutual edge would need an invitation, an acceptance, a
-- pending state and a refusal, which is four states and two round trips to
-- express "I want to see what this person is doing". Following needs one row,
-- and the person followed is told by a counter rather than by a request they
-- have to answer.
--
-- The ORGANISATION DATA MODEL IS UNTOUCHED HERE, and deliberately. It still
-- carries the licence, the grants and project visibility, and it still feeds
-- the reachable set as a DISCOVERY pool: co-members keep seeing each other
-- without following anybody. What changes is only that the profile surface
-- stops NAMING it, because "the people of your org" is a billing fact and the
-- reason a face shows up on a screen should not be one.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. THE FOLLOW EDGE.
--
-- One row per direction, and the primary key IS the pair: following twice is
-- the same fact as following once, so the idempotence lives in the schema
-- instead of in every caller that writes here. `INSERT OR IGNORE` then costs
-- nothing and cannot drift from a check written in TypeScript.
--
-- ON DELETE CASCADE on both sides because an edge to a person who no longer
-- exists is not a weaker edge, it is garbage: it would keep a counter above
-- zero for a follower nobody can render, and a count that nothing can explain
-- is worse than a count that is missing. This is a LOCAL table with no
-- `origin`/`rev`/`synced_at`: there is nothing to synchronise yet, and adding
-- the sync columns now would claim a remote authority that does not exist.
--
-- No self-follow constraint in SQL, and that is a decision rather than an
-- oversight: SQLite would enforce it with a CHECK, but the caller has to
-- answer 400 with a reason anyway, so the rule is written once in
-- `server/lib/follows.ts` where the message lives. A CHECK here would turn a
-- refusal we explain into an exception we swallow.
CREATE TABLE IF NOT EXISTS follows (
  follower_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  followee_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (follower_id, followee_id)
);

-- The primary key already answers "who does this person follow" (it leads with
-- `follower_id`). This index answers the OTHER direction, "who follows this
-- person", which is the one the profile header asks on every open. Without it
-- the followers count is a full scan of the table.
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);

-- ── 2. PRIVACY, AS COLUMNS ON THE PERSON.
--
-- Five switches and not one, because "private profile" is not a single wish.
-- The common case is somebody who is happy to be listed and to be followed but
-- does not want their spend on a colleague's screen, and a single boolean can
-- only offer them the choice between being visible entirely or not at all.
--
-- ON `people` AND NOT IN A SIDE TABLE. A person always has a privacy setting:
-- there is no state where the answer is "unknown", so a LEFT JOIN that returns
-- NULL would be a shape that never occurs, and every reader would have to
-- decide what NULL means. Five INTEGER columns with defaults answer the
-- question for every row that already exists, including the rows written
-- before this file ran.
--
-- INTEGER AND NOT BOOLEAN because SQLite has no boolean, and NOT NULL with a
-- DEFAULT because a privacy flag that can be NULL has a third state, and the
-- third state of a privacy flag always ends up being read as "allowed" by
-- somebody.
--
-- THE DEFAULTS ARE THE POLICY, so each one says why it is what it is.

-- Default 1: the profile is reachable. A profile nobody can open is the same
-- as no profile, and defaulting to hidden would ship a feature that appears
-- broken to every person who never opens the settings. The person who wants
-- out flips this and disappears from the lists, the search and their own
-- follower rows in one gesture.
ALTER TABLE people ADD COLUMN show_profile INTEGER NOT NULL DEFAULT 1;

-- Default 1: prompts, tokens and cost. This is the number the profile exists
-- to show, and it is already a bounded, per-person figure rather than a log of
-- what the person wrote. Somebody who reads it as a performance review turns
-- it off, and the switch is here precisely so that the answer to "I do not
-- want to be measured" is one click and not "stop using the app".
ALTER TABLE people ADD COLUMN show_stats INTEGER NOT NULL DEFAULT 1;

-- DEFAULT 0, AND THIS IS THE ONE THAT MATTERS. An email address is not a
-- decoration on a profile: it is a durable, off-platform identifier that
-- follows a person for years, it is the address a spammer wants, and it is
-- typically their work address, so publishing it is a decision their employer
-- has an opinion about too. Every other field here can be re-hidden and the
-- damage stops; an address that has been read is out of our hands forever.
--
-- The asymmetry with the other four is deliberate: this is the only field
-- where the mistake is IRREVERSIBLE, so it is the only field where the default
-- has to be the closed one. Publishing it must be a thing somebody chose,
-- never a thing that happened to them because a migration ran. Note also that
-- `people.email` is often filled by an INVITE rather than by the person
-- themself (084: the address is how you invite somebody who has not paired
-- anything yet), so a default of 1 would publish an address its owner never
-- typed here.
ALTER TABLE people ADD COLUMN show_email INTEGER NOT NULL DEFAULT 0;

-- Default 1: the two counters and the two lists. The follower graph is the
-- thing that makes a follow worth doing, and hiding it by default would leave
-- every new edge invisible to everybody including the person who created it.
-- It stays a switch because a follower list is also a social graph, and there
-- are people for whom "who I read" is the private part.
ALTER TABLE people ADD COLUMN show_followers INTEGER NOT NULL DEFAULT 1;

-- Default 1: last seen. Knowing whether the person you are about to ping is
-- around is most of what a small team reads a profile for, and the value is
-- already coarse (the newest `devices.last_seen_at`, in milliseconds, with the
-- "online" threshold left to whoever draws it). It is a switch because a
-- last-seen timestamp is also an attendance record, and nobody should have to
-- leave the app to stop broadcasting one.
ALTER TABLE people ADD COLUMN show_presence INTEGER NOT NULL DEFAULT 1;

-- NOTHING IS SEEDED. Every existing row takes the defaults above by virtue of
-- the DEFAULT clause, which is the whole point of writing the policy there: an
-- UPDATE that set the same values would be a second copy of the policy, and
-- the second copy is the one that is forgotten when a default changes.

-- ── 3. THE LINK GITHUB SHOWS UNDER THE BIO.
--
-- The profile header renders what GitHub renders, and GitHub puts a website
-- and an X handle right under the bio. We were caching neither, so the header
-- had a hole that no amount of client work could fill: the data was never
-- asked for. These live in `github_profiles` and not in `people` for the
-- reason the 094 already gives: this is a CACHE of somebody else's data, it
-- can be dropped whole and rebuilt with one request, and it must never sit in
-- the row we call "the person".
--
-- Nullable with no default because "we have not fetched it" and "they left it
-- empty" are both honestly NULL here, and a default of empty string would
-- invent a third value that means neither.
ALTER TABLE github_profiles ADD COLUMN blog TEXT;
ALTER TABLE github_profiles ADD COLUMN twitter_username TEXT;
