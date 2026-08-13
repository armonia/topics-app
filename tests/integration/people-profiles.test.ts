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
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPeopleRouter } from "../../server/routes/people";
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
    const p1 = (await r1!.json()) as { github: { name: string; avatarUrl: string; followers: number } };
    expect(chiamate).toBe(1);
    expect(p1.github.name).toBe("Mona Octocat");
    expect(p1.github.avatarUrl).toBe(RISPOSTA_GITHUB.avatar_url);
    expect(p1.github.followers).toBe(7);

    await chiama(router(db, null, finto), `/api/people/${ioPersonId}`);
    expect(chiamate).toBe(1); // la cache ha tenuto

    // E ora la lista ce l'ha, senza uscire.
    const rl = await chiama(router(db, null, finto), "/api/people");
    const { people } = (await rl!.json()) as { people: Array<{ id: string; github: { name: string } | null }> };
    expect(people.find((p) => p.id === ioPersonId)!.github!.name).toBe("Mona Octocat");
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
