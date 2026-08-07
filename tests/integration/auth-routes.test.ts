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

describe("rotte auth · la rubrica dei destinatari", () => {
  test("un ospite compare fra i soggetti; un proprietario no", async () => {
    const db = dbFresco();
    const router = createAuthRouter(creaCtx(db).ctx);
    for (const role of ["owner", "guest"] as const) {
      const r = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string };
      await chiama(router, "/api/auth/pair/approve", "POST", { body: { requestId: r.requestId, role } });
    }
    const b = await (await chiama(router, "/api/auth/subjects"))!.json() as {
      subjects: Array<{ subjectType: string; name: string }>;
    };
    // Condividere con chi vede già tutto non vuol dire niente, quindi il
    // proprietario non è un destinatario possibile.
    expect(b.subjects).toHaveLength(1);
    expect(b.subjects[0].subjectType).toBe("device");
  });

  test("su uno schema senza la 084 la rubrica non esplode: resta ai dispositivi", async () => {
    // Il server deve degradare su un database più vecchio, non cadere.
    const db = dbFresco();
    const router = createAuthRouter(creaCtx(db).ctx);
    const r = await chiama(router, "/api/auth/subjects");
    expect(r?.status).toBe(200);
    expect((await r!.json() as { subjects: unknown[] }).subjects).toEqual([]);
  });
});

describe("rotte auth · condividere con un soggetto che non è un dispositivo", () => {
  test("`deviceId` resta accettato come alias legacy", async () => {
    const db = dbFresco();
    const router = createAuthRouter(creaCtx(db).ctx);
    db.run("INSERT INTO tasks (id, text, status) VALUES ('t1','x','todo')");
    const a = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string };
    await chiama(router, "/api/auth/pair/approve", "POST", { body: { requestId: a.requestId, role: "guest" } });
    const id = (db.query("SELECT id FROM devices").get() as { id: string }).id;

    // La forma vecchia continua a funzionare: un client non aggiornato non
    // deve rompersi il giorno del rilascio.
    const r = await chiama(router, "/api/auth/shares", "POST", {
      body: { resourceType: "task", resourceId: "t1", deviceId: id },
    });
    expect(r?.status).toBe(200);
    expect(db.query("SELECT subject_type FROM grants").get()).toEqual({ subject_type: "device" });
  });

  test("un tipo di soggetto inventato è rifiutato", async () => {
    const db = dbFresco();
    const router = createAuthRouter(creaCtx(db).ctx);
    db.run("INSERT INTO tasks (id, text, status) VALUES ('t1','x','todo')");
    const r = await chiama(router, "/api/auth/shares", "POST", {
      body: { resourceType: "task", resourceId: "t1", subjectType: "team", subjectId: "x" },
    });
    expect(r?.status).toBe(400);
  });

  test("una persona su uno schema senza la 084 è rifiutata con una ragione", async () => {
    // Il caso peggiore sarebbe il silenzio: `INSERT OR IGNORE` inghiottirebbe
    // la violazione di CHECK e chi condivide resterebbe convinto di aver
    // condiviso.
    const db = dbFresco();
    const router = createAuthRouter(creaCtx(db).ctx);
    db.run("INSERT INTO tasks (id, text, status) VALUES ('t1','x','todo')");
    const r = await chiama(router, "/api/auth/shares", "POST", {
      body: { resourceType: "task", resourceId: "t1", subjectType: "person", subjectId: "p1" },
    });
    expect(r?.status).toBe(400);
    expect(db.query("SELECT COUNT(*) c FROM grants").get()).toEqual({ c: 0 });
  });
});

describe("rotte auth · inondare la coda non chiude fuori nessuno", () => {
  test("il proprietario appaia il suo telefono anche con la coda piena", async () => {
    // Il caso per cui la quota è stata rifatta. Col tetto complessivo applicato
    // come RIFIUTO, bastavano sette indirizzi con tre richieste a testa e da lì
    // in poi nessuno entrava più — nemmeno chi ha il telefono in mano e la
    // macchina davanti. Non fa entrare nessuno: impedisce a TE di far entrare.
    const db = dbFresco();
    const router = createAuthRouter(creaCtx(db).ctx);

    // Ottanta indirizzi diversi, tre richieste ciascuno: la coda va oltre il
    // tetto e resta piena.
    for (let i = 0; i < 80; i++) {
      for (let k = 0; k < 3; k++) {
        await chiama(router, "/api/auth/pair/request", "POST", { ip: `203.0.113.${i}` });
      }
    }

    const mia = await chiama(router, "/api/auth/pair/request", "POST", { ip: "192.168.1.7" });
    expect(mia?.status).toBe(200);
    const b = await mia!.json() as { code: string };
    expect(b.code).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}$/);
  });

  test("ma il limite su UN indirizzo resta un rifiuto", async () => {
    // È un limite su di te, non sulla coda: sfrattare le tue richieste per far
    // posto ad altre tue non vorrebbe dire niente.
    const db = dbFresco();
    const router = createAuthRouter(creaCtx(db).ctx);
    for (let k = 0; k < 3; k++) {
      const r = await chiama(router, "/api/auth/pair/request", "POST", { ip: "10.0.0.9" });
      expect(r?.status).toBe(200);
    }
    const quarta = await chiama(router, "/api/auth/pair/request", "POST", { ip: "10.0.0.9" });
    expect(quarta?.status).toBe(429);
  });
});

describe("rotte auth · spostare un dispositivo su un'altra persona", () => {
  /** Uno schema con la 084, che è dove vivono le persone. */
  function db084(): Database {
    const db = new Database(":memory:");
    db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, text TEXT, status TEXT, project_id TEXT, preview_image TEXT)");
    db.run("CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT, updated_at INTEGER)");
    for (const m of [...MIGRAZIONI, "084-people-orgs.sql"]) {
      db.run(readFileSync(join(RADICE, "server", "db", "migrations", m), "utf8"));
    }
    return db;
  }

  test("il dispositivo cambia persona, e le concessioni NON si muovono", async () => {
    // È la leva di correzione del backfill della 084: al momento
    // dell'appaiamento nessuno chiedeva di chi fosse un dispositivo, quindi
    // l'attribuzione è un'euristica e può essere sbagliata. Senza questo gesto
    // l'errore sarebbe per sempre — e «di chi è» decide se uno vede tutto.
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    db.run("INSERT INTO people (id, display_name, created_at, origin, rev, updated_at) VALUES ('p2','Altra',1,'local',1,1)");
    db.run("INSERT INTO tasks (id, text, status) VALUES ('t1','x','todo')");

    const a = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string };
    await chiama(router, "/api/auth/pair/approve", "POST", { body: { requestId: a.requestId, role: "guest" } });
    const id = (db.query("SELECT id FROM devices").get() as { id: string }).id;

    // Una concessione verso la persona di destinazione, che deve restare com'è.
    db.run("INSERT INTO grants (id, subject_type, subject_id, resource_type, resource_id, level, granted_at) VALUES ('g1','person','p2','task','t1','read',1)");

    const r = await chiama(router, `/api/auth/devices/${id}`, "PATCH", { body: { personId: "p2" } });
    expect(r?.status).toBe(200);
    expect(db.query("SELECT person_id FROM devices WHERE id=?").get(id)).toEqual({ person_id: "p2" });
    // Le concessioni puntano a una PERSONA: spostare il ferro non le tocca.
    expect(db.query("SELECT COUNT(*) c FROM grants").get()).toEqual({ c: 1 });
  });

  test("una persona che non esiste è rifiutata", async () => {
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    const a = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string };
    await chiama(router, "/api/auth/pair/approve", "POST", { body: { requestId: a.requestId } });
    const id = (db.query("SELECT id FROM devices").get() as { id: string }).id;

    const r = await chiama(router, `/api/auth/devices/${id}`, "PATCH", { body: { personId: "fantasma" } });
    expect(r?.status).toBe(404);
  });

  test("una persona REVOCATA è rifiutata", async () => {
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    db.run("INSERT INTO people (id, display_name, created_at, revoked_at, origin, rev, updated_at) VALUES ('px','Via',1,999,'local',1,1)");
    const a = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string };
    await chiama(router, "/api/auth/pair/approve", "POST", { body: { requestId: a.requestId } });
    const id = (db.query("SELECT id FROM devices").get() as { id: string }).id;
    const r = await chiama(router, `/api/auth/devices/${id}`, "PATCH", { body: { personId: "px" } });
    expect(r?.status).toBe(400);
  });

  test("rinominare continua a funzionare: i due gesti non si sono pestati", async () => {
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    const a = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string };
    await chiama(router, "/api/auth/pair/approve", "POST", { body: { requestId: a.requestId } });
    const id = (db.query("SELECT id FROM devices").get() as { id: string }).id;
    const r = await chiama(router, `/api/auth/devices/${id}`, "PATCH", { body: { name: "Telefono di Luca" } });
    expect(r?.status).toBe(200);
    expect(db.query("SELECT name FROM devices WHERE id=?").get(id)).toEqual({ name: "Telefono di Luca" });
  });
});

describe("rotte auth · il ruolo DISCENDE dalla persona", () => {
  function db084(): Database {
    const db = new Database(":memory:");
    db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, text TEXT, status TEXT, project_id TEXT, preview_image TEXT)");
    db.run("CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT, updated_at INTEGER)");
    for (const m of [...MIGRAZIONI, "084-people-orgs.sql"]) {
      db.run(readFileSync(join(RADICE, "server", "db", "migrations", m), "utf8"));
    }
    // La 084 il proprietario lo crea da sé, anche su un database vuoto — e la
    // UNIQUE su `is_default` impedisce di metterne un secondo, che è
    // esattamente il presidio giusto: di proprietario predefinito ce n'è uno.
    return db;
  }

  async function approva(router: ReturnType<typeof createAuthRouter>, corpo: Record<string, unknown>) {
    const a = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string };
    await chiama(router, "/api/auth/pair/approve", "POST", { body: { requestId: a.requestId, ...corpo } });
  }

  test("«è mio» → il dispositivo è del proprietario, e vede tutto", async () => {
    const db = db084();
    await approva(createAuthRouter(creaCtx(db).ctx), {});
    const d = db.query("SELECT role, person_id FROM devices").get() as { role: string; person_id: string };
    const io = db.query("SELECT person_id FROM installation_owners").get() as { person_id: string };
    expect(d).toEqual({ role: "owner", person_id: io.person_id });
  });

  test("«è di un'altra persona» → nasce la persona, e NON è proprietaria", async () => {
    // Il verso opposto — nuovo quindi proprietario — trasformerebbe un errore
    // di battitura in un accesso pieno.
    const db = db084();
    await approva(createAuthRouter(creaCtx(db).ctx), { personName: "Luca" });
    const d = db.query("SELECT role, person_id FROM devices").get() as { role: string; person_id: string };
    expect(d.role).toBe("guest");
    const p = db.query("SELECT display_name FROM people WHERE id = ?").get(d.person_id) as { display_name: string };
    expect(p.display_name).toBe("Luca");
    expect(db.query("SELECT COUNT(*) c FROM installation_owners").get()).toEqual({ c: 1 });
  });

  test("una persona che c'è già si riusa invece di duplicarla", async () => {
    const db = db084();
    db.run("INSERT INTO people (id, display_name, created_at, origin, rev, updated_at) VALUES ('p9','Luca',1,'local',1,1)");
    await approva(createAuthRouter(creaCtx(db).ctx), { personId: "p9" });
    const d = db.query("SELECT role, person_id FROM devices").get() as { role: string; person_id: string };
    expect(d).toEqual({ role: "guest", person_id: "p9" });
    // Il proprietario creato dalla 084 più Luca: due, non tre.
    expect(db.query("SELECT COUNT(*) c FROM people").get()).toEqual({ c: 2 });
  });

  test("`role` resta accettato come alias legacy dove le persone non ci sono", async () => {
    // Un client non aggiornato, o uno schema più vecchio della 084, non deve
    // rompersi il giorno del rilascio.
    const db = dbFresco();
    await approva(createAuthRouter(creaCtx(db).ctx), { role: "guest" });
    expect(db.query("SELECT role FROM devices").get()).toEqual({ role: "guest" });
  });
});

describe("rotte auth · i link di condivisione", () => {
  function db085(): Database {
    const db = new Database(":memory:");
    db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, text TEXT, status TEXT, project_id TEXT, preview_image TEXT)");
    db.run("CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT, updated_at INTEGER)");
    for (const m of [...MIGRAZIONI, "084-people-orgs.sql", "085-share-links.sql"]) {
      db.run(readFileSync(join(RADICE, "server", "db", "migrations", m), "utf8"));
    }
    db.run("INSERT INTO tasks (id, text, status) VALUES ('t1','x','todo')");
    return db;
  }

  test("la chiave esce UNA volta sola, e l'elenco non la ripropone", async () => {
    // Un endpoint che restituisce la chiave a richiesta trasformerebbe ogni
    // lettura dell'elenco in una copia del segreto.
    const db = db085();
    const router = createAuthRouter(creaCtx(db).ctx);
    const creato = await (await chiama(router, "/api/auth/share-links", "POST", {
      body: { resourceType: "task", resourceId: "t1" },
    }))!.json() as { ref: string; key: string };
    expect(creato.key).toBeTruthy();

    const elenco = await (await chiama(router, "/api/auth/share-links?resourceType=task&resourceId=t1"))!.text();
    expect(elenco).toContain(creato.ref);
    expect(elenco).not.toContain(creato.key);
  });

  test("la scadenza c'è sempre e ha un tetto", async () => {
    // Un link senza scadenza è un link che qualcuno ritrova in una chat fra due
    // anni e che funziona ancora.
    const db = db085();
    const router = createAuthRouter(creaCtx(db).ctx);
    const a = await (await chiama(router, "/api/auth/share-links", "POST", {
      body: { resourceType: "task", resourceId: "t1" },
    }))!.json() as { expiresAt: number };
    const giorni = (a.expiresAt - Date.now()) / 86_400_000;
    expect(giorni).toBeGreaterThan(6.9);
    expect(giorni).toBeLessThan(7.1);

    const b = await (await chiama(router, "/api/auth/share-links", "POST", {
      body: { resourceType: "task", resourceId: "t1", giorni: 3650 },
    }))!.json() as { expiresAt: number };
    expect((b.expiresAt - Date.now()) / 86_400_000).toBeLessThan(30.1);
  });

  test("due link della stessa cosa hanno chiavi DIVERSE", async () => {
    // Riusare la chiave vorrebbe dire che revocare un link non basta: chi ha il
    // vecchio potrebbe ancora leggere quello nuovo.
    const db = db085();
    const router = createAuthRouter(creaCtx(db).ctx);
    const uno = await (await chiama(router, "/api/auth/share-links", "POST", { body: { resourceType: "task", resourceId: "t1" } }))!.json() as { key: string };
    const due = await (await chiama(router, "/api/auth/share-links", "POST", { body: { resourceType: "task", resourceId: "t1" } }))!.json() as { key: string };
    expect(uno.key).not.toBe(due.key);
  });

  test("revocare marca la riga, e non la cancella", async () => {
    const db = db085();
    const router = createAuthRouter(creaCtx(db).ctx);
    const c = await (await chiama(router, "/api/auth/share-links", "POST", { body: { resourceType: "task", resourceId: "t1" } }))!.json() as { ref: string };
    await chiama(router, `/api/auth/share-links?ref=${c.ref}`, "DELETE");
    const r = db.query("SELECT revoked_at FROM share_links WHERE ref = ?").get(c.ref) as { revoked_at: number | null };
    expect(r.revoked_at).toBeGreaterThan(0);
  });

  test("su uno schema più vecchio della 085 non esplode", async () => {
    const db = dbFresco();
    const router = createAuthRouter(creaCtx(db).ctx);
    const r = await chiama(router, "/api/auth/share-links", "POST", { body: { resourceType: "task", resourceId: "t1" } });
    expect(r?.status).toBe(400);
    const e = await chiama(router, "/api/auth/share-links?resourceType=task&resourceId=t1");
    expect(await e!.json()).toEqual({ links: [] });
  });
});
