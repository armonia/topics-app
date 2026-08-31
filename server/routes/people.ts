/**
 * Routes: `/api/people`, THE PROFILES.
 *
 *   GET    /api/people                    the address book, with a face where there is one
 *   GET    /api/people/:id                one person, fresh GitHub profile and stats
 *   PATCH  /api/people/:id                attach or detach a GitHub login
 *   POST   /api/people/:id/follow         start following
 *   DELETE /api/people/:id/follow         stop following
 *   GET    /api/people/:id/followers      who follows this person
 *   GET    /api/people/:id/following      who this person follows
 *   GET    /api/people/:id/privacy        my five switches (self only)
 *   PATCH  /api/people/:id/privacy        change some of them (self only)
 *   POST   /api/people/:id/friend         ask, or accept a request already sent to me
 *   POST   /api/people/:id/friend/accept  say yes
 *   POST   /api/people/:id/friend/decline say no, once
 *   DELETE /api/people/:id/friend         withdraw my request, or end a friendship
 *   GET    /api/friendships               my friends, and the requests both ways
 *
 * The last one is the odd path out and deliberately so: it is not about a
 * person, it is about MY three lists, and hanging it off `/api/people/:id`
 * would have meant inventing an id for the caller in a surface where the
 * caller is already implicit. It is served here rather than in a router of its
 * own because it reads the same rows, the same privacy switches and the same
 * serializer as everything above, and a second router would be a second copy
 * of all three.
 *
 * ── TWO RELATIONS, AND THEY ANSWER DIFFERENT QUESTIONS ──────────────────────
 * A FOLLOW is "I read you". One row, no answer needed, and the person followed
 * finds out from a counter. A FRIENDSHIP is "we know each other": mutual by
 * definition, so it is asked for, and it is the only one of the two that can
 * be refused. They coexist and neither replaces the other. The follow still
 * feeds the profile page exactly as it did; the friendship adds a request, an
 * acceptance and a refusal, and `server/lib/friendships.ts` holds all three.
 *
 * ── THE BOUNDARY IS NO LONGER THE ORGANISATION ──────────────────────────────
 * It used to be, and the reason was sound: `people` grows a row for every
 * person this machine has ever met, so serving it whole would turn a profile
 * screen into an address book nobody asked to publish. What was wrong was the
 * other half: making the organisation the ONLY way in means the only people
 * you can see are the people you are billed with, and an organisation is a
 * licence, not a friendship.
 *
 * So the reachable set is now a UNION of five things: me, the people I follow,
 * the people who follow me, MY FRIENDS, and my organisation co-members. The
 * last one is a DISCOVERY POOL and nothing more: it is never named in a
 * response, no field says which organisation anybody belongs to, and a person
 * cannot tell from this API whether they are reachable because of a follow,
 * because of a friendship or because of a shared licence.
 *
 * A PENDING REQUEST IS NOT IN THAT UNION, and that is the one line of this
 * paragraph worth reading twice. Only ACCEPTED friendships widen the set. If a
 * request opened the door on its own, "add friend" would be a read primitive:
 * anybody could open any profile by asking, and never coming back for the
 * answer would be the cheapest way to do it.
 *
 * The ORGANISATION DATA MODEL IS UNTOUCHED, because it still carries the
 * grants and the project visibility; it just stopped being the word this
 * surface uses.
 *
 * ── PRIVACY IS SUBTRACTION, NEVER A FLAG ────────────────────────────────────
 * Every switch is enforced by REMOVING the value from the response. Nothing
 * here ever ships a field plus a boolean asking the client not to draw it: a
 * client that honours it is one client, and the second one is a `curl`. A
 * hidden statistic is `null`, a hidden email is `null`, a hidden person is a
 * 404, and a hidden follower list is a 403. The person themself always sees
 * their own everything, which is why every check reads `isMe ||` first.
 *
 * ── THE NETWORK IS ONLY TOUCHED IN THE SINGULAR ─────────────────────────────
 * The list serves the cached GitHub copy and nothing else, even when it is old
 * or absent: N profiles would mean N requests per open, and the public quota
 * is 60 an hour. The fresh copy is fetched when ONE person is opened, which is
 * a human gesture and one at a time.
 */
import type { AppContext, RouteHandler } from "../types";
import { actingPersonId, canAdministerOrg, installationOrgId } from "../lib/orgs";
import { resolvePrincipals } from "../lib/principals";
import { profiloGitHub, profiloInCache, loginValido, type OpzioniGitHub } from "../lib/github-profile";
import type { ProfiloGitHub as GitHubProfile } from "../lib/github-profile";
import { statistichePersona } from "../lib/person-stats";
import {
  follow, unfollow, countFollows, segue, idFollower, idFollowing,
  privacyPersona, setPrivacy, type ProfilePrivacy,
} from "../lib/follows";
import {
  request, accept, decline, cancel, state, friends, relations,
  type FriendshipState, type FriendshipEdge, type FriendshipOutcome,
} from "../lib/friendships";

export interface DepsPeople {
  /** Iniettabile: nessun test deve poter uscire davvero su api.github.com. */
  github?: OpzioniGitHub;
}

interface RigaPersona {
  id: string;
  display_name: string;
  email: string | null;
  github_login: string | null;
  revoked_at: number | null;
}

/** A person as the address book and the single profile both render them. */
interface PersonCard {
  id: string;
  displayName: string;
  email: string | null;
  githubLogin: string | null;
  github: GitHubProfile | null;
  stats: ReturnType<typeof statistichePersona> | null;
  counts: { followers: number; following: number } | null;
  viewerFollows: boolean;
  followsViewer: boolean;
  lastSeenAt: number | null;
  isMe: boolean;
}

/** The target of a `/api/people/:id/...` route, once it is known to be visible. */
interface Target {
  row: RigaPersona;
  isMe: boolean;
  privacy: ProfilePrivacy;
}

export function createPeopleRouter(ctx: AppContext, deps: DepsPeople = {}): RouteHandler {
  const { json, readJSON, matchRoute, errorResponse } = ctx;
  const db = ctx.db as never as {
    query: (sql: string) => {
      get: (...a: unknown[]) => unknown;
      all: (...a: unknown[]) => unknown[];
      run: (...a: unknown[]) => unknown;
    };
  };

  const ioPersona = (req: Request): string | null =>
    actingPersonId(db as never, ctx.requestIdentity?.(req)?.deviceId ?? null);

  /**
   * Le organizzazioni di chi chiede. Dal LOOPBACK non c'è un dispositivo da cui
   * risolverle, e si ricade su quella dell'installazione: è la stessa rete
   * anti-lockout di sempre, davanti a questo Mac la rubrica si canSee.
   */
  function mieOrg(req: Request): string[] {
    const deviceId = ctx.requestIdentity?.(req)?.deviceId ?? null;
    if (deviceId) {
      const p = resolvePrincipals(db as never, deviceId);
      const orgs = p.list.filter((s) => s.kind === "org").map((s) => s.id);
      if (orgs.length) return orgs;
    }
    const inst = installationOrgId(db as never);
    return inst ? [inst] : [];
  }

  /** The ids of the live members of those organisations: the discovery pool. */
  function memberIds(orgIds: string[]): string[] {
    if (!orgIds.length) return [];
    const segnaposto = orgIds.map(() => "?").join(",");
    try {
      const rows = db.query(`
        SELECT DISTINCT p.id AS id
          FROM people p
          JOIN org_members om ON om.person_id = p.id
         WHERE om.org_id IN (${segnaposto})
           AND om.revoked_at IS NULL
           AND om.local_blocked_at IS NULL
           AND p.revoked_at IS NULL`).all(...orgIds) as Array<{ id: string }>;
      return rows.map((r) => r.id);
    } catch {
      return [];
    }
  }

  /**
   * THE REACHABLE SET: me, who I follow, who follows me, MY FRIENDS, my
   * co-members.
   *
   * The two follow directions are both in, and that is the point of an
   * asymmetric edge: somebody who follows me can see my profile without asking
   * me anything, and I can see theirs without following back. A set and not a
   * list because the five sources overlap constantly, and a co-member you also
   * follow must not appear twice in the address book.
   *
   * `amici` AND NOT THE WHOLE FRIENDSHIP TABLE. Only accepted friendships go
   * in. A pending request must not make a profile reachable, or "add friend"
   * becomes the cheapest read primitive in the API: anybody could open any
   * profile by asking, and never waiting for the answer. A refused one is out
   * for the same reason, and more obviously so.
   */
  function reachableIds(io: string | null, req: Request): Set<string> {
    const out = new Set<string>(memberIds(mieOrg(req)));
    if (io) {
      out.add(io);
      for (const id of idFollowing(db as never, io)) out.add(id);
      for (const id of idFollower(db as never, io)) out.add(id);
      for (const id of friends(db as never, io)) out.add(id);
    }
    return out;
  }

  const persona = (id: string): RigaPersona | null => {
    try {
      return (db.query("SELECT id, display_name, email, github_login, revoked_at FROM people WHERE id = ?")
        .get(id) as RigaPersona | undefined) ?? null;
    } catch { return null; }
  };

  /** Those ids, alive, in the order the address book is drawn. */
  function peopleRows(ids: string[]): RigaPersona[] {
    if (!ids.length) return [];
    const segnaposto = ids.map(() => "?").join(",");
    try {
      return db.query(`
        SELECT id, display_name, email, github_login, revoked_at
          FROM people
         WHERE id IN (${segnaposto}) AND revoked_at IS NULL
         ORDER BY display_name COLLATE NOCASE`).all(...ids) as RigaPersona[];
    } catch {
      return [];
    }
  }

  /**
   * The newest sign of life across this person's live devices, in
   * milliseconds. Same column and same shape as the organisation members route
   * (`server/routes/auth.ts`), deliberately: two places that answer "is this
   * person around" from two different columns are two answers that will
   * disagree, and the one that is wrong is the one nobody is looking at.
   *
   * The "online" threshold is not decided here. A server that shipped
   * `online: true` would freeze a time window the client could no longer
   * change, and two screens with two thresholds would tell two truths about
   * the same person.
   */
  function lastSeen(personId: string): number | null {
    try {
      const r = db.query(
        "SELECT MAX(last_seen_at) AS t FROM devices WHERE person_id = ? AND revoked_at IS NULL",
      ).get(personId) as { t: number | null } | undefined;
      return r?.t === null || r?.t === undefined ? null : Number(r.t);
    } catch {
      return null;
    }
  }

  /**
   * One person, with every field the viewer is allowed to see and no other.
   *
   * `canSee` reads `isMe` FIRST on every switch: a person always sees their own
   * profile whole, or the settings screen would be unable to show what it is
   * about to change.
   */
  function personCard(
    r: RigaPersona,
    io: string | null,
    github: GitHubProfile | null,
    privacy?: ProfilePrivacy,
  ): PersonCard {
    const isMe = io !== null && r.id === io;
    // The caller passes the switches it has already read: the address book
    // filters on them a line earlier, and reading them twice per row would
    // double the query count of the whole screen for nothing.
    const p = privacy ?? privacyPersona(db as never, r.id);
    const canSee = (isOn: boolean) => isMe || isOn;
    return {
      id: r.id,
      displayName: r.display_name,
      email: canSee(p.showEmail) ? r.email : null,
      githubLogin: r.github_login,
      github,
      stats: canSee(p.showStats) ? statistichePersona(db as never, r.id) : null,
      // The viewer goes in: the two list routes exempt the viewer's own row
      // from the visibility filter, so the counter has to exempt the same one
      // or the header contradicts the list under it.
      counts: canSee(p.showFollowers) ? countFollows(db as never, r.id, io) : null,
      // Nobody follows themself, so the two edges are false on your own row
      // rather than the result of a query that can only answer no.
      viewerFollows: io !== null && !isMe && segue(db as never, io, r.id),
      followsViewer: io !== null && !isMe && segue(db as never, r.id, io),
      lastSeenAt: canSee(p.showPresence) ? lastSeen(r.id) : null,
      isMe,
    };
  }

  /**
   * A person, as far as this viewer is concerned. `null` means 404, and it
   * means it for THREE different reasons on purpose: no such row, a revoked
   * person, or somebody who closed `showProfile`. Telling them apart in the
   * response would turn the third one into a way to confirm that a person
   * exists, which is exactly what closing the profile was meant to prevent.
   */
  function target(id: string, io: string | null): Target | null {
    const row = persona(id);
    if (!row || row.revoked_at !== null) return null;
    const isMe = io !== null && row.id === io;
    const privacy = privacyPersona(db as never, row.id);
    if (!isMe && !privacy.showProfile) return null;
    return { row, isMe, privacy };
  }

  /** One person from a follower list: no stats, no email, cached face only. */
  function listEntry(r: RigaPersona, io: string | null) {
    const isMe = io !== null && r.id === io;
    return {
      id: r.id,
      displayName: r.display_name,
      githubLogin: r.github_login,
      github: r.github_login ? profiloInCache(db as never, r.github_login) : null,
      viewerFollows: io !== null && !isMe && segue(db as never, io, r.id),
      isMe,
    };
  }

  /**
   * A set of ids, drawn the way the address book draws them.
   *
   * ONE serializer for every list that ships a whole person. `/api/people` and
   * `/api/friendships` return the same shape because they render the same
   * thing, and a leaner second shape would be a second contract to keep in
   * step with the first. The first is the one that gets updated.
   *
   * A person who closed their profile is absent, not greyed out, and the
   * viewer is exempt from that filter as everywhere else here.
   */
  function visibleCards(ids: string[], io: string | null): PersonCard[] {
    return peopleRows(ids)
      .map((r) => ({ r, privacy: privacyPersona(db as never, r.id) }))
      .filter(({ r, privacy }) => (io !== null && r.id === io) || privacy.showProfile)
      // Cache only: see the header. A face missing on the first open appears
      // once somebody opens that person, and from then on it is there for
      // everybody.
      .map(({ r, privacy }) =>
        personCard(r, io, r.github_login ? profiloInCache(db as never, r.github_login) : null, privacy));
  }

  /** Those people, each carrying the moment the relation reached its state. */
  function withSince(edges: FriendshipEdge[], io: string | null) {
    const sinceById = new Map(edges.map((e) => [e.personId, e.since]));
    return visibleCards([...sinceById.keys()], io)
      .map((c) => ({ ...c, since: sinceById.get(c.id) ?? 0 }));
  }

  /**
   * One shape for all four friendship gestures: the refusal the rule earned, or
   * the state that now holds.
   *
   * The state is re-read inside the library rather than assumed by the caller,
   * the same reason the follow route re-reads `segue`: a write that hit a
   * database without the table reports nothing, and answering with the state we
   * meant to write would leave the client drawing a relation that is not there.
   */
  const friendshipReply = (e: FriendshipOutcome): Response =>
    e.refused ? errorResponse(e.refused.status, e.refused.message) : json({ state: e.state });

  return async function peopleRouter(req, _url, pathname, method) {
    // `/api/friendships` is not under `/api/people` and is served here anyway:
    // it reads the same rows, the same switches and the same serializer, and a
    // router of its own would be a second copy of all three.
    if (!pathname.startsWith("/api/people") && pathname !== "/api/friendships") return null;
    const io = ioPersona(req);

    /** Computed at most once per request: it costs four queries. */
    let reachableMemo: Set<string> | null = null;
    const reachable = (): Set<string> =>
      (reachableMemo ??= reachableIds(io, req));

    // GET /api/people: the address book.
    if (method === "GET" && pathname === "/api/people") {
      return json({ people: visibleCards([...reachable()], io) });
    }

    // GET /api/friendships: my friends and the requests in both directions.
    if (pathname === "/api/friendships") {
      if (method !== "GET") return errorResponse(405, "method not allowed");
      if (io === null) return errorResponse(401, "unknown caller");
      // ONE read and three lists. Three calls would be three instants, and the
      // friends count would disagree with the requests under it for exactly as
      // long as somebody was looking at both.
      const every = relations(db as never, io);
      const bucket = (state: FriendshipState) => withSince(every.filter((e) => e.state === state), io);
      return json({
        friends: bucket("friends"),
        incoming: bucket("pending_in"),
        // `declined_out` is deliberately in NEITHER list. It is not waiting for
        // anybody, and putting it under "outgoing" would let the sender read
        // the refusal off a list the state was careful not to announce.
        outgoing: bucket("pending_out"),
      });
    }

    // THE SPECIFIC PATTERNS COME FIRST. `matchRoute` compares segment counts,
    // so `/api/people/:id` cannot actually swallow `/api/people/:id/follow`
    // today. The order is still this one because it does not depend on that:
    // the day the matcher learns prefixes, a catch-all placed first would eat
    // every route under it, silently and in production.

    // POST /api/people/:id/friend/accept | /friend/decline
    const pAccept = matchRoute(pathname, "/api/people/:id/friend/accept");
    const pDecline = matchRoute(pathname, "/api/people/:id/friend/decline");
    if (pAccept || pDecline) {
      if (method !== "POST") return errorResponse(405, "method not allowed");
      if (io === null) return errorResponse(401, "unknown caller");
      const id = (pAccept ?? pDecline)!.id;
      // ANSWERING IS NOT GATED ON `target`, the same trap the DELETE of a
      // follow documents further down. A person who asks and then closes their
      // profile would otherwise leave a request in somebody's inbox that
      // nobody could ever get rid of. It opens no probe either: a request that
      // does not exist answers 409 whoever the id belongs to, including an id
      // that never existed.
      return friendshipReply(pAccept
        ? accept(db as never, io, id)
        : decline(db as never, io, id));
    }

    // POST | DELETE /api/people/:id/friend
    const pFriend = matchRoute(pathname, "/api/people/:id/friend");
    if (pFriend) {
      if (method !== "POST" && method !== "DELETE") return errorResponse(405, "method not allowed");
      if (io === null) return errorResponse(401, "unknown caller");

      // Withdrawing my request or ending a friendship: ungated for the same
      // reason as the answer above. Leaving a relation must never depend on
      // still being able to see the other end of it.
      if (method === "DELETE") return friendshipReply(cancel(db as never, io, pFriend.id));

      // The POST is NOT gated on the reachable set, exactly like the follow
      // POST and for the same reason: asking is how somebody ENTERS it, and
      // requiring membership first would mean the graph could only grow among
      // people who already share a licence. `target` still applies, so a person
      // who closed their profile can neither be asked nor probed for existence.
      const b = target(pFriend.id, io);
      if (!b) return errorResponse(404, "Person not found");
      // Self-friendship is refused by the library and not by a check here, so
      // the rule and its message live in one place. The follow route checks it
      // inline; that is the older shape, and duplicating it was the point of
      // moving the reason next to the rule.
      return friendshipReply(request(db as never, io, b.row.id));
    }

    // POST | DELETE /api/people/:id/follow
    const pFollow = matchRoute(pathname, "/api/people/:id/follow");
    if (pFollow) {
      if (method !== "POST" && method !== "DELETE") return errorResponse(405, "method not allowed");
      if (io === null) return errorResponse(401, "unknown caller");
      // Refused before the target is even resolved: following yourself is not
      // a permission question, it is a shape that means nothing.
      if (pFollow.id === io) return errorResponse(400, "cannot follow yourself");

      /** What the caller learns about the target once the write is done. */
      const outcome = (): Response => {
        const b = target(pFollow.id, io);
        return json({
          // Re-read instead of assumed: an INSERT OR IGNORE that hit a
          // database without the table reports nothing, and answering `true`
          // there would leave the client drawing an edge that does not exist.
          following: segue(db as never, io, pFollow.id),
          // Null when this person hides their followers, like everywhere else.
          // The counter is the same datum the two list routes protect, and
          // handing it out here would make the privacy switch decorative.
          counts: b && (b.isMe || b.privacy.showFollowers)
            ? countFollows(db as never, pFollow.id, io)
            : null,
        });
      };

      // CUTTING AN EDGE YOU MADE IS NOT GATED ON SEEING THE OTHER END.
      //
      // It used to run through `target` like the POST does, and that made a
      // follow PERMANENT the moment the target closed their profile or was
      // revoked: DELETE answered 404, the row stayed, and no other path in the
      // API could remove it. That is not a stricter rule, it is a trap, and it
      // shuts on the wrong person: the edge is what puts the FOLLOWER inside
      // the followed person's reachable set, so the one who wanted out of the
      // relationship is the one who could not leave it.
      //
      // It opens no probe either. The answer is the same for an id that never
      // existed, one that is hidden and one that is revoked: `following` is
      // false in all three, and `counts` stays null unless the target is
      // visible AND publishes them.
      if (method === "DELETE") {
        unfollow(db as never, io, pFollow.id);
        return outcome();
      }

      // The POST is NOT gated on the reachable set, and that is the whole
      // point: a follow is how somebody ENTERS it. Requiring membership first
      // would mean the graph could only ever grow among people who already
      // share a licence, which is the limitation this route exists to remove.
      // `target` still applies, so a person who closed their profile cannot
      // be followed and cannot be probed for existence either.
      const b = target(pFollow.id, io);
      if (!b) return errorResponse(404, "Person not found");
      follow(db as never, io, b.row.id);
      return outcome();
    }

    // GET /api/people/:id/followers | /following
    const pFollowers = matchRoute(pathname, "/api/people/:id/followers");
    const pFollowing = matchRoute(pathname, "/api/people/:id/following");
    if (pFollowers || pFollowing) {
      if (method !== "GET") return errorResponse(405, "method not allowed");
      const id = (pFollowers ?? pFollowing)!.id;
      const b = target(id, io);
      // The same gate as opening the profile: a list you can read about a
      // person you cannot open would be a way around the profile itself.
      if (!b || !reachable().has(id)) return errorResponse(404, "Person not found");
      if (!b.isMe && !b.privacy.showFollowers) return errorResponse(403, "followers are private");

      const ids = pFollowers ? idFollower(db as never, id) : idFollowing(db as never, id);
      const people = peopleRows(ids)
        // A person who closed their profile is absent from every list, not
        // greyed out in it: an entry saying "hidden" still confirms they exist.
        .filter((r) => (io !== null && r.id === io) || privacyPersona(db as never, r.id).showProfile)
        .map((r) => listEntry(r, io));
      return json({ people });
    }

    // GET | PATCH /api/people/:id/privacy
    const pPrivacy = matchRoute(pathname, "/api/people/:id/privacy");
    if (pPrivacy) {
      if (method !== "GET" && method !== "PATCH") return errorResponse(405, "method not allowed");
      if (io === null) return errorResponse(401, "unknown caller");
      // SELF ONLY, both verbs. Reading somebody's switches tells you what they
      // are hiding, which is most of what they were hiding: this is not a
      // weaker permission than writing them, so it is not a weaker check. The
      // answer is the same whether or not that id exists, so a 403 here does
      // not confirm anything either.
      if (pPrivacy.id !== io) return errorResponse(403, "privacy is only visible to its owner");

      if (method === "GET") return json({ privacy: privacyPersona(db as never, io) });

      const body = await readJSON(req);
      if (!body) return errorResponse(400, "body required");
      // The body goes in whole and `setPrivacy` does the sifting: it keeps
      // the five keys it knows and only when they carry a real boolean, so an
      // unknown key and the string "false" are both dropped there. Filtering
      // here as well would be a SECOND copy of that rule, and the second copy
      // is the one that forgets a field the day a sixth switch is added.
      return json({ privacy: setPrivacy(db as never, io, body as Partial<ProfilePrivacy>) });
    }

    const params = matchRoute(pathname, "/api/people/:id");
    if (!params) return null;
    const b = target(params.id, io);
    // Outside the address book it does not exist, for every verb: the same
    // shape as the filter on projects, and for the same reason.
    if (!b || !reachable().has(params.id)) return errorResponse(404, "Person not found");
    const chi = b.row;

    if (method === "GET") {
      const github = chi.github_login
        ? await profiloGitHub(db as never, chi.github_login, deps.github ?? {})
        : null;
      return json({
        ...personCard(chi, io, github, b.privacy),
        // Here and not on the address-book card: a profile screen has to draw
        // the right button, and asking for it separately would mean a second
        // round trip for a field the first one already knows. Always present
        // and never `null`, because a missing field would be a sixth value on
        // top of the five and every client would have to decide what it meant.
        friendship: state(db as never, io ?? "", chi.id),
        // Only to the person themself, and only here: the settings screen has
        // to know the current state of what it is about to change, and nobody
        // else has any use for it.
        ...(b.isMe ? { privacy: b.privacy } : {}),
      });
    }

    if (method === "PATCH") {
      const body = await readJSON(req);
      if (!body) return errorResponse(400, "body required");
      if (body.githubLogin === undefined) return errorResponse(400, "githubLogin required");

      // CHI PUÒ. Il proprio login lo mette la persona stessa; quello di un altro
      // solo chi amministra l'organizzazione. Nel mezzo non c'è niente:
      // «chiunque nella stessa org» significherebbe che un collega può
      // intestarti l'identità pubblica che vuole.
      const org = installationOrgId(db as never);
      const puo = (io !== null && io === chi.id) || (org !== null && canAdministerOrg(db as never, org, io));
      if (!puo) return errorResponse(403, "not allowed to set this person's GitHub login");

      let login: string | null;
      if (body.githubLogin === null) login = null;
      else {
        if (!loginValido(body.githubLogin)) return errorResponse(400, "invalid GitHub login");
        login = body.githubLogin as string;
      }
      try {
        db.query("UPDATE people SET github_login = ?, rev = rev + 1, updated_at = ? WHERE id = ?")
          .run(login, Date.now(), chi.id);
      } catch {
        // L'indice UNIQUE: quel login è già di un'altra persona qui dentro.
        return errorResponse(409, "that GitHub login already belongs to another person");
      }
      const github = login ? await profiloGitHub(db as never, login, deps.github ?? {}) : null;
      return json({ id: chi.id, githubLogin: login, github });
    }

    return errorResponse(405, "method not allowed");
  };
}
