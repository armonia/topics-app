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
 *
 * ── THE BOUNDARY IS NO LONGER THE ORGANISATION ──────────────────────────────
 * It used to be, and the reason was sound: `people` grows a row for every
 * person this machine has ever met, so serving it whole would turn a profile
 * screen into an address book nobody asked to publish. What was wrong was the
 * other half: making the organisation the ONLY way in means the only people
 * you can see are the people you are billed with, and an organisation is a
 * licence, not a friendship.
 *
 * So the reachable set is now a UNION of four things: me, the people I follow,
 * the people who follow me, and my organisation co-members. The last one is a
 * DISCOVERY POOL and nothing more: it is never named in a response, no field
 * says which organisation anybody belongs to, and a person cannot tell from
 * this API whether they are reachable because of a follow or because of a
 * shared licence. The organisation data model is untouched, because it still
 * carries the grants and the project visibility; it just stopped being the
 * word this surface uses.
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
import { profiloGitHub, profiloInCache, loginValido, type ProfiloGitHub, type OpzioniGitHub } from "../lib/github-profile";
import { statistichePersona } from "../lib/person-stats";
import {
  follow, unfollow, conteggiFollow, segue, idFollower, idSeguiti,
  privacyPersona, impostaPrivacy, type ProfilePrivacy,
} from "../lib/follows";

export interface DipendenzePeople {
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
interface SchedaPersona {
  id: string;
  displayName: string;
  email: string | null;
  githubLogin: string | null;
  github: ProfiloGitHub | null;
  stats: ReturnType<typeof statistichePersona> | null;
  counts: { followers: number; following: number } | null;
  viewerFollows: boolean;
  followsViewer: boolean;
  lastSeenAt: number | null;
  isMe: boolean;
}

/** The target of a `/api/people/:id/...` route, once it is known to be visible. */
interface Bersaglio {
  riga: RigaPersona;
  isMe: boolean;
  privacy: ProfilePrivacy;
}

export function createPeopleRouter(ctx: AppContext, deps: DipendenzePeople = {}): RouteHandler {
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
   * anti-lockout di sempre, davanti a questo Mac la rubrica si vede.
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
  function idMembriOrg(orgIds: string[]): string[] {
    if (!orgIds.length) return [];
    const segnaposto = orgIds.map(() => "?").join(",");
    try {
      const righe = db.query(`
        SELECT DISTINCT p.id AS id
          FROM people p
          JOIN org_members om ON om.person_id = p.id
         WHERE om.org_id IN (${segnaposto})
           AND om.revoked_at IS NULL
           AND om.local_blocked_at IS NULL
           AND p.revoked_at IS NULL`).all(...orgIds) as Array<{ id: string }>;
      return righe.map((r) => r.id);
    } catch {
      return [];
    }
  }

  /**
   * THE REACHABLE SET: me, who I follow, who follows me, my co-members.
   *
   * The two follow directions are both in, and that is the point of an
   * asymmetric edge: somebody who follows me can see my profile without asking
   * me anything, and I can see theirs without following back. A set and not a
   * list because the four sources overlap constantly, and a co-member you also
   * follow must not appear twice in the address book.
   */
  function idsRaggiungibili(io: string | null, req: Request): Set<string> {
    const out = new Set<string>(idMembriOrg(mieOrg(req)));
    if (io) {
      out.add(io);
      for (const id of idSeguiti(db as never, io)) out.add(id);
      for (const id of idFollower(db as never, io)) out.add(id);
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
  function persone(ids: string[]): RigaPersona[] {
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
  function ultimoAccesso(personId: string): number | null {
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
   * `vede` reads `isMe` FIRST on every switch: a person always sees their own
   * profile whole, or the settings screen would be unable to show what it is
   * about to change.
   */
  function scheda(
    r: RigaPersona,
    io: string | null,
    github: ProfiloGitHub | null,
    privacy?: ProfilePrivacy,
  ): SchedaPersona {
    const isMe = io !== null && r.id === io;
    // The caller passes the switches it has already read: the address book
    // filters on them a line earlier, and reading them twice per row would
    // double the query count of the whole screen for nothing.
    const p = privacy ?? privacyPersona(db as never, r.id);
    const vede = (acceso: boolean) => isMe || acceso;
    return {
      id: r.id,
      displayName: r.display_name,
      email: vede(p.showEmail) ? r.email : null,
      githubLogin: r.github_login,
      github,
      stats: vede(p.showStats) ? statistichePersona(db as never, r.id) : null,
      // The viewer goes in: the two list routes exempt the viewer's own row
      // from the visibility filter, so the counter has to exempt the same one
      // or the header contradicts the list under it.
      counts: vede(p.showFollowers) ? conteggiFollow(db as never, r.id, io) : null,
      // Nobody follows themself, so the two edges are false on your own row
      // rather than the result of a query that can only answer no.
      viewerFollows: io !== null && !isMe && segue(db as never, io, r.id),
      followsViewer: io !== null && !isMe && segue(db as never, r.id, io),
      lastSeenAt: vede(p.showPresence) ? ultimoAccesso(r.id) : null,
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
  function bersaglio(id: string, io: string | null): Bersaglio | null {
    const riga = persona(id);
    if (!riga || riga.revoked_at !== null) return null;
    const isMe = io !== null && riga.id === io;
    const privacy = privacyPersona(db as never, riga.id);
    if (!isMe && !privacy.showProfile) return null;
    return { riga, isMe, privacy };
  }

  /** One person from a follower list: no stats, no email, cached face only. */
  function voceElenco(r: RigaPersona, io: string | null) {
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

  return async function peopleRouter(req, _url, pathname, method) {
    if (!pathname.startsWith("/api/people")) return null;
    const io = ioPersona(req);

    /** Computed at most once per request: it costs three queries. */
    let memoRaggiungibili: Set<string> | null = null;
    const raggiungibili = (): Set<string> =>
      (memoRaggiungibili ??= idsRaggiungibili(io, req));

    // GET /api/people: the address book.
    if (method === "GET" && pathname === "/api/people") {
      const people = persone([...raggiungibili()])
        .map((r) => ({ r, privacy: privacyPersona(db as never, r.id) }))
        .filter(({ r, privacy }) => (io !== null && r.id === io) || privacy.showProfile)
        .map(({ r, privacy }) =>
          // Cache only: see the header. A face missing on the first open
          // appears once somebody opens that person, and from then on it is
          // there for everybody.
          scheda(r, io, r.github_login ? profiloInCache(db as never, r.github_login) : null, privacy));
      return json({ people });
    }

    // THE SPECIFIC PATTERNS COME FIRST. `matchRoute` compares segment counts,
    // so `/api/people/:id` cannot actually swallow `/api/people/:id/follow`
    // today. The order is still this one because it does not depend on that:
    // the day the matcher learns prefixes, a catch-all placed first would eat
    // every route under it, silently and in production.

    // POST | DELETE /api/people/:id/follow
    const pFollow = matchRoute(pathname, "/api/people/:id/follow");
    if (pFollow) {
      if (method !== "POST" && method !== "DELETE") return errorResponse(405, "method not allowed");
      if (io === null) return errorResponse(401, "unknown caller");
      // Refused before the target is even resolved: following yourself is not
      // a permission question, it is a shape that means nothing.
      if (pFollow.id === io) return errorResponse(400, "cannot follow yourself");

      /** What the caller learns about the target once the write is done. */
      const esito = (): Response => {
        const b = bersaglio(pFollow.id, io);
        return json({
          // Re-read instead of assumed: an INSERT OR IGNORE that hit a
          // database without the table reports nothing, and answering `true`
          // there would leave the client drawing an edge that does not exist.
          following: segue(db as never, io, pFollow.id),
          // Null when this person hides their followers, like everywhere else.
          // The counter is the same datum the two list routes protect, and
          // handing it out here would make the privacy switch decorative.
          counts: b && (b.isMe || b.privacy.showFollowers)
            ? conteggiFollow(db as never, pFollow.id, io)
            : null,
        });
      };

      // CUTTING AN EDGE YOU MADE IS NOT GATED ON SEEING THE OTHER END.
      //
      // It used to run through `bersaglio` like the POST does, and that made a
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
        return esito();
      }

      // The POST is NOT gated on the reachable set, and that is the whole
      // point: a follow is how somebody ENTERS it. Requiring membership first
      // would mean the graph could only ever grow among people who already
      // share a licence, which is the limitation this route exists to remove.
      // `bersaglio` still applies, so a person who closed their profile cannot
      // be followed and cannot be probed for existence either.
      const b = bersaglio(pFollow.id, io);
      if (!b) return errorResponse(404, "Person not found");
      follow(db as never, io, b.riga.id);
      return esito();
    }

    // GET /api/people/:id/followers | /following
    const pFollowers = matchRoute(pathname, "/api/people/:id/followers");
    const pFollowing = matchRoute(pathname, "/api/people/:id/following");
    if (pFollowers || pFollowing) {
      if (method !== "GET") return errorResponse(405, "method not allowed");
      const id = (pFollowers ?? pFollowing)!.id;
      const b = bersaglio(id, io);
      // The same gate as opening the profile: a list you can read about a
      // person you cannot open would be a way around the profile itself.
      if (!b || !raggiungibili().has(id)) return errorResponse(404, "Person not found");
      if (!b.isMe && !b.privacy.showFollowers) return errorResponse(403, "followers are private");

      const ids = pFollowers ? idFollower(db as never, id) : idSeguiti(db as never, id);
      const people = persone(ids)
        // A person who closed their profile is absent from every list, not
        // greyed out in it: an entry saying "hidden" still confirms they exist.
        .filter((r) => (io !== null && r.id === io) || privacyPersona(db as never, r.id).showProfile)
        .map((r) => voceElenco(r, io));
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
      // The body goes in whole and `impostaPrivacy` does the sifting: it keeps
      // the five keys it knows and only when they carry a real boolean, so an
      // unknown key and the string "false" are both dropped there. Filtering
      // here as well would be a SECOND copy of that rule, and the second copy
      // is the one that forgets a field the day a sixth switch is added.
      return json({ privacy: impostaPrivacy(db as never, io, body as Partial<ProfilePrivacy>) });
    }

    const params = matchRoute(pathname, "/api/people/:id");
    if (!params) return null;
    const b = bersaglio(params.id, io);
    // Outside the address book it does not exist, for every verb: the same
    // shape as the filter on projects, and for the same reason.
    if (!b || !raggiungibili().has(params.id)) return errorResponse(404, "Person not found");
    const chi = b.riga;

    if (method === "GET") {
      const github = chi.github_login
        ? await profiloGitHub(db as never, chi.github_login, deps.github ?? {})
        : null;
      return json({
        ...scheda(chi, io, github, b.privacy),
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
