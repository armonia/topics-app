/**
 * I PROFILI DEGLI AMICI: la rubrica, la faccia da GitHub, i prompt e i token.
 *
 * Tre cose che si rompono in silenzio e che qui si guardano:
 *
 *  · IL CONFINE. La rubrica sono le persone delle MIE organizzazioni, non
 *    `people` intera — che è la tabella di chiunque questa macchina abbia mai
 *    incontrato.
 *  · LA QUOTA. `GET /api/people` NON deve toccare la rete, mai: sono 60
 *    richieste all'ora e otto amici le finiscono in due aperture. La prova è
 *    che il `fetch` iniettato resta a zero chiamate.
 *  · L'ATTRIBUZIONE. I token non stanno sulla riga di chi scrive: stanno sulla
 *    RISPOSTA appesa al suo prompt. Un conteggio che li cerca sul messaggio
 *    utente restituisce zero per tutti e sembra funzionare.
 *
 * @covers PROFILE-03, PROFILE-04
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPeopleRouter } from "../../server/routes/people";
import { createAuthRouter } from "../../server/routes/auth";
import type { RouteHandler } from "../../server/types";

const RADICE = join(import.meta.dir, "..", "..");
const MIGRAZIONI = [
  "001-initial.sql", "005-message-branching.sql", "014-message-meta.sql", "015-message-blocks.sql",
  "016-projects.sql",
  "070-message-cache-tokens.sql", "076-message-model.sql",
  "080-devices.sql", "082-task-shares.sql", "083-grants.sql", "084-people-orgs.sql",
  // In ordine di NUMERO, come le applica il runner: la 094 non dipende dalla
  // 095 (aggiunge una colonna a `people` e una tabella nuova), ma un elenco che
  // le mette in un ordine diverso da quello vero prova qualcosa che in
  // produzione non succede mai.
  "092-project-org-incognito.sql", "094-github-profiles.sql", "095-message-author.sql",
  // The follow graph and the five privacy switches. It needs the 084
  // (`people`), the 094 (`github_profiles`, which it adds two columns to) and
  // the 080 (`devices`, where the last access is read from).
  "20260821162529-follows-and-profile-privacy.sql",
];

function dbVero(): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)");
  for (const m of MIGRAZIONI) {
    db.run(readFileSync(join(RADICE, "server", "db", "migrations", m), "utf8"));
  }
  return db;
}

function bootstrap(db: Database) {
  const org = db.query("SELECT org_id FROM installation WHERE singleton = 1").get() as { org_id: string };
  const io = db.query("SELECT person_id FROM installation_owners WHERE is_default = 1").get() as
    { person_id: string };
  return { orgId: org.org_id, ioPersonId: io.person_id };
}

function collega(db: Database, id: string, orgId: string | null) {
  db.run("INSERT INTO people (id, display_name, created_at, updated_at) VALUES (?, ?, 0, 0)", [id, id]);
  if (orgId) {
    db.run(
      "INSERT INTO org_members (org_id, person_id, role, joined_at, updated_at) VALUES (?, ?, 'member', 0, 0)",
      [orgId, id],
    );
  }
  const dev = `dev-${id}`;
  db.run(
    `INSERT INTO devices (id, name, token_hash, created_at, last_seen_at, role, person_id)
     VALUES (?, ?, ?, 0, 0, 'owner', ?)`,
    [dev, `Mac di ${id}`, `hash-${id}`, id],
  );
  return dev;
}

/** Un turno vero: il prompt di qualcuno e la risposta appesa a QUEL prompt. */
let seq = 0;
function turno(db: Database, personId: string | null, input: number, output: number) {
  const u = `u${++seq}`, a = `a${seq}`;
  db.run(
    `INSERT INTO messages (id, session_key, role, content, timestamp, sort_order, author_person_id)
     VALUES (?, 's1', 'user', 'domanda', '2026-08-01T10:00:00.000Z', ?, ?)`,
    [u, seq * 2, personId],
  );
  db.run(
    `INSERT INTO messages (id, session_key, role, content, timestamp, sort_order, parent_id,
                           usage_prompt_tokens, usage_completion_tokens, cost_cents)
     VALUES (?, 's1', 'assistant', 'risposta', '2026-08-01T10:00:01.000Z', ?, ?, ?, ?, 7)`,
    [a, seq * 2 + 1, u, input, output],
  );
}

const RISPOSTA_GITHUB = {
  login: "octocat", name: "Mona Octocat", avatar_url: "https://avatars.example/octocat.png",
  html_url: "https://github.com/octocat", bio: "CTO", company: "Armonia", location: "Salerno",
  // The two fields GitHub prints UNDER the bio. `blog` arrives with no scheme
  // on purpose: over there it is free text, and the cache keeps it verbatim
  // instead of guessing.
  blog: "armonia.example", twitter_username: "octocat",
  public_repos: 42, followers: 7,
};

function creaCtx(db: Database, deviceId: string | null, fetchImpl: typeof fetch): never {
  return {
    db,
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    readJSON: async (req: Request) => { try { return await req.json(); } catch { return null; } },
    errorResponse: (status: number, message: string) =>
      new Response(JSON.stringify({ error: message }), { status, headers: { "content-type": "application/json" } }),
    matchRoute: (pathname: string, pattern: string) => {
      const p = pattern.split("/"), a = pathname.split("/");
      if (p.length !== a.length) return null;
      const out: Record<string, string> = {};
      for (let i = 0; i < p.length; i++) {
        if (p[i]!.startsWith(":")) out[p[i]!.slice(1)] = decodeURIComponent(a[i]!);
        else if (p[i] !== a[i]) return null;
      }
      return out;
    },
    broadcastToAll: () => {},
    requestIdentity: () => (deviceId ? { role: "owner", deviceId } : null),
    __fetch: fetchImpl,
  } as never;
}

function router(db: Database, deviceId: string | null, fetchImpl: typeof fetch): RouteHandler {
  return createPeopleRouter(creaCtx(db, deviceId, fetchImpl), {
    github: { fetch: fetchImpl, now: () => 1_000_000 },
  });
}

/**
 * The minimum `createAuthRouter` needs, for the members route alone.
 *
 * It lives HERE and not in a file of its own because what it exercises is the
 * same switch as the tests next to it: `show_presence` has to blank the last
 * access on EVERY route that reads `devices.last_seen_at`, not only on the
 * profile one. A test that watches one of the two is the reason the other
 * drifts.
 */
function ctxAuth(db: Database): never {
  return {
    db,
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    readJSON: async (req: Request) => { try { return await req.json() as unknown; } catch { return null; } },
    broadcast: () => {},
    requestIdentity: () => null,
    requestIp: () => null,
    relayConfig: () => ({ baseUrl: null, installationId: "installazione-di-prova" }),
  } as never;
}

function chiama(r: RouteHandler, path: string, method = "GET", body?: unknown) {
  const url = new URL(`http://127.0.0.1:3333${path}`);
  const req = new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return r(req, url, url.pathname, method) as Promise<Response | null>;
}

describe("i profili degli amici", () => {
  let db: Database;
  let orgId: string;
  let ioPersonId: string;
  let chiamate: number;
  let finto: typeof fetch;

  beforeEach(() => {
    seq = 0;
    db = dbVero();
    ({ orgId, ioPersonId } = bootstrap(db));
    collega(db, "mircea", orgId);
    collega(db, "estraneo", null); // in `people` ma in nessuna org mia
    chiamate = 0;
    finto = (async (u: string | URL | Request) => {
      chiamate++;
      const url = String(u);
      if (url.endsWith("/users/octocat")) {
        return new Response(JSON.stringify(RISPOSTA_GITHUB), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as never;
  });

  test("la rubrica è la mia organizzazione, non `people` intera", async () => {
    const r = await chiama(router(db, null, finto), "/api/people");
    const { people } = (await r!.json()) as { people: Array<{ id: string }> };
    const ids = people.map((p) => p.id).sort();
    expect(ids).toContain(ioPersonId);
    expect(ids).toContain("mircea");
    expect(ids).not.toContain("estraneo");
  });

  test("la lista NON tocca la rete, nemmeno con un login agganciato", async () => {
    db.run("UPDATE people SET github_login = 'octocat' WHERE id = ?", [ioPersonId]);
    const r = await chiama(router(db, null, finto), "/api/people");
    const { people } = (await r!.json()) as { people: Array<{ id: string; github: unknown }> };
    expect(chiamate).toBe(0);
    // Niente cache ancora ⇒ nessuna faccia, e va bene così.
    expect(people.find((p) => p.id === ioPersonId)!.github).toBeNull();
  });

  test("aprire UNA persona scarica il profilo, e la seconda volta lo prende dalla cache", async () => {
    db.run("UPDATE people SET github_login = 'octocat' WHERE id = ?", [ioPersonId]);
    const r1 = await chiama(router(db, null, finto), `/api/people/${ioPersonId}`);
    const p1 = (await r1!.json()) as {
      github: { name: string; avatarUrl: string; followers: number; blog: string; twitterUsername: string };
    };
    expect(chiamate).toBe(1);
    expect(p1.github.name).toBe("Mona Octocat");
    expect(p1.github.avatarUrl).toBe(RISPOSTA_GITHUB.avatar_url);
    expect(p1.github.followers).toBe(7);
    // The link and the handle: with nothing cached the header would carry a
    // hole that no amount of client work could fill, because the value was
    // never asked for.
    expect(p1.github.blog).toBe("armonia.example");
    expect(p1.github.twitterUsername).toBe("octocat");

    await chiama(router(db, null, finto), `/api/people/${ioPersonId}`);
    expect(chiamate).toBe(1); // la cache ha tenuto

    // E ora la lista ce l'ha, senza uscire.
    const rl = await chiama(router(db, null, finto), "/api/people");
    const { people } = (await rl!.json()) as {
      people: Array<{ id: string; github: { name: string; blog: string; twitterUsername: string } | null }>;
    };
    const cache = people.find((p) => p.id === ioPersonId)!.github!;
    expect(cache.name).toBe("Mona Octocat");
    // From the row written to the database too, not only from GitHub's reply.
    expect(cache.blog).toBe("armonia.example");
    expect(cache.twitterUsername).toBe("octocat");
    expect(chiamate).toBe(1);
  });

  test("un login che non esiste non fa cadere niente e non si richiede a raffica", async () => {
    db.run("UPDATE people SET github_login = 'chi-non-esiste' WHERE id = 'mircea'");
    const r = await chiama(router(db, null, finto), "/api/people/mircea");
    expect(r!.status).toBe(200);
    expect(((await r!.json()) as { github: unknown }).github).toBeNull();
    expect(chiamate).toBe(1);
    await chiama(router(db, null, finto), "/api/people/mircea");
    expect(chiamate).toBe(1); // anche il fallimento si ricorda
  });

  test("prompt e token: i suoi, non quelli di tutti — e i token stanno sulla risposta", async () => {
    turno(db, ioPersonId, 1000, 200);
    turno(db, ioPersonId, 500, 100);
    turno(db, "mircea", 30, 4);
    turno(db, null, 999_999, 999_999); // senza autore: di nessuno

    const r = await chiama(router(db, null, finto), "/api/people");
    const { people } = (await r!.json()) as {
      people: Array<{ id: string; stats: { prompts: number; inputTokens: number; outputTokens: number; costCents: number } }>;
    };
    const io = people.find((p) => p.id === ioPersonId)!.stats;
    expect(io.prompts).toBe(2);
    expect(io.inputTokens).toBe(1500);
    expect(io.outputTokens).toBe(300);
    expect(io.costCents).toBe(14);

    const m = people.find((p) => p.id === "mircea")!.stats;
    expect(m.prompts).toBe(1);
    expect(m.inputTokens).toBe(30);
  });

  test("il proprio login si aggancia; quello di un altro solo da chi amministra", async () => {
    const devMircea = "dev-mircea";
    // Mircea aggancia il PROPRIO: si può.
    const suo = router(db, devMircea, finto);
    const ok = await chiama(suo, "/api/people/mircea", "PATCH", { githubLogin: "octocat" });
    expect(ok!.status).toBe(200);
    expect((db.query("SELECT github_login AS g FROM people WHERE id = 'mircea'").get() as { g: string }).g)
      .toBe("octocat");

    // Quello di un ALTRO: no, Mircea è solo `member`.
    const no = await chiama(suo, `/api/people/${ioPersonId}`, "PATCH", { githubLogin: "altrologin" });
    expect(no!.status).toBe(403);
  });

  test("un login già di un'altra persona viene rifiutato invece di rubarlo", async () => {
    db.run("UPDATE people SET github_login = 'octocat' WHERE id = ?", [ioPersonId]);
    const r = await chiama(router(db, "dev-mircea", finto), "/api/people/mircea", "PATCH", {
      githubLogin: "octocat",
    });
    expect(r!.status).toBe(409);
  });

  test("una persona fuori dalla mia organizzazione non si apre", async () => {
    const r = await chiama(router(db, null, finto), "/api/people/estraneo");
    expect(r!.status).toBe(404);
  });

  test("un login malformato non arriva né al database né alla rete", async () => {
    const r = await chiama(router(db, "dev-mircea", finto), "/api/people/mircea", "PATCH", {
      githubLogin: "non è un login/valido",
    });
    expect(r!.status).toBe(400);
    expect(chiamate).toBe(0);
  });
});

/**
 * ── FOLLOWS AND PROFILE PRIVACY ─────────────────────────────────────────────
 *
 * Four things that break in silence, and they are not the ones above:
 *
 *  · THE EDGE IS ASYMMETRIC. A symmetric implementation passes every counter
 *    assertion: the numbers still add up, they just add up on both rows too.
 *    So the opposite direction is checked every time, not only the written one.
 *  · THE BOUNDARY REALLY WIDENS. Somebody who shares no organisation has to
 *    become reachable through a follow and nothing else, or the graph can only
 *    ever grow among people who were already together.
 *  · PRIVACY IS SUBTRACTION. Every switch is checked by reading the FIELD in
 *    the response, never a boolean next to it: a test that settles for the flag
 *    passes even while the value travels, which is exactly the failure.
 *  · IT HOLDS ON EVERY ROUTE THAT SERVES THE SAME FACT. `show_presence` has to
 *    blank the last access on the members list too, which reads the very same
 *    column: a switch that holds on one route only is a hint.
 */
describe("i follow e la privacy del profilo", () => {
  let db: Database;
  let orgId: string;
  let ioPersonId: string;
  let finto: typeof fetch;

  beforeEach(() => {
    seq = 0;
    db = dbVero();
    ({ orgId, ioPersonId } = bootstrap(db));
    collega(db, "mircea", orgId);
    collega(db, "estraneo", null); // in `people`, in none of my organisations
    // None of these tests touches GitHub: going to the network here is a bug.
    finto = (async () => new Response("not found", { status: 404 })) as never;
  });

  /** The loopback: whoever has their hands on this Mac, that is the owner. */
  const io = () => router(db, null, finto);
  /** The same route as seen by somebody else. */
  const come = (id: string) => router(db, `dev-${id}`, finto);

  const jsonOf = async <T>(r: Response | null): Promise<T> => (await r!.json()) as T;
  const idsRubrica = async (r: RouteHandler): Promise<string[]> =>
    (await jsonOf<{ people: Array<{ id: string }> }>(await chiama(r, "/api/people"))).people.map((p) => p.id);

  type Counts = { followers: number; following: number } | null;
  type FollowResponse = { following: boolean; counts: Counts };

  test("seguire e' asimmetrico: l'altro verso resta vuoto", async () => {
    const r = await chiama(io(), "/api/people/mircea/follow", "POST");
    expect(r!.status).toBe(200);
    expect(await jsonOf<FollowResponse>(r)).toEqual({
      following: true,
      counts: { followers: 1, following: 0 },
    });

    // From Mircea's side: he does NOT follow me, I follow him. Two different
    // fields, and a symmetric implementation would have both of them true.
    const visto = await jsonOf<{ viewerFollows: boolean; followsViewer: boolean }>(
      await chiama(come("mircea"), `/api/people/${ioPersonId}`),
    );
    expect(visto.viewerFollows).toBe(false);
    expect(visto.followsViewer).toBe(true);
  });

  test("seguire due volte e' seguire una volta: il contatore non sale", async () => {
    await chiama(io(), "/api/people/mircea/follow", "POST");
    const second = await jsonOf<FollowResponse>(await chiama(io(), "/api/people/mircea/follow", "POST"));
    expect(second.following).toBe(true);
    expect(second.counts).toEqual({ followers: 1, following: 0 });

    const after = await jsonOf<FollowResponse>(await chiama(io(), "/api/people/mircea/follow", "DELETE"));
    expect(after).toEqual({ following: false, counts: { followers: 0, following: 0 } });
  });

  test("seguire se stessi e' rifiutato con 400, non con un no-op silenzioso", async () => {
    const r = await chiama(io(), `/api/people/${ioPersonId}/follow`, "POST");
    expect(r!.status).toBe(400);
    expect((await jsonOf<{ error: string }>(r)).error).toContain("yourself");
  });

  test("una persona senza nessuna org in comune diventa raggiungibile con un follow", async () => {
    // Before: it does not exist, which is what the old boundary answered.
    expect((await chiama(io(), "/api/people/estraneo"))!.status).toBe(404);
    expect(await idsRubrica(io())).not.toContain("estraneo");

    expect((await chiama(io(), "/api/people/estraneo/follow", "POST"))!.status).toBe(200);

    expect((await chiama(io(), "/api/people/estraneo"))!.status).toBe(200);
    expect(await idsRubrica(io())).toContain("estraneo");
  });

  test("vale anche al contrario: chi mi segue lo vedo, senza seguirlo io", async () => {
    expect((await chiama(come("estraneo"), `/api/people/${ioPersonId}/follow`, "POST"))!.status).toBe(200);

    expect(await idsRubrica(io())).toContain("estraneo");
    const visto = await jsonOf<{ viewerFollows: boolean; followsViewer: boolean }>(
      await chiama(io(), "/api/people/estraneo"),
    );
    expect(visto.viewerFollows).toBe(false);
    expect(visto.followsViewer).toBe(true);
  });

  test("un profilo chiuso e' 404 per gli altri e 200 per se stessi, e sparisce dalla rubrica", async () => {
    db.run("UPDATE people SET show_profile = 0 WHERE id = 'mircea'");

    expect((await chiama(io(), "/api/people/mircea"))!.status).toBe(404);
    expect(await idsRubrica(io())).not.toContain("mircea");

    const suo = await chiama(come("mircea"), "/api/people/mircea");
    expect(suo!.status).toBe(200);
    expect((await jsonOf<{ id: string }>(suo)).id).toBe("mircea");
  });

  test("un profilo chiuso sparisce anche dagli elenchi di chi lo segue", async () => {
    await chiama(come("mircea"), `/api/people/${ioPersonId}/follow`, "POST");
    const before = await jsonOf<{ people: Array<{ id: string }> }>(
      await chiama(io(), `/api/people/${ioPersonId}/followers`),
    );
    expect(before.people.map((p) => p.id)).toContain("mircea");

    db.run("UPDATE people SET show_profile = 0 WHERE id = 'mircea'");

    const after = await jsonOf<{ people: Array<{ id: string }> }>(
      await chiama(io(), `/api/people/${ioPersonId}/followers`),
    );
    // Absent, not "hidden": an entry that says "private" still confirms that
    // this person exists.
    expect(after.people.map((p) => p.id)).not.toContain("mircea");
  });

  test("le statistiche spente sono `null`, non un numero accanto a una bandiera", async () => {
    turno(db, "mircea", 1000, 200);
    db.run("UPDATE people SET show_stats = 0 WHERE id = 'mircea'");

    const fromOutside = await jsonOf<{ stats: unknown }>(await chiama(io(), "/api/people/mircea"));
    expect(fromOutside.stats).toBeNull();

    const suo = await jsonOf<{ stats: { prompts: number } }>(
      await chiama(come("mircea"), "/api/people/mircea"),
    );
    expect(suo.stats.prompts).toBe(1);

    const rubrica = await jsonOf<{ people: Array<{ id: string; stats: unknown }> }>(
      await chiama(io(), "/api/people"),
    );
    expect(rubrica.people.find((p) => p.id === "mircea")!.stats).toBeNull();
  });

  test("l'email NON esce di default, e esce solo se la persona lo ha scelto", async () => {
    db.run("UPDATE people SET email = 'mircea@example.invalid' WHERE id = 'mircea'");

    // The migration's default is 0: closed, with nobody having touched a thing.
    expect((await jsonOf<{ email: string | null }>(await chiama(io(), "/api/people/mircea"))).email)
      .toBeNull();
    // A person always sees their own.
    expect((await jsonOf<{ email: string | null }>(await chiama(come("mircea"), "/api/people/mircea"))).email)
      .toBe("mircea@example.invalid");

    db.run("UPDATE people SET show_email = 1 WHERE id = 'mircea'");
    expect((await jsonOf<{ email: string | null }>(await chiama(io(), "/api/people/mircea"))).email)
      .toBe("mircea@example.invalid");
  });

  test("follower riservati: contatori `null` e 403 su tutti e due gli elenchi", async () => {
    await chiama(io(), "/api/people/mircea/follow", "POST");
    db.run("UPDATE people SET show_followers = 0 WHERE id = 'mircea'");

    expect((await jsonOf<{ counts: Counts }>(await chiama(io(), "/api/people/mircea"))).counts)
      .toBeNull();

    for (const list of ["followers", "following"]) {
      const r = await chiama(io(), `/api/people/mircea/${list}`);
      expect(r!.status).toBe(403);
      expect((await jsonOf<{ error: string }>(r)).error).toBe("followers are private");
    }

    // The follow route stops handing the number out too: it is the same value,
    // and letting it through from there would make the switch decorative.
    expect((await jsonOf<FollowResponse>(await chiama(io(), "/api/people/mircea/follow", "POST"))).counts)
      .toBeNull();

    // The person sees their own, counters and lists alike.
    const suo = await chiama(come("mircea"), "/api/people/mircea/followers");
    expect(suo!.status).toBe(200);
    expect((await jsonOf<{ people: Array<{ id: string }> }>(suo)).people.map((p) => p.id))
      .toEqual([ioPersonId]);
  });

  test("le manopole si leggono e si scrivono solo da chi le possiede", async () => {
    const mine = await chiama(come("mircea"), "/api/people/mircea/privacy");
    expect(mine!.status).toBe(200);
    expect((await jsonOf<{ privacy: Record<string, boolean> }>(mine)).privacy).toEqual({
      showProfile: true, showStats: true, showEmail: false, showFollowers: true, showPresence: true,
    });

    const fromOutside = await chiama(io(), "/api/people/mircea/privacy");
    expect(fromOutside!.status).toBe(403);
    const write = await chiama(io(), "/api/people/mircea/privacy", "PATCH", { showStats: false });
    expect(write!.status).toBe(403);
    // The refusal really stopped something.
    expect((db.query("SELECT show_stats AS s FROM people WHERE id = 'mircea'").get() as { s: number }).s)
      .toBe(1);
  });

  test("la patch e' parziale e ignora quello che non riconosce", async () => {
    const r = await chiama(come("mircea"), "/api/people/mircea/privacy", "PATCH", {
      showStats: false,
      // The string "false" is truthy, and the switch it would open is a privacy
      // switch: it gets ignored, not coerced.
      showEmail: "false",
      // An unknown key must not bring the request down.
      showQualcosa: true,
    });
    expect(r!.status).toBe(200);
    expect((await jsonOf<{ privacy: Record<string, boolean> }>(r)).privacy).toEqual({
      showProfile: true, showStats: false, showEmail: false, showFollowers: true, showPresence: true,
    });
  });

  test("le manopole viaggiano nel profilo solo verso chi le possiede", async () => {
    expect(await jsonOf<{ privacy?: unknown }>(await chiama(come("mircea"), "/api/people/mircea")))
      .toHaveProperty("privacy");
    expect(await jsonOf<{ privacy?: unknown }>(await chiama(io(), "/api/people/mircea")))
      .not.toHaveProperty("privacy");
  });

  test("presenza spenta: l'ultimo accesso e' `null` per gli altri e resta per se stessi", async () => {
    db.run("UPDATE devices SET last_seen_at = 1700 WHERE person_id = 'mircea'");

    expect((await jsonOf<{ lastSeenAt: number | null }>(await chiama(io(), "/api/people/mircea"))).lastSeenAt)
      .toBe(1700);

    db.run("UPDATE people SET show_presence = 0 WHERE id = 'mircea'");

    expect((await jsonOf<{ lastSeenAt: number | null }>(await chiama(io(), "/api/people/mircea"))).lastSeenAt)
      .toBeNull();
    expect((await jsonOf<{ lastSeenAt: number | null }>(
      await chiama(come("mircea"), "/api/people/mircea"),
    )).lastSeenAt).toBe(1700);
  });

  test("i due elenchi guardano i due capi opposti dell'arco, non lo stesso", async () => {
    await chiama(io(), "/api/people/mircea/follow", "POST");

    // I follow him: he is in MY following and in none of my followers.
    expect((await jsonOf<{ people: Array<{ id: string }> }>(
      await chiama(io(), `/api/people/${ioPersonId}/following`),
    )).people.map((p) => p.id)).toEqual(["mircea"]);
    expect((await jsonOf<{ people: Array<{ id: string }> }>(
      await chiama(io(), `/api/people/${ioPersonId}/followers`),
    )).people).toEqual([]);

    // And mirrored on his profile. Without this half, a route serving the
    // followers where the following belongs would pass all the same.
    expect((await jsonOf<{ people: Array<{ id: string }> }>(
      await chiama(io(), "/api/people/mircea/followers"),
    )).people.map((p) => p.id)).toEqual([ioPersonId]);
    expect((await jsonOf<{ people: Array<{ id: string }> }>(
      await chiama(io(), "/api/people/mircea/following"),
    )).people).toEqual([]);
  });

  test("una voce d'elenco porta tutto quello che la riga disegna, non solo l'id", async () => {
    await chiama(come("mircea"), `/api/people/${ioPersonId}/follow`, "POST");

    const before = await jsonOf<{ people: Array<Record<string, unknown>> }>(
      await chiama(io(), `/api/people/${ioPersonId}/followers`),
    );
    expect(before.people).toEqual([
      { id: "mircea", displayName: "mircea", githubLogin: null, github: null,
        viewerFollows: false, isMe: false },
    ]);

    // Following back changes ONE field, and in the right direction:
    // `viewerFollows` means "I follow them", not "they follow me". An
    // implementation with the two arguments swapped would already read `true`
    // above, and the row would offer Unfollow on somebody I do not follow.
    await chiama(io(), "/api/people/mircea/follow", "POST");
    const after = await jsonOf<{ people: Array<Record<string, unknown>> }>(
      await chiama(io(), `/api/people/${ioPersonId}/followers`),
    );
    expect(after.people[0]!.viewerFollows).toBe(true);
  });

  test("gli elenchi di una persona fuori dalla rubrica non si aprono", async () => {
    // The same boundary as the profile: a list readable about a person you
    // cannot open would be the way around the profile itself.
    for (const list of ["followers", "following"]) {
      expect((await chiama(io(), `/api/people/estraneo/${list}`))!.status).toBe(404);
    }
  });

  test("un profilo chiuso non si segue, e un arco gia' fatto si puo' sempre tagliare", async () => {
    expect((await chiama(io(), "/api/people/mircea/follow", "POST"))!.status).toBe(200);
    db.run("UPDATE people SET show_profile = 0 WHERE id = 'mircea'");

    // From scratch he cannot be followed, and the answer is the one an
    // invented id gets: the refusal does not confirm that the person exists.
    expect((await chiama(come("estraneo"), "/api/people/mircea/follow", "POST"))!.status).toBe(404);
    expect((await chiama(come("estraneo"), "/api/people/chi-non-esiste/follow", "POST"))!.status)
      .toBe(404);

    // But whoever holds the edge MUST be able to cut it. While the DELETE
    // went through the visibility filter too, closing your profile froze every
    // follower in place: 404 on the DELETE, row alive, and no other path in
    // the API to remove it. The edge keeps working meanwhile, and it is the
    // edge that puts the FOLLOWER inside the hidden person's address book.
    const via = await chiama(io(), "/api/people/mircea/follow", "DELETE");
    expect(via!.status).toBe(200);
    expect(await jsonOf<FollowResponse>(via)).toEqual({ following: false, counts: null });
    expect(db.query("SELECT COUNT(*) AS n FROM follows").get()).toEqual({ n: 0 });
  });

  test("il contatore non conta chi l'elenco non mostra, e per ognuno che guarda", async () => {
    collega(db, "ombra", orgId);
    await chiama(come("mircea"), `/api/people/${ioPersonId}/follow`, "POST");
    await chiama(come("ombra"), `/api/people/${ioPersonId}/follow`, "POST");
    expect((await jsonOf<{ counts: Counts }>(await chiama(io(), `/api/people/${ioPersonId}`))).counts)
      .toEqual({ followers: 2, following: 0 });

    db.run("UPDATE people SET show_profile = 0 WHERE id = 'ombra'");

    // For me: gone from the list, therefore gone from the number. The failure
    // to avoid is a header reading two over a list that draws one.
    expect((await jsonOf<{ counts: Counts }>(await chiama(io(), `/api/people/${ioPersonId}`))).counts!
      .followers).toBe(1);
    expect((await jsonOf<{ people: Array<{ id: string }> }>(
      await chiama(io(), `/api/people/${ioPersonId}/followers`),
    )).people.map((p) => p.id)).toEqual(["mircea"]);

    // For OMBRA the same profile counts two, because the list she sees holds
    // her own row as well: the count belongs to the view, not to the table.
    const shadowView = come("ombra");
    expect((await jsonOf<{ counts: Counts }>(await chiama(shadowView, `/api/people/${ioPersonId}`))).counts!
      .followers).toBe(2);
    expect((await jsonOf<{ people: Array<{ id: string }> }>(
      await chiama(shadowView, `/api/people/${ioPersonId}/followers`),
    )).people.map((p) => p.id)).toEqual(["mircea", "ombra"]);
  });

  test("la presenza spenta tiene anche sull'elenco dei membri, che legge la stessa colonna", async () => {
    db.run("UPDATE devices SET last_seen_at = 1700 WHERE person_id = 'mircea'");
    const auth = createAuthRouter(ctxAuth(db));

    const before = await jsonOf<{ members: Array<{ id: string; lastSeenAt: number | null }> }>(
      await chiama(auth, `/api/auth/orgs/${orgId}/members`),
    );
    expect(before.members.find((m) => m.id === "mircea")!.lastSeenAt).toBe(1700);

    db.run("UPDATE people SET show_presence = 0 WHERE id = 'mircea'");

    const after = await jsonOf<{ members: Array<{ id: string; lastSeenAt: number | null }> }>(
      await chiama(auth, `/api/auth/orgs/${orgId}/members`),
    );
    // The member stays in the list: they have not vanished, they have stopped
    // saying when they were last seen.
    expect(after.members.find((m) => m.id === "mircea")).toBeDefined();
    expect(after.members.find((m) => m.id === "mircea")!.lastSeenAt).toBeNull();
  });
});
