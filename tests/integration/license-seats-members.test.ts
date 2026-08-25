/**
 * I POSTI, nel punto in cui il gesto avviene davvero.
 *
 * `server/lib/licenza.ts` sa rispondere «c'è posto?», e lo sapeva già: la
 * domanda però non gliela faceva nessuno, mentre `POST
 * /api/auth/orgs/:id/members` aggiungeva membri senza chiedere niente. Due
 * risposte alla stessa domanda, e quella che contava era l'altra — la porta
 * unica era una porta su un muro.
 *
 * Qui si fissa il contrario, e con esso il confine che il modello impone:
 *
 *  · i posti governano l'INGRESSO, e SOLO quello. Togliere, elencare e cambiare
 *    ruolo non passano dalla licenza, perché un conteggio che può espellere è
 *    un conteggio che un giorno espelle qualcuno mentre la fatturazione ha un
 *    problema;
 *  · chi è già dentro non consuma un posto in più, o il gesto idempotente
 *    diventerebbe l'unico che si rompe a gruppo pieno;
 *  · senza servizio della licenza innestato non si inventa un'autorità: si
 *    lascia passare.
 *
 * La chiave privata di questo file nasce a ogni esecuzione e muore col
 * processo: non è su disco, non è nel repository, non è quella di nessun
 * servizio vero.
  * @covers LICENSE-02
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { createAuthRouter } from "../../server/routes/auth";
import { creaServizioLicenza, type CaricoGettone } from "../../server/lib/licenza";
import { TASKS_DDL } from "../../server/db/test-schema";

const RADICE = join(import.meta.dir, "..", "..");
const MIGRAZIONI = ["080-devices.sql", "082-task-shares.sql", "083-grants.sql", "084-people-orgs.sql"];
const IID = "installazione-di-prova";

function db084(): Database {
  const db = new Database(":memory:");
  db.run(TASKS_DDL);
  db.run("CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT, updated_at INTEGER)");
  for (const m of MIGRAZIONI) db.run(readFileSync(join(RADICE, "server", "db", "migrations", m), "utf8"));
  return db;
}

// ── Un servizio di firma finto, con la stessa forma di quello vero. ──────────
function nuovaCoppia() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return { privata: privateKey, pubblicaB64: der.subarray(der.length - 32).toString("base64") };
}
const emittente = nuovaCoppia();

function gettone(privata: KeyObject, seats: number): string {
  const carico: CaricoGettone = { v: 1, iid: IID, plan: "team", seats, exp: 4_000_000_000_000 };
  const p = Buffer.from(JSON.stringify(carico), "utf8").toString("base64url");
  return `${p}.${sign(null, Buffer.from(p, "ascii"), privata).toString("base64url")}`;
}

/** Il contesto minimo del router, più la licenza. `posti: null` è il caso in
 *  cui il servizio non è proprio innestato — un contesto ridotto, non un piano. */
function creaCtx(db: Database, posti: number | null | undefined) {
  const dir = mkdtempSync(join(tmpdir(), "posti-"));
  const svc = posti === undefined ? null : creaServizioLicenza({
    stateDir: dir,
    env: {
      TOPICS_LICENSE_PUBKEYS: `k1:${emittente.pubblicaB64}`,
      // `null` = piano gratuito: nessun gettone, che è il caso normale.
      ...(posti === null ? {} : { TOPICS_LICENSE_TOKEN: gettone(emittente.privata, posti) }),
    },
    installationId: IID,
  });
  const ctx = {
    db,
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    readJSON: async (req: Request) => {
      try { return await req.json() as unknown; } catch { return null; }
    },
    broadcast: () => { /* nessuno ascolta, qui */ },
    requestIdentity: () => null,
    requestIp: () => null,
    relayConfig: () => ({ baseUrl: null, installationId: IID }),
    licenza: svc ? () => svc : undefined,
  } as never;
  return { ctx, pulisci: () => rmSync(dir, { recursive: true, force: true }) };
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

const orgDi = (db: Database) => (db.query("SELECT id FROM orgs LIMIT 1").get() as { id: string }).id;
const ioDi = (db: Database) =>
  (db.query("SELECT person_id AS id FROM installation_owners WHERE is_default = 1").get() as { id: string }).id;

/** Quante persone VIVE ci sono nel gruppo, letto dal database e non dalla
 *  rotta: è il controllo che dice se un rifiuto ha davvero fermato qualcosa. */
const vivi = (db: Database, org: string) =>
  (db.query(`SELECT COUNT(*) AS n FROM org_members
              WHERE org_id = ? AND revoked_at IS NULL AND local_blocked_at IS NULL`)
    .get(org) as { n: number }).n;

describe("posti · la licenza decide chi ENTRA nel gruppo", () => {
  test("sul piano gratuito il secondo invito è rifiutato, e dice perché", async () => {
    const db = db084();
    const { ctx, pulisci } = creaCtx(db, null);
    const router = createAuthRouter(ctx);
    const org = orgDi(db);
    // Il gruppo parte con una persona: il proprietario. Un posto, occupato.
    expect(vivi(db, org)).toBe(1);

    const r = await chiama(router, `/api/auth/orgs/${org}/members`, "POST", { name: "Mircea" });
    expect(r?.status).toBe(403);
    expect(await r!.json()).toEqual({ error: "no_seats_left", seats: 1, members: 1 });
    // Il rifiuto ha fermato DAVVERO qualcosa: né il membro né la persona nuova.
    expect(vivi(db, org)).toBe(1);
    expect((db.query("SELECT COUNT(*) AS n FROM people").get() as { n: number }).n).toBe(1);
    pulisci();
  });

  test("con i posti pagati si entra, fino al tetto e non oltre", async () => {
    // Il controllo positivo del test sopra: se il rifiuto ci fosse comunque,
    // «i posti contano» sarebbe vero e inutile.
    const db = db084();
    const { ctx, pulisci } = creaCtx(db, 3);
    const router = createAuthRouter(ctx);
    const org = orgDi(db);

    for (const nome of ["Seconda", "Terza"]) {
      const r = await chiama(router, `/api/auth/orgs/${org}/members`, "POST", { name: nome });
      expect(r?.status, nome).toBe(200);
    }
    expect(vivi(db, org)).toBe(3);

    const quarta = await chiama(router, `/api/auth/orgs/${org}/members`, "POST", { name: "Quarta" });
    expect(quarta?.status).toBe(403);
    expect(await quarta!.json()).toEqual({ error: "no_seats_left", seats: 3, members: 3 });
    pulisci();
  });

  test("chi è già dentro non consuma un posto in più", async () => {
    // Ripetere la POST su un membro vivo è idempotente. A gruppo pieno non deve
    // diventare l'unico gesto che si rompe — e non deve, perché non aggiunge
    // nessuno.
    const db = db084();
    const { ctx, pulisci } = creaCtx(db, 1);
    const router = createAuthRouter(ctx);
    const org = orgDi(db);
    const io = ioDi(db);
    expect(vivi(db, org)).toBe(1);

    const r = await chiama(router, `/api/auth/orgs/${org}/members`, "POST", { personId: io });
    expect(r?.status).toBe(200);
    expect(vivi(db, org)).toBe(1);
    pulisci();
  });

  test("i posti esauriti NON tolgono nessuno, e non chiudono l'elenco", async () => {
    // La proprietà che tiene in piedi tutto il modello: un gruppo che ha sforato
    // (licenza scaduta, o ridotta) resta un gruppo, e chi c'è resta dentro. La
    // licenza ha voce sull'ingresso e su niente altro.
    const db = db084();
    const org = orgDi(db);
    // Due persone dentro, un posto solo: lo stato dopo un declassamento.
    db.run("INSERT INTO people (id, display_name, created_at, origin, rev, updated_at) VALUES ('p2','Già dentro',1,'local',1,1)");
    db.run("INSERT INTO org_members (org_id, person_id, role, joined_at, rev, updated_at) VALUES (?, 'p2','member',1,1,1)", [org]);
    const { ctx, pulisci } = creaCtx(db, null);
    const router = createAuthRouter(ctx);
    expect(vivi(db, org)).toBe(2);

    // Si LEGGE: l'elenco esce intero, con tutti e due.
    const elenco = await chiama(router, `/api/auth/orgs/${org}/members`);
    expect(elenco?.status).toBe(200);
    expect((await elenco!.json() as { members: unknown[] }).members.length).toBe(2);

    // Si CAMBIA RUOLO: la licenza non ha voce nemmeno qui, e il gruppo è pieno.
    const ruolo = await chiama(router, `/api/auth/orgs/${org}/members`, "PATCH", { personId: "p2", role: "admin" });
    expect(ruolo?.status).toBe(200);
    expect(db.query("SELECT role FROM org_members WHERE person_id = 'p2'").get()).toEqual({ role: "admin" });

    // Si TOGLIE: nessun `no_seats_left` su un gesto che libera un posto.
    const via = await chiama(router, `/api/auth/orgs/${org}/members?personId=p2`, "DELETE");
    expect(via?.status).toBe(200);
    expect(vivi(db, org)).toBe(1);
    pulisci();
  });

  test("senza servizio della licenza innestato non si inventa un'autorità", async () => {
    // Un contesto ridotto non ha niente a cui chiedere. Il verso in cui si
    // sbaglia è quello che lascia la macchina usabile: si passa.
    const db = db084();
    const { ctx, pulisci } = creaCtx(db, undefined);
    const router = createAuthRouter(ctx);
    const org = orgDi(db);
    const r = await chiama(router, `/api/auth/orgs/${org}/members`, "POST", { name: "Chiunque" });
    expect(r?.status).toBe(200);
    expect(vivi(db, org)).toBe(2);
    pulisci();
  });
});
