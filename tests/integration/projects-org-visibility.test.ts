/**
 * `GET /api/projects` smette di consegnare TUTTO a CHIUNQUE.
 *
 * Fino alla 092 la rotta rispondeva con l'intera tabella: l'unica difesa era il
 * confinamento dell'ospite in `server.ts`, cioè una porta chiusa, non una
 * regola su chi vede cosa. Con due persone nella stessa organizzazione la porta
 * è aperta per entrambe, e senza questa prova «stessa org, stessi progetti» e
 * «tranne gli incognito» sono due frasi che nessuno fa valere.
 *
 * Si guarda la ROTTA e non la sola funzione pura (`project-visibility.test.ts`,
 * che copre la regola caso per caso): il difetto che costa non è la regola
 * sbagliata, è il verbo che non la chiama — una PATCH o una DELETE che scavalca
 * il filtro perché il controllo stava solo nel ramo GET.
  * @covers PROJECT-07
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createProjectsRouter } from "../../server/routes/projects";
import { createProjectStore } from "../../server/services/project-store";
import type { RouteHandler } from "../../server/types";

const RADICE = join(import.meta.dir, "..", "..");
const MIGRAZIONI = [
  "016-projects.sql", "080-devices.sql", "082-task-shares.sql", "083-grants.sql",
  "084-people-orgs.sql", "092-project-org-incognito.sql",
];

function dbVero(): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)");
  db.run("CREATE TABLE worktrees (id TEXT PRIMARY KEY, project_id TEXT)");
  for (const m of MIGRAZIONI) {
    db.run(readFileSync(join(RADICE, "server", "db", "migrations", m), "utf8"));
  }
  // La 084 si porta dietro il proprio bootstrap (una persona, un'org, una
  // installazione): qui si aggiunge solo il SECONDO abitante, che è il caso per
  // cui questa funzione esiste.
  return db;
}

/** L'org e la persona che la 084 ha creato da sé, lette invece che indovinate. */
function bootstrap(db: Database) {
  const org = (db.query("SELECT org_id FROM installation WHERE singleton = 1").get() as { org_id: string });
  const io = (db.query("SELECT person_id FROM installation_owners WHERE is_default = 1").get() as
    { person_id: string });
  return { orgId: org.org_id, ioPersonId: io.person_id };
}

/** Una persona in più nella stessa organizzazione, col suo dispositivo. */
function collega(db: Database, id: string, orgId: string, opts: { proprietario?: boolean } = {}) {
  db.run("INSERT INTO people (id, display_name, created_at, updated_at) VALUES (?, ?, 0, 0)", [id, id]);
  db.run(
    "INSERT INTO org_members (org_id, person_id, role, joined_at, updated_at) VALUES (?, ?, 'member', 0, 0)",
    [orgId, id],
  );
  if (opts.proprietario) {
    db.run("INSERT INTO installation_owners (person_id, added_at, is_default) VALUES (?, 0, 0)", [id]);
  }
  const dev = `dev-${id}`;
  db.run(
    `INSERT INTO devices (id, name, token_hash, created_at, last_seen_at, role, person_id)
     VALUES (?, ?, ?, 0, 0, 'owner', ?)`,
    [dev, `Mac di ${id}`, `hash-${id}`, id],
  );
  return dev;
}

function creaCtx(db: Database, deviceId: string | null): never {
  return {
    db,
    projectStore: createProjectStore(db),
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
    // I tre frame con la riga intera non passano più di là: chi li riceve lo
    // decide `broadcastProject`, provato in `project-broadcast-visibility.test.ts`.
    // Qui si guarda l'elenco, non il filo.
    broadcastProject: () => {},
    requestIdentity: () => (deviceId ? { role: "owner", deviceId } : null),
  } as never;
}

function chiama(router: RouteHandler, path: string, method = "GET", body?: unknown) {
  const url = new URL(`http://127.0.0.1:3333${path}`);
  const req = new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return router(req, url, url.pathname, method) as Promise<Response | null>;
}

const elenco = async (router: RouteHandler): Promise<string[]> => {
  const r = await chiama(router, "/api/projects");
  const body = (await r!.json()) as { projects: Array<{ name: string }> };
  return body.projects.map((p) => p.name).sort();
};

describe("progetti d'organizzazione e incognito, dalla rotta", () => {
  let db: Database;
  let orgId: string;
  let ioPersonId: string;
  let devMircea: string;

  beforeEach(() => {
    db = dbVero();
    ({ orgId, ioPersonId } = bootstrap(db));
    devMircea = collega(db, "mircea", orgId);
    const store = createProjectStore(db);
    store.create({ name: "Condiviso", slug: "condiviso", path: "/tmp/a", orgId, ownerPersonId: ioPersonId });
    store.create({ name: "Segreto", slug: "segreto", path: "/tmp/b", orgId, ownerPersonId: ioPersonId });
    store.create({ name: "Legacy", slug: "legacy", path: "/tmp/c" }); // org_id NULL: pre-092
  });

  test("stessa org, stessi progetti — ma il legacy senza org resta al padrone di casa", async () => {
    const mio = createProjectsRouter(creaCtx(db, null)); // loopback: la macchina
    expect(await elenco(mio)).toEqual(["Condiviso", "Legacy", "Segreto"]);

    const suo = createProjectsRouter(creaCtx(db, devMircea));
    expect(await elenco(suo)).toEqual(["Condiviso", "Segreto"]);
  });

  test("marcato incognito, sparisce dall'elenco del compagno d'org e resta nel mio", async () => {
    const store = createProjectStore(db);
    const segreto = store.getBySlug("segreto")!;
    const mio = createProjectsRouter(creaCtx(db, null));
    const r = await chiama(mio, `/api/projects/${segreto.id}`, "PATCH", { incognito: true });
    expect(r!.status).toBe(200);
    expect(((await r!.json()) as { incognito: boolean }).incognito).toBe(true);

    expect(await elenco(createProjectsRouter(creaCtx(db, devMircea)))).toEqual(["Condiviso"]);
    expect(await elenco(mio)).toEqual(["Condiviso", "Legacy", "Segreto"]);
  });

  test("un incognito altrui non si legge, non si modifica, non si cancella", async () => {
    const store = createProjectStore(db);
    const segreto = store.getBySlug("segreto")!;
    store.update(segreto.id, { incognito: true });
    const suo = createProjectsRouter(creaCtx(db, devMircea));

    for (const [metodo, corpo] of [["GET", undefined], ["PATCH", { name: "Mio ora" }], ["DELETE", undefined]] as const) {
      const r = await chiama(suo, `/api/projects/${segreto.id}`, metodo, corpo);
      expect(r!.status).toBe(404);
    }
    for (const verbo of ["archive", "restore"]) {
      const r = await chiama(suo, `/api/projects/${segreto.id}/${verbo}`, "POST");
      expect(r!.status).toBe(404);
    }
    // E la riga è ancora lì, com'era.
    expect(store.get(segreto.id)!.name).toBe("Segreto");
  });

  test("la lookup per path di un progetto altrui risponde come un miss, non 403", async () => {
    const store = createProjectStore(db);
    store.update(store.getBySlug("segreto")!.id, { incognito: true });
    const suo = createProjectsRouter(creaCtx(db, devMircea));
    const r = await chiama(suo, "/api/projects?path=%2Ftmp%2Fb");
    expect(r!.status).toBe(200);
    expect(await r!.json()).toBeNull();
    // Il condiviso invece si trova.
    const ok = await chiama(suo, "/api/projects?path=%2Ftmp%2Fa");
    expect(((await ok!.json()) as { name: string }).name).toBe("Condiviso");
  });

  test("`incognito` accetta solo un booleano vero", async () => {
    const store = createProjectStore(db);
    const id = store.getBySlug("condiviso")!.id;
    const mio = createProjectsRouter(creaCtx(db, null));
    for (const valore of ["true", 1, "si"]) {
      const r = await chiama(mio, `/api/projects/${id}`, "PATCH", { incognito: valore });
      expect(r!.status).toBe(400);
    }
    expect(store.get(id)!.incognito).toBe(false);
  });

  test("un estraneo — nessuna org in comune — non vede niente", async () => {
    db.run("INSERT INTO orgs (id, name, created_at, updated_at) VALUES ('altra', 'Altra', 0, 0)");
    const devEstraneo = collega(db, "estraneo", "altra");
    expect(await elenco(createProjectsRouter(creaCtx(db, devEstraneo)))).toEqual([]);
  });
});
