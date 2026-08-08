/**
 * L'INVENTARIO di un ospite e il CANCELLO devono rispondere alla stessa domanda
 * nello stesso modo.
 *
 * La domanda è una sola — «cosa può vedere questo dispositivo?» — e nel server
 * viveva in due posti che non coincidevano:
 *
 *   · il CANCELLO (`server.ts`, dove un ospite viene fermato) confronta le
 *     concessioni con TUTTI i principali del dispositivo: sé stesso, la sua
 *     persona, le organizzazioni vive di quella persona (`resolvePrincipals`);
 *   · l'INVENTARIO (`GET /api/auth/shared`, che è l'unica porta da cui un ospite
 *     scopre cosa gli è stato dato) guardava il solo `deviceP(deviceId)`.
 *
 * Il verso della divergenza è quello cattivo, ed è proprio quello che si
 * incontra: la rubrica di `/api/auth/subjects` offre la PERSONA e non il ferro
 * quando il dispositivo ne ha una — che è sempre, perché l'approvazione con
 * «è di un'altra persona» è il gesto che crea un ospite. Quindi la condivisione
 * fatta dall'interfaccia atterra su un soggetto `person`, il cancello la
 * onorava, e l'inventario non la vedeva: la chat era leggibile per id e
 * invisibile nell'elenco. «Te l'ho condivisa» / «io non vedo niente».
 *
 * Qui si fissa che i due coincidano, e si guarda anche il caso ORGANIZZAZIONE —
 * il secondo salto, quello che una condivisione «al team» produce.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createAuthRouter, __resetLiveSocketsForTests, __resetPendingForTests,
} from "../../server/routes/auth";
import { resolvePrincipals } from "../../server/lib/principals";
import { grantedByType } from "../../server/lib/grants-query";

const RADICE = join(import.meta.dir, "..", "..");
const MIGRAZIONI = ["080-devices.sql", "082-task-shares.sql", "083-grants.sql", "084-people-orgs.sql"];

/** Lo schema VERO, applicando le migration: un CREATE TABLE riscritto a mano
 *  smetterebbe di accorgersi proprio della deriva che qui fa più male. */
function db084(): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, text TEXT, status TEXT, project_id TEXT, preview_image TEXT)");
  db.run("CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT, updated_at INTEGER)");
  for (const m of MIGRAZIONI) {
    db.run(readFileSync(join(RADICE, "server", "db", "migrations", m), "utf8"));
  }
  db.run("INSERT INTO topics (id, name, updated_at) VALUES ('c1','La chat condivisa',1)");
  db.run("INSERT INTO topics (id, name, updated_at) VALUES ('c2','La chat PRIVATA',2)");
  db.run("INSERT INTO tasks (id, text, status) VALUES ('t1','La scheda condivisa','todo')");
  return db;
}

function creaCtx(db: Database, deviceId: string | null) {
  return {
    db,
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    readJSON: async (req: Request) => {
      try { return await req.json(); } catch { return null; }
    },
    broadcast: () => {},
    requestIdentity: () => (deviceId ? { deviceId } : null),
    requestIp: () => null,
    relayConfig: () => ({ baseUrl: null, installationId: "inst-test" }),
  } as never;
}

function chiama(
  router: ReturnType<typeof createAuthRouter>,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<Response | null> {
  const url = new URL(`http://127.0.0.1:3333${path}`);
  const req = new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return router(req, url, url.pathname, method) as Promise<Response | null>;
}

/** Un ospite con una PERSONA: è la forma che l'appaiamento produce davvero
 *  quando si risponde «è di un'altra persona», e l'unica da cui il difetto si
 *  vede. Le righe si scrivono a mano perché qui interessa lo stato finale, non
 *  il percorso che ci porta (quello è coperto in `auth-routes.test.ts`). */
function ospiteConPersona(db: Database): { deviceId: string; personId: string } {
  const personId = "p-ospite";
  db.run(
    "INSERT INTO people (id, display_name, created_at, origin, rev, updated_at) VALUES (?,?,?,?,?,?)",
    [personId, "Persona Ospite", 1, "local", 1, 1],
  );
  const deviceId = "d-ospite";
  db.run(
    "INSERT INTO devices (id, name, token_hash, created_at, role, person_id) VALUES (?,?,?,?,?,?)",
    [deviceId, "Telefono", "hash-ospite", 1, "guest", personId],
  );
  return { deviceId, personId };
}

async function inventario(db: Database, deviceId: string | null) {
  const router = createAuthRouter(creaCtx(db, deviceId));
  const r = await chiama(router, "/api/auth/shared");
  expect(r?.status).toBe(200);
  return await r!.json() as { tasks: Array<{ id: string }>; topics: Array<{ id: string }> };
}

beforeEach(() => {
  __resetLiveSocketsForTests();
  __resetPendingForTests();
});

describe("l'inventario dell'ospite parla degli stessi PRINCIPALI del cancello", () => {
  test("una chat condivisa con la sua PERSONA compare nell'inventario", async () => {
    const db = db084();
    const { deviceId, personId } = ospiteConPersona(db);
    db.run(
      "INSERT INTO grants (id, subject_type, subject_id, resource_type, resource_id, level, granted_at) VALUES ('g1','person',?,'topic','c1','read',1)",
      [personId],
    );

    // Il CANCELLO la concede — è il controllo positivo, senza il quale
    // l'asserzione sotto non distinguerebbe «l'inventario è cieco» da
    // «la concessione non esiste».
    const principali = resolvePrincipals(db, deviceId).list;
    expect(grantedByType(db, principali).topic, "il cancello vede la concessione alla persona").toContain("c1");

    const b = await inventario(db, deviceId);
    expect(b.topics.map((t) => t.id), "e l'inventario deve vedere la STESSA cosa").toEqual(["c1"]);
    // E niente di più: un inventario che si allarga sarebbe il difetto opposto.
    expect(JSON.stringify(b)).not.toContain("PRIVATA");
  });

  test("una scheda condivisa con la sua PERSONA compare nell'inventario", async () => {
    // Le schede e le chat escono dalla stessa chiamata: se solo una delle due
    // fosse corretta, la rotta risponderebbe in due modi alla stessa domanda.
    const db = db084();
    const { deviceId, personId } = ospiteConPersona(db);
    db.run(
      "INSERT INTO grants (id, subject_type, subject_id, resource_type, resource_id, level, granted_at) VALUES ('g1','person',?,'task','t1','read',1)",
      [personId],
    );
    const b = await inventario(db, deviceId);
    expect(b.tasks.map((t) => t.id)).toEqual(["t1"]);
  });

  test("una chat condivisa con un'ORGANIZZAZIONE viva compare; con una revocata no", async () => {
    const db = db084();
    const { deviceId, personId } = ospiteConPersona(db);
    db.run("INSERT INTO orgs (id, name, created_at, origin, rev, updated_at) VALUES ('o1','Squadra',1,'local',1,1)");
    db.run(
      "INSERT INTO org_members (org_id, person_id, role, joined_at, rev, updated_at) VALUES ('o1',?,'member',1,1,1)",
      [personId],
    );
    db.run("INSERT INTO grants (id, subject_type, subject_id, resource_type, resource_id, level, granted_at) VALUES ('g1','org','o1','topic','c1','read',1)");

    expect((await inventario(db, deviceId)).topics.map((t) => t.id)).toEqual(["c1"]);

    // Revocare il gruppo toglie il principale, quindi toglie la riga
    // dall'inventario: è il controllo NEGATIVO che dimostra che l'espansione
    // non è un «vede sempre tutto» travestito.
    db.run("UPDATE orgs SET revoked_at = 999 WHERE id = 'o1'");
    expect((await inventario(db, deviceId)).topics).toEqual([]);
  });

  test("una chat condivisa con un'ALTRA persona resta fuori", async () => {
    const db = db084();
    const { deviceId } = ospiteConPersona(db);
    db.run("INSERT INTO people (id, display_name, created_at, origin, rev, updated_at) VALUES ('p-altro','Estraneo',1,'local',1,1)");
    db.run("INSERT INTO grants (id, subject_type, subject_id, resource_type, resource_id, level, granted_at) VALUES ('g1','person','p-altro','topic','c1','read',1)");
    const b = await inventario(db, deviceId);
    expect(b.topics).toEqual([]);
    expect(b.tasks).toEqual([]);
  });

  test("la concessione al DISPOSITIVO continua a valere", async () => {
    // La strada vecchia non deve rompersi: `deviceP` era un sottoinsieme, non
    // una cosa diversa.
    const db = db084();
    const { deviceId } = ospiteConPersona(db);
    db.run(
      "INSERT INTO grants (id, subject_type, subject_id, resource_type, resource_id, level, granted_at) VALUES ('g1','device',?,'topic','c1','read',1)",
      [deviceId],
    );
    expect((await inventario(db, deviceId)).topics.map((t) => t.id)).toEqual(["c1"]);
  });

  test("senza identità non esce niente — non «tutto»", async () => {
    const db = db084();
    ospiteConPersona(db);
    expect(await inventario(db, null)).toEqual({ tasks: [], topics: [] });
  });
});
