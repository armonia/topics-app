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
 *
 * @covers GUEST-06
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createAuthRouter, __resetLiveSocketsForTests, __resetPendingForTests,
} from "../../server/routes/auth";
import { createTasksRouter } from "../../server/routes/tasks";
import { resolvePrincipals } from "../../server/lib/principals";
import { grantedByType } from "../../server/lib/grants-query";
import type { RouteHandler } from "../../server/types";
import { TASKS_DDL, TASK_LABELS_DDL } from "../../server/db/test-schema";

const RADICE = join(import.meta.dir, "..", "..");
const MIGRAZIONI = ["080-devices.sql", "082-task-shares.sql", "083-grants.sql", "084-people-orgs.sql"];

/** Le colonne di `tasks` che il SERVIZIO legge (`SELECT *` + `rowToTask`), non
 *  quelle che bastano alla rotta: l'elenco delle schede di un ospite passa per
 *  `createTaskService`, quindi una tabella ridotta qui non fallirebbe
 *  sull'asserzione — fallirebbe prima, e per la ragione sbagliata. */
const DDL_TASKS = TASKS_DDL;

/** Lo schema VERO, applicando le migration: un CREATE TABLE riscritto a mano
 *  smetterebbe di accorgersi proprio della deriva che qui fa più male. */
function db084(): Database {
  const db = new Database(":memory:");
  db.run(DDL_TASKS);
  db.run(TASK_LABELS_DDL); // migration 100 — rowToTask la legge per OGNI task
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment',
    -- migration 20260904190855: the assistant row an agent said this in.
    message_id TEXT
  )`);
  db.run("CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT, updated_at INTEGER)");
  for (const m of MIGRAZIONI) {
    db.run(readFileSync(join(RADICE, "server", "db", "migrations", m), "utf8"));
  }
  db.run("INSERT INTO topics (id, name, updated_at) VALUES ('c1','La chat condivisa',1)");
  db.run("INSERT INTO topics (id, name, updated_at) VALUES ('c2','La chat PRIVATA',2)");
  seminaTask(db, "t1", "La scheda condivisa");
  return db;
}

/** Una scheda vera, con le colonne obbligatorie riempite. */
function seminaTask(db: Database, id: string, testo: string): void {
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at)
     VALUES (?, 'prog-1', ?, 'todo', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    [id, testo],
  );
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

/** Il router dei task destruttura di più (`matchRoute`, `broadcastToAll`) e
 *  guarda il RUOLO dell'identità, non solo il dispositivo: il filtro degli
 *  ospiti sta all'ingresso di quel router. */
function creaCtxTask(db: Database, deviceId: string | null) {
  return {
    db,
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    readJSON: async (req: Request) => {
      try { return await req.json(); } catch { return null; }
    },
    matchRoute: () => null,
    broadcast: () => {},
    broadcastToAll: () => {},
    getTopicBySessionKey: () => null,
    requestIdentity: () => (deviceId ? { deviceId, role: "guest" } : null),
  } as never;
}

function chiama(
  router: RouteHandler,
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
function guestWithPerson(db: Database): { deviceId: string; personId: string } {
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
    const { deviceId, personId } = guestWithPerson(db);
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
    const { deviceId, personId } = guestWithPerson(db);
    db.run(
      "INSERT INTO grants (id, subject_type, subject_id, resource_type, resource_id, level, granted_at) VALUES ('g1','person',?,'task','t1','read',1)",
      [personId],
    );
    const b = await inventario(db, deviceId);
    expect(b.tasks.map((t) => t.id)).toEqual(["t1"]);
  });

  test("una chat condivisa con un'ORGANIZZAZIONE viva compare; con una revocata no", async () => {
    const db = db084();
    const { deviceId, personId } = guestWithPerson(db);
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
    const { deviceId } = guestWithPerson(db);
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
    const { deviceId } = guestWithPerson(db);
    db.run(
      "INSERT INTO grants (id, subject_type, subject_id, resource_type, resource_id, level, granted_at) VALUES ('g1','device',?,'topic','c1','read',1)",
      [deviceId],
    );
    expect((await inventario(db, deviceId)).topics.map((t) => t.id)).toEqual(["c1"]);
  });

  test("senza identità non esce niente — non «tutto»", async () => {
    const db = db084();
    guestWithPerson(db);
    expect(await inventario(db, null)).toEqual({ tasks: [], topics: [] });
  });
});

/**
 * L'ALTRA metà della stessa domanda, e va fissata a parte perché vive in un
 * altro router.
 *
 * `GET /api/all-boards/tasks` è l'elenco che un ospite vede DENTRO l'app (la
 * board), e il filtro sta all'ingresso di `createTasksRouter`. È lo stesso
 * difetto di `/api/auth/shared` — il solo principale-ferro invece di tutti — ma
 * nessun test lo copriva: le prove end-to-end del confinamento condividono le
 * schede con un DISPOSITIVO, che è esattamente la forma in cui i due insiemi
 * di principali coincidono. Con quella forma, sostituire
 * `resolvePrincipals(...).list` con `deviceP(...)` resta verde: il difetto
 * passa in mezzo alla rete.
 *
 * Qui si condivide con la PERSONA, che è il soggetto che l'interfaccia offre
 * davvero (la rubrica di `/api/auth/subjects` propone la persona quando c'è).
 */
async function elencoSchede(db: Database, deviceId: string): Promise<string[]> {
  const router = createTasksRouter(creaCtxTask(db, deviceId));
  const r = await chiama(router, "/api/all-boards/tasks");
  expect(r?.status, "l'ospite deve poter chiedere il suo elenco").toBe(200);
  const b = await r!.json() as { tasks: Array<{ id: string }> };
  return b.tasks.map((t) => t.id);
}

describe("l'elenco delle schede di un ospite parla degli STESSI principali", () => {
  test("una scheda condivisa con la sua PERSONA compare nell'elenco", async () => {
    const db = db084();
    const { deviceId, personId } = guestWithPerson(db);
    db.run(
      "INSERT INTO grants (id, subject_type, subject_id, resource_type, resource_id, level, granted_at) VALUES ('g1','person',?,'task','t1','read',1)",
      [personId],
    );

    // Controllo POSITIVO sul canale di osservazione: il cancello concede. Senza,
    // un elenco vuoto non distinguerebbe «il router è cieco» da «la concessione
    // non esiste», e l'asserzione sotto sarebbe vera per la ragione sbagliata.
    expect(
      grantedByType(db, resolvePrincipals(db, deviceId).list).task,
      "il cancello vede la concessione alla persona",
    ).toContain("t1");

    expect(await elencoSchede(db, deviceId)).toEqual(["t1"]);
  });

  test("una scheda condivisa con un'ALTRA persona resta fuori", async () => {
    // Il controllo NEGATIVO: senza, «vede t1» sarebbe soddisfatto anche da un
    // filtro che non filtra niente.
    const db = db084();
    const { deviceId, personId } = guestWithPerson(db);
    seminaTask(db, "t2", "La scheda di un altro");
    db.run("INSERT INTO people (id, display_name, created_at, origin, rev, updated_at) VALUES ('p-altro','Estraneo',1,'local',1,1)");
    db.run(
      "INSERT INTO grants (id, subject_type, subject_id, resource_type, resource_id, level, granted_at) VALUES ('g1','person',?,'task','t1','read',1)",
      [personId],
    );
    db.run("INSERT INTO grants (id, subject_type, subject_id, resource_type, resource_id, level, granted_at) VALUES ('g2','person','p-altro','task','t2','read',1)");

    expect(await elencoSchede(db, deviceId)).toEqual(["t1"]);
  });

  test("una scheda condivisa con un'ORGANIZZAZIONE viva compare; con una revocata no", async () => {
    const db = db084();
    const { deviceId, personId } = guestWithPerson(db);
    db.run("INSERT INTO orgs (id, name, created_at, origin, rev, updated_at) VALUES ('o1','Squadra',1,'local',1,1)");
    db.run(
      "INSERT INTO org_members (org_id, person_id, role, joined_at, rev, updated_at) VALUES ('o1',?,'member',1,1,1)",
      [personId],
    );
    db.run("INSERT INTO grants (id, subject_type, subject_id, resource_type, resource_id, level, granted_at) VALUES ('g1','org','o1','task','t1','read',1)");

    expect(await elencoSchede(db, deviceId)).toEqual(["t1"]);

    db.run("UPDATE orgs SET revoked_at = 999 WHERE id = 'o1'");
    expect(await elencoSchede(db, deviceId)).toEqual([]);
  });

  test("la concessione al DISPOSITIVO continua a valere", async () => {
    const db = db084();
    const { deviceId } = guestWithPerson(db);
    db.run(
      "INSERT INTO grants (id, subject_type, subject_id, resource_type, resource_id, level, granted_at) VALUES ('g1','device',?,'task','t1','read',1)",
      [deviceId],
    );
    expect(await elencoSchede(db, deviceId)).toEqual(["t1"]);
  });

  test("una scheda NON condivisa non compare", async () => {
    const db = db084();
    const { deviceId } = guestWithPerson(db);
    expect(await elencoSchede(db, deviceId)).toEqual([]);
  });
});
