/**
 * Le rotte di `server/routes/auth.ts`, contro uno SQLite vero.
 *
 * Perché esiste, e perché adesso: di tutto lo strato di identità e condivisione
 * erano coperti solo i moduli PURI — `auth-gate`, `device-auth`, `grants`. Le
 * rotte, cioè il punto in cui quelle decisioni diventano righe nel database e
 * cookie sul filo, non avevano niente. E sono proprio quelle che la change
 * `sharing-orgs` sta per riscrivere, quando il soggetto di una concessione
 * smetterà di essere un dispositivo e diventerà una persona o
 * un'organizzazione. Rifarle senza una rete sotto vuol dire scoprire una
 * regressione dall'app, cioè tardi.
 *
 * Lo schema NON è riscritto a mano: si applicano le migration vere (080, 082,
 * 083). Un test che ricostruisce le tabelle a memoria smette di accorgersi
 * proprio della cosa che qui fa più male — un CHECK che va in deriva rispetto
 * all'union TypeScript, che in questo repo è già successo due volte.
 *
 * Quel che si fissa è il COMPORTAMENTO, non l'implementazione: il verso
 * dell'appaiamento, i due tetti, il rifiuto di condividere con chi vede già
 * tutto, e soprattutto che `/api/auth/shared` parta dalle CONCESSIONI. Su
 * quest'ultimo c'è una cicatrice: la prima versione metteva `/api/topics` in
 * allowlist e rispondeva 200 con tutte le chat.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createAuthRouter, __resetLiveSocketsForTests, __resetPendingForTests,
} from "../../server/routes/auth";
import { hashToken, readSessionCookie } from "../../server/lib/device-auth";

const RADICE = join(import.meta.dir, "..", "..");
const MIGRAZIONI = ["080-devices.sql", "082-task-shares.sql", "083-grants.sql"];

function dbFresco(): Database {
  const db = new Database(":memory:");
  // Le due tabelle a cui le migration si agganciano con una FK, e da cui
  // `/api/auth/shared` va a prendere il contenuto vero.
  db.run(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, text TEXT, status TEXT,
    project_id TEXT, preview_image TEXT
  )`);
  db.run(`CREATE TABLE topics (
    id TEXT PRIMARY KEY, name TEXT, updated_at INTEGER
  )`);
  for (const m of MIGRAZIONI) {
    db.run(readFileSync(join(RADICE, "server", "db", "migrations", m), "utf8"));
  }
  return db;
}

/** Il minimo che `createAuthRouter` destruttura, più l'identità che il gate
 *  normalmente deposita per la richiesta. */
function creaCtx(db: Database, opts: { deviceId?: string | null } = {}) {
  const inviati: unknown[] = [];
  const ctx = {
    db,
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    readJSON: async (req: Request) => {
      try { return await req.json(); } catch { return null; }
    },
    broadcast: (f: unknown) => { inviati.push(f); },
    requestIdentity: () => (opts.deviceId ? { deviceId: opts.deviceId } : null),
    // Il tetto per-indirizzo passa di qui, non da un header letto dal router:
    // dietro un proxy l'unico che sa da dove arriva davvero una richiesta è il
    // server, quindi il router lo CHIEDE invece di dedurlo.
    requestIp: (req: Request) => req.headers.get("x-test-ip"),
  } as never;
  return { ctx, inviati };
}

function chiama(
  router: ReturnType<typeof createAuthRouter>,
  path: string,
  method = "GET",
  opts: { body?: unknown; ip?: string } = {},
): Promise<Response | null> {
  const url = new URL(`http://127.0.0.1:3333${path}`);
  const headers: Record<string, string> = { "content-type": "application/json" };
  // Il router legge l'indirizzo per il tetto per-IP e per decidere il loopback.
  if (opts.ip) headers["x-test-ip"] = opts.ip;
  const req = new Request(url, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return router(req, url, url.pathname, method) as Promise<Response | null>;
}

// Le richieste in attesa e il conteggio delle socket vivono nel MODULO, non nel
// database — è la scelta giusta lì (sono stato di sessione, e un riavvio che le
// azzera dice la verità) e una trappola qui: senza questo azzeramento le
// richieste di un caso restano appese al successivo finché non scadono, il tetto
// complessivo scatta a metà suite, e i casi dopo falliscono per un motivo che
// non è il loro. Successo davvero, la prima volta che ho lanciato questo file.
beforeEach(() => {
  __resetLiveSocketsForTests();
  __resetPendingForTests();
});

describe("rotte auth · appaiamento", () => {
  test("chi chiede riceve un codice DA MOSTRARE, non un campo dove scriverlo", async () => {
    const db = dbFresco();
    const { ctx } = creaCtx(db);
    const r = await chiama(createAuthRouter(ctx), "/api/auth/pair/request", "POST");
    expect(r?.status).toBe(200);
    const b = await r!.json() as { requestId: string; code: string; expiresInMs: number };
    expect(b.requestId).toBeTruthy();
    // Sei simboli di un alfabeto senza coppie confondibili (niente B/8, I/1,
    // O/0, S/5, L), spezzati a gruppi di tre: si legge da uno schermo e si
    // confronta su un altro, e sei caratteri di fila si leggono male.
    expect(b.code).toMatch(/^[ACDEFGHJKMNPQRTUVWXY234679]{3}-[ACDEFGHJKMNPQRTUVWXY234679]{3}$/);
    expect(b.expiresInMs).toBeGreaterThan(0);
  });

  test("finché nessuno conferma, lo stato resta in attesa", async () => {
    const db = dbFresco();
    const router = createAuthRouter(creaCtx(db).ctx);
    const req = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string };
    const st = await chiama(router, `/api/auth/pair/status?requestId=${req.requestId}`);
    expect((await st!.json() as { state: string }).state).toBe("pending");
    // E nessun dispositivo è nato: l'attesa non crea niente.
    expect(db.query("SELECT COUNT(*) c FROM devices").get()).toEqual({ c: 0 });
  });

  test("l'approvazione crea il dispositivo e consegna il cookie UNA volta sola", async () => {
    const db = dbFresco();
    const router = createAuthRouter(creaCtx(db).ctx);
    const req = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string };

    const ok = await chiama(router, "/api/auth/pair/approve", "POST", { body: { requestId: req.requestId } });
    expect(ok?.status).toBe(200);

    const st = await chiama(router, `/api/auth/pair/status?requestId=${req.requestId}`);
    const corpo = await st!.json() as { state: string };
    expect(corpo.state).toBe("approved");

    // Il cookie viaggia con QUELLA risposta: è la risposta a «sono stato
    // approvato?» che consegna la sessione.
    const cookie = st!.headers.get("set-cookie");
    expect(cookie).toContain("topics_device=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");

    // Nel DB c'è l'IMPRONTA, non il token: un backup del file non consegna le
    // sessioni.
    const token = readSessionCookie(cookie);
    expect(token).toBeTruthy();
    const riga = db.query("SELECT token_hash FROM devices").get() as { token_hash: string };
    expect(riga.token_hash).toBe(hashToken(token!));
    expect(riga.token_hash).not.toBe(token);
  });

  test("il ruolo si sceglie approvando: ospite non è il default", async () => {
    const db = dbFresco();
    const router = createAuthRouter(creaCtx(db).ctx);

    const a = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string };
    await chiama(router, "/api/auth/pair/approve", "POST", { body: { requestId: a.requestId } });
    const b = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string };
    await chiama(router, "/api/auth/pair/approve", "POST", { body: { requestId: b.requestId, role: "guest" } });

    const ruoli = (db.query("SELECT role FROM devices ORDER BY created_at").all() as Array<{ role: string }>)
      .map((r) => r.role);
    expect(ruoli).toContain("owner");
    expect(ruoli).toContain("guest");
  });

  test("un rifiuto non lascia nessuna riga dietro", async () => {
    const db = dbFresco();
    const router = createAuthRouter(creaCtx(db).ctx);
    const req = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string };
    await chiama(router, "/api/auth/pair/deny", "POST", { body: { requestId: req.requestId } });
    const st = await chiama(router, `/api/auth/pair/status?requestId=${req.requestId}`);
    expect((await st!.json() as { state: string }).state).toBe("denied");
    expect(db.query("SELECT COUNT(*) c FROM devices").get()).toEqual({ c: 0 });
  });

  test("i due tetti fermano l'inondazione della coda", async () => {
    const db = dbFresco();
    const router = createAuthRouter(creaCtx(db).ctx);
    // Tre dallo stesso indirizzo passano, la quarta no: il verso
    // dell'appaiamento toglie il brute-force del codice, non l'allagamento del
    // cartello sul computer.
    for (let i = 0; i < 3; i++) {
      const r = await chiama(router, "/api/auth/pair/request", "POST", { ip: "10.0.0.9" });
      expect(r?.status).toBe(200);
    }
    const quarta = await chiama(router, "/api/auth/pair/request", "POST", { ip: "10.0.0.9" });
    expect(quarta?.status).toBe(429);
  });
});

describe("rotte auth · dispositivi", () => {
  async function conDispositivo(role: "owner" | "guest" = "owner") {
    const db = dbFresco();
    const router = createAuthRouter(creaCtx(db).ctx);
    const req = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string };
    await chiama(router, "/api/auth/pair/approve", "POST", { body: { requestId: req.requestId, role } });
    const id = (db.query("SELECT id FROM devices").get() as { id: string }).id;
    return { db, router, id };
  }

  test("rinominare cambia il nome; un nome vuoto è rifiutato", async () => {
    const { db, router, id } = await conDispositivo();
    const ok = await chiama(router, `/api/auth/devices/${id}`, "PATCH", { body: { name: "iPhone di prova" } });
    expect(ok?.status).toBe(200);
    expect((db.query("SELECT name FROM devices WHERE id=?").get(id) as { name: string }).name).toBe("iPhone di prova");

    const vuoto = await chiama(router, `/api/auth/devices/${id}`, "PATCH", { body: { name: "   " } });
    expect(vuoto?.status).toBe(400);
    // E il nome di prima è rimasto: un rifiuto non deve cancellare.
    expect((db.query("SELECT name FROM devices WHERE id=?").get(id) as { name: string }).name).toBe("iPhone di prova");
  });

  test("revocare non cancella la riga: la marca", async () => {
    const { db, router, id } = await conDispositivo();
    await chiama(router, `/api/auth/devices/${id}`, "DELETE");
    const r = db.query("SELECT revoked_at FROM devices WHERE id=?").get(id) as { revoked_at: number | null };
    // Una riga cancellata non racconta niente; una revocata dice che quel
    // dispositivo c'è stato e quando gli è stata tolta la fiducia.
    expect(r).toBeTruthy();
    expect(r.revoked_at).toBeGreaterThan(0);
  });
});

describe("rotte auth · condivisione", () => {
  async function scena() {
    const db = dbFresco();
    const router = createAuthRouter(creaCtx(db).ctx);
    db.run("INSERT INTO tasks (id, text, status) VALUES ('t1','La scheda condivisa','todo')");
    db.run("INSERT INTO tasks (id, text, status) VALUES ('t2','La scheda PRIVATA','todo')");
    db.run("INSERT INTO topics (id, name, updated_at) VALUES ('c1','La chat condivisa',1)");
    db.run("INSERT INTO topics (id, name, updated_at) VALUES ('c2','La chat PRIVATA',2)");

    const a = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string };
    await chiama(router, "/api/auth/pair/approve", "POST", { body: { requestId: a.requestId } });
    const b = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string };
    await chiama(router, "/api/auth/pair/approve", "POST", { body: { requestId: b.requestId, role: "guest" } });

    const righe = db.query("SELECT id, role FROM devices").all() as Array<{ id: string; role: string }>;
    return {
      db, router,
      idProprietario: righe.find((r) => r.role === "owner")!.id,
      idOspite: righe.find((r) => r.role === "guest")!.id,
    };
  }

  test("condividere con un ospite scrive una concessione", async () => {
    const { db, router, idOspite } = await scena();
    const r = await chiama(router, "/api/auth/shares", "POST", {
      body: { resourceType: "task", resourceId: "t1", deviceId: idOspite },
    });
    expect(r?.status).toBe(200);
    const g = db.query("SELECT subject_type, subject_id, resource_type, resource_id, level FROM grants").get();
    expect(g).toEqual({
      subject_type: "device", subject_id: idOspite,
      resource_type: "task", resource_id: "t1", level: "read",
    });
  });

  test("condividere con un PROPRIETARIO è rifiutato: vede già tutto", async () => {
    const { db, router, idProprietario } = await scena();
    const r = await chiama(router, "/api/auth/shares", "POST", {
      body: { resourceType: "task", resourceId: "t1", deviceId: idProprietario },
    });
    // Non è pignoleria: quella riga suggerirebbe di star limitando qualcosa
    // mentre non limita niente.
    expect(r?.status).toBe(400);
    expect(db.query("SELECT COUNT(*) c FROM grants").get()).toEqual({ c: 0 });
  });

  test("un tipo di risorsa che non ha una riga vera è rifiutato", async () => {
    const { router, idOspite } = await scena();
    for (const tipo of ["space", "pane", "project", "terminal"]) {
      const r = await chiama(router, "/api/auth/shares", "POST", {
        body: { resourceType: tipo, resourceId: "x", deviceId: idOspite },
      });
      expect(r?.status).toBe(400);
    }
  });

  test("l'elenco dice CHI vede la cosa, e da dove gli viene", async () => {
    const { db, router, idOspite } = await scena();
    await chiama(router, "/api/auth/shares", "POST", {
      body: { resourceType: "task", resourceId: "t1", deviceId: idOspite },
    });
    // Una concessione derivata da un contenitore, scritta a mano come la
    // scriverebbe la condivisione di un progetto.
    db.run(
      "INSERT INTO grants (id, subject_type, subject_id, resource_type, resource_id, level, via_type, via_id, granted_at) VALUES ('g2','device',?,'task','t2','read','project','p1',1)",
      [idOspite],
    );
    const r = await chiama(router, "/api/auth/shares?resourceType=task&resourceId=t2");
    const b = await r!.json() as { shares: Array<{ deviceId: string; via: { type: string; id: string | null } | null }> };
    expect(b.shares).toHaveLength(1);
    expect(b.shares[0].via).toEqual({ type: "project", id: "p1" });
  });

  test("togliere la condivisione toglie la riga", async () => {
    const { db, router, idOspite } = await scena();
    await chiama(router, "/api/auth/shares", "POST", {
      body: { resourceType: "task", resourceId: "t1", deviceId: idOspite },
    });
    await chiama(router, `/api/auth/shares?resourceType=task&resourceId=t1&deviceId=${idOspite}`, "DELETE");
    expect(db.query("SELECT COUNT(*) c FROM grants").get()).toEqual({ c: 0 });
  });

  test("un ospite riceve SOLO ciò che gli è stato concesso", async () => {
    const { db, router, idOspite } = await scena();
    await chiama(router, "/api/auth/shares", "POST", {
      body: { resourceType: "task", resourceId: "t1", deviceId: idOspite },
    });
    await chiama(router, "/api/auth/shares", "POST", {
      body: { resourceType: "topic", resourceId: "c1", deviceId: idOspite },
    });

    // Adesso si guarda con gli occhi dell'ospite.
    const suo = createAuthRouter(creaCtx(db, { deviceId: idOspite }).ctx);
    const r = await chiama(suo, "/api/auth/shared");
    const b = await r!.json() as { tasks: Array<{ id: string }>; topics: Array<{ id: string }> };

    expect(b.tasks.map((t) => t.id)).toEqual(["t1"]);
    expect(b.topics.map((t) => t.id)).toEqual(["c1"]);
    // La cicatrice che questo test presidia: la prima versione metteva
    // `/api/topics` in allowlist e rispondeva con TUTTE le chat.
    expect(JSON.stringify(b)).not.toContain("PRIVATA");
  });

  test("senza identità non esce niente — non «tutto»", async () => {
    const { db } = await scena();
    const anonimo = createAuthRouter(creaCtx(db, { deviceId: null }).ctx);
    const r = await chiama(anonimo, "/api/auth/shared");
    expect(await r!.json()).toEqual({ tasks: [], topics: [] });
  });
});
