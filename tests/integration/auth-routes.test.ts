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
  __invecchiaPendingPerTests,
} from "../../server/routes/auth";
import { PAIRING_CODE_TTL_MS } from "../../server/lib/device-auth";
import { hashToken, readSessionCookie } from "../../server/lib/device-auth";
import { TASKS_DDL } from "../../server/db/test-schema";

const RADICE = join(import.meta.dir, "..", "..");
const MIGRAZIONI = ["080-devices.sql", "082-task-shares.sql", "083-grants.sql"];

function dbFresco(): Database {
  const db = new Database(":memory:");
  // Le due tabelle a cui le migration si agganciano con una FK, e da cui
  // `/api/auth/shared` va a prendere il contenuto vero.
  db.run(TASKS_DDL);
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
function creaCtx(db: Database, opts: { deviceId?: string | null; relay?: boolean } = {}) {
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
    // Il relay ACCESO è il default qui perché è lo stato in cui i link hanno
    // senso; `relay: false` è il caso «condivisione pubblica spenta».
    relayConfig: () => ({
      baseUrl: opts.relay === false ? null : "https://relay.esempio.test",
      installationId: "inst-test",
    }),
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
    const b = await r!.json() as { requestId: string; code: string; claim: string; expiresInMs: number };
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
    const req = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string; claim: string };
    const st = await chiama(router, `/api/auth/pair/status?requestId=${req.requestId}&claim=${req.claim}`);
    expect((await st!.json() as { state: string }).state).toBe("pending");
    // E nessun dispositivo è nato: l'attesa non crea niente.
    expect(db.query("SELECT COUNT(*) c FROM devices").get()).toEqual({ c: 0 });
  });

  test("l'approvazione crea il dispositivo e consegna il cookie UNA volta sola", async () => {
    const db = dbFresco();
    const router = createAuthRouter(creaCtx(db).ctx);
    const req = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string; claim: string };

    const ok = await chiama(router, "/api/auth/pair/approve", "POST", { body: { requestId: req.requestId } });
    expect(ok?.status).toBe(200);

    const st = await chiama(router, `/api/auth/pair/status?requestId=${req.requestId}&claim=${req.claim}`);
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

    const a = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string; claim: string };
    await chiama(router, "/api/auth/pair/approve", "POST", { body: { requestId: a.requestId } });
    const b = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string; claim: string };
    await chiama(router, "/api/auth/pair/approve", "POST", { body: { requestId: b.requestId, role: "guest" } });

    const ruoli = (db.query("SELECT role FROM devices ORDER BY created_at").all() as Array<{ role: string }>)
      .map((r) => r.role);
    expect(ruoli).toContain("owner");
    expect(ruoli).toContain("guest");
  });

  test("un rifiuto non lascia nessuna riga dietro", async () => {
    const db = dbFresco();
    const router = createAuthRouter(creaCtx(db).ctx);
    const req = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string; claim: string };
    await chiama(router, "/api/auth/pair/deny", "POST", { body: { requestId: req.requestId } });
    const st = await chiama(router, `/api/auth/pair/status?requestId=${req.requestId}&claim=${req.claim}`);
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
    const req = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string; claim: string };
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

describe("rotte auth · la scadenza si annuncia da sola", () => {
  // Attilio l'ha visto per primo: «sono passati tre minuti ma sta ancora là».
  // Il server la scadenza la applicava — `sweep` gira a ogni richiesta
  // `/api/auth/*` — ma il cartello di approvazione vive nella memoria del
  // CLIENT, messo lì da un broadcast. Senza l'annuncio contrario restava sullo
  // schermo per sempre, e cliccarlo dava 404. Su un endpoint esposto a Internet
  // è la richiesta di uno sconosciuto che continua a invitare un clic molto
  // dopo che sarebbe dovuta sparire.
  test("una richiesta scaduta viene ANNUNCIATA, non solo dimenticata", async () => {
    const db = dbFresco();
    const { ctx, inviati } = creaCtx(db);
    const router = createAuthRouter(ctx);
    const req = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string };

    // Il cartello è comparso: controllo positivo, altrimenti il resto non
    // proverebbe niente.
    expect(inviati.some((f) => (f as { type?: string }).type === "auth:pair-requested")).toBe(true);

    // Si invecchia la richiesta oltre il tetto e si tocca una rotta qualunque.
    __invecchiaPendingPerTests(req.requestId, PAIRING_CODE_TTL_MS + 1);
    await chiama(router, "/api/auth/pair/pending");

    const annuncio = inviati.find((f) => {
      const x = f as { type?: string; requestId?: string; approved?: boolean };
      return x.type === "auth:pair-resolved" && x.requestId === req.requestId;
    }) as { approved?: boolean } | undefined;
    expect(annuncio, "chi ha messo il cartello deve anche toglierlo").toBeTruthy();
    expect(annuncio!.approved, "scaduta non è approvata").toBe(false);

    // E non è più approvabile: la scadenza è un fatto, non una decorazione.
    const tardi = await chiama(router, "/api/auth/pair/approve", "POST", { body: { requestId: req.requestId } });
    expect(tardi?.status).toBe(404);
  });
});

describe("rotte auth · il segreto di ritiro", () => {
  // Il `requestId` GIRA: `auth:pair-requested` lo porta alle socket perché il
  // cartello di approvazione compaia. Il gettone no. Tenere separate le due
  // cose è ciò che impedisce a chi ha visto passare il primo di incassare il
  // secondo — la scalata provata in `guest-confinement.spec.ts` (GUEST-05).
  test("senza il segreto non si ritira, e sbagliarlo è indistinguibile dal non esistere", async () => {
    const db = dbFresco();
    const { ctx } = creaCtx(db);
    const router = createAuthRouter(ctx);
    const req = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as
      { requestId: string; claim: string };
    await chiama(router, "/api/auth/pair/approve", "POST", { body: { requestId: req.requestId } });

    // Senza segreto, e con quello sbagliato: la stessa risposta di un
    // riferimento inventato. Distinguerli direbbe «questo esiste», che è metà
    // del lavoro di chi prova.
    for (const q of [
      `requestId=${req.requestId}`,
      `requestId=${req.requestId}&claim=sbagliato`,
      `requestId=non-esiste&claim=${req.claim}`,
    ]) {
      const r = await chiama(router, `/api/auth/pair/status?${q}`);
      expect(await r!.json()).toEqual({ state: "expired" });
      expect(r!.headers.get("set-cookie"), `${q} non deve consegnare niente`).toBeNull();
    }

    // E il legittimo incassa ancora: il tappo non ha chiuso la porta di casa.
    const ok = await chiama(router, `/api/auth/pair/status?requestId=${req.requestId}&claim=${req.claim}`);
    expect((await ok!.json() as { state: string }).state).toBe("approved");
    expect(ok!.headers.get("set-cookie")).toContain("topics_device=");
  });

  test("il segreto NON esce nel frame che annuncia l'appaiamento", async () => {
    // È l'invariante che regge tutto il resto: se un giorno qualcuno aggiunge
    // `claim` a quel broadcast «per comodità», la separazione muore in silenzio
    // e nessun'altra riga se ne accorge.
    const db = dbFresco();
    const { ctx, inviati } = creaCtx(db);
    const router = createAuthRouter(ctx);
    const req = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as
      { requestId: string; claim: string };

    const annuncio = inviati.find((f) => (f as { type?: string }).type === "auth:pair-requested");
    expect(annuncio, "il cartello di approvazione ha bisogno di questo frame").toBeTruthy();
    expect(JSON.stringify(annuncio)).toContain(req.requestId);
    expect(JSON.stringify(annuncio), "il segreto di ritiro non deve viaggiare").not.toContain(req.claim);
  });
});

describe("rotte auth · condivisione", () => {
  async function scena() {
    const db = dbFresco();
    const router = createAuthRouter(creaCtx(db).ctx);
    db.run("INSERT INTO tasks (id, text, status, project_id, created_at, updated_at) VALUES ('t1','La scheda condivisa','todo', 'p-test', '2026-01-01', '2026-01-01')");
    db.run("INSERT INTO tasks (id, text, status, project_id, created_at, updated_at) VALUES ('t2','La scheda PRIVATA','todo', 'p-test', '2026-01-01', '2026-01-01')");
    db.run("INSERT INTO topics (id, name, updated_at) VALUES ('c1','La chat condivisa',1)");
    db.run("INSERT INTO topics (id, name, updated_at) VALUES ('c2','La chat PRIVATA',2)");

    const a = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string; claim: string };
    await chiama(router, "/api/auth/pair/approve", "POST", { body: { requestId: a.requestId } });
    const b = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string; claim: string };
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
    // `project` e' USCITO da questa lista con 20260816230500: ha la sua tabella
    // (migration 016) con id stabile, quindi una concessione ha una riga a cui
    // appendersi. La regola non e' cambiata, e' cambiato il fatto - gli altri
    // restano fuori per la ragione di sempre: uno spazio e una tab vivono in un
    // blob di ui_state, un terminale e' un processo.
    for (const tipo of ["space", "pane", "terminal"]) {
      const r = await chiama(router, "/api/auth/shares", "POST", {
        body: { resourceType: tipo, resourceId: "x", deviceId: idOspite },
      });
      expect(r?.status).toBe(400);
    }
  });

  test("l'elenco dice CHI vede la cosa, e di che natura è il soggetto", async () => {
    // La natura del soggetto NON è decorazione: «device» muore con quel ferro,
    // «person» segue la persona su OGNI dispositivo che appaierà, presente e
    // futuro. Sono due permessi diversi dietro lo stesso nome, e la riga da
    // togliere è una sola: se il pannello non li distingue, chi revoca non sa
    // cosa sta revocando.
    //
    // Serve la 084: prima di quella migration il CHECK di `grants` ammette solo
    // `device`, e una persona non ci si può nemmeno scrivere.
    const db = new Database(":memory:");
    db.run(TASKS_DDL);
    db.run("CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT, updated_at INTEGER)");
    for (const m of [...MIGRAZIONI, "084-people-orgs.sql"]) {
      db.run(readFileSync(join(RADICE, "server", "db", "migrations", m), "utf8"));
    }
    db.run("INSERT INTO tasks (id, text, status, project_id, created_at, updated_at) VALUES ('t1','La scheda condivisa','todo', 'p-test', '2026-01-01', '2026-01-01')");
    const router = createAuthRouter(creaCtx(db).ctx);

    // Il PRIMO dispositivo di un'installazione è il proprietario, e a un
    // proprietario non si condivide niente (vede già tutto). L'ospite è il
    // secondo, ed è ospite perché è di un'ALTRA persona — che dalla 084 è il
    // gesto che crea un ospite, non un flag.
    const a = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string };
    await chiama(router, "/api/auth/pair/approve", "POST", { body: { requestId: a.requestId } });
    const g = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string };
    await chiama(router, "/api/auth/pair/approve", "POST", { body: { requestId: g.requestId, personName: "Anna" } });
    const ospite = db.query("SELECT id, person_id FROM devices WHERE role = 'guest'").get() as { id: string; person_id: string };

    // Le due nature, sulla stessa risorsa: il ferro e la persona.
    for (const soggetto of [
      { subjectType: "device", subjectId: ospite.id },
      { subjectType: "person", subjectId: ospite.person_id },
    ]) {
      const p = await chiama(router, "/api/auth/shares", "POST", {
        body: { resourceType: "task", resourceId: "t1", ...soggetto },
      });
      expect(p?.status, `condivisione con ${soggetto.subjectType}`).toBe(200);
    }

    const r = await chiama(router, "/api/auth/shares?resourceType=task&resourceId=t1");
    const b = await r!.json() as { shares: Array<{ subjectType: string; subjectId: string; name: string }> };
    expect(b.shares.map((s) => `${s.subjectType}:${s.subjectId}`))
      .toEqual([`device:${ospite.id}`, `person:${ospite.person_id}`]);
    // E il NOME della persona, non il suo UUID: «Condiviso con a8e3c1e4…» non
    // risponde a nessuna delle domande per cui si apre questo pannello.
    expect(b.shares.find((s) => s.subjectType === "person")?.name).toBe("Anna");
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
      const r = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string; claim: string };
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
    db.run("INSERT INTO tasks (id, text, status, project_id, created_at, updated_at) VALUES ('t1','x','todo', 'p-test', '2026-01-01', '2026-01-01')");
    const a = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string; claim: string };
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
    db.run("INSERT INTO tasks (id, text, status, project_id, created_at, updated_at) VALUES ('t1','x','todo', 'p-test', '2026-01-01', '2026-01-01')");
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
    db.run("INSERT INTO tasks (id, text, status, project_id, created_at, updated_at) VALUES ('t1','x','todo', 'p-test', '2026-01-01', '2026-01-01')");
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
    db.run(TASKS_DDL);
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
    db.run("INSERT INTO tasks (id, text, status, project_id, created_at, updated_at) VALUES ('t1','x','todo', 'p-test', '2026-01-01', '2026-01-01')");

    const a = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string; claim: string };
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
    const a = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string; claim: string };
    await chiama(router, "/api/auth/pair/approve", "POST", { body: { requestId: a.requestId } });
    const id = (db.query("SELECT id FROM devices").get() as { id: string }).id;

    const r = await chiama(router, `/api/auth/devices/${id}`, "PATCH", { body: { personId: "fantasma" } });
    expect(r?.status).toBe(404);
  });

  test("una persona REVOCATA è rifiutata", async () => {
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    db.run("INSERT INTO people (id, display_name, created_at, revoked_at, origin, rev, updated_at) VALUES ('px','Via',1,999,'local',1,1)");
    const a = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string; claim: string };
    await chiama(router, "/api/auth/pair/approve", "POST", { body: { requestId: a.requestId } });
    const id = (db.query("SELECT id FROM devices").get() as { id: string }).id;
    const r = await chiama(router, `/api/auth/devices/${id}`, "PATCH", { body: { personId: "px" } });
    expect(r?.status).toBe(400);
  });

  test("rinominare continua a funzionare: i due gesti non si sono pestati", async () => {
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    const a = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string; claim: string };
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
    db.run(TASKS_DDL);
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
    const a = await (await chiama(router, "/api/auth/pair/request", "POST"))!.json() as { requestId: string; claim: string };
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
    db.run(TASKS_DDL);
    db.run("CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT, updated_at INTEGER)");
    for (const m of [...MIGRAZIONI, "084-people-orgs.sql", "085-share-links.sql"]) {
      db.run(readFileSync(join(RADICE, "server", "db", "migrations", m), "utf8"));
    }
    db.run("INSERT INTO tasks (id, text, status, project_id, created_at, updated_at) VALUES ('t1','x','todo', 'p-test', '2026-01-01', '2026-01-01')");
    return db;
  }

  test("a relay SPENTO non si conia più, ma si può ancora revocare", async () => {
    // Il buco che questo test chiude: `/api/auth/relay` diceva `enabled:false`
    // e il bottone spariva, mentre la rotta continuava a produrre link validi.
    // Un interruttore che nasconde il gesto senza toglierlo fa credere di aver
    // spento una cosa che è ancora accesa.
    const db = db085();
    const acceso = createAuthRouter(creaCtx(db).ctx);
    const creato = await (await chiama(acceso, "/api/auth/share-links", "POST", {
      body: { resourceType: "task", resourceId: "t1" },
    }))!.json() as { ref: string };

    const spento = createAuthRouter(creaCtx(db, { relay: false }).ctx);
    const rifiutato = await chiama(spento, "/api/auth/share-links", "POST", {
      body: { resourceType: "task", resourceId: "t1" },
    });
    expect(rifiutato?.status).toBe(409);
    expect((db.query("SELECT COUNT(*) AS n FROM share_links").get() as { n: number }).n).toBe(1);

    // Elencare e revocare restano raggiungibili: chi ha appena spento è
    // esattamente chi deve poter ritirare ciò che aveva già distribuito.
    expect((await chiama(spento, "/api/auth/share-links?resourceType=task&resourceId=t1"))?.status).toBe(200);
    expect((await chiama(spento, `/api/auth/share-links?ref=${creato.ref}`, "DELETE"))?.status).toBe(200);
    expect((db.query("SELECT revoked_at FROM share_links WHERE ref = ?").get(creato.ref) as { revoked_at: number | null })
      .revoked_at).not.toBeNull();
  });

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

describe("rotte auth · i membri dell'organizzazione", () => {
  function db084(): Database {
    const db = new Database(":memory:");
    db.run(TASKS_DDL);
    db.run("CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT, updated_at INTEGER)");
    for (const m of [...MIGRAZIONI, "084-people-orgs.sql"]) {
      db.run(readFileSync(join(RADICE, "server", "db", "migrations", m), "utf8"));
    }
    return db;
  }
  const orgDi = (db: Database) => (db.query("SELECT id FROM orgs LIMIT 1").get() as { id: string }).id;

  test("si invita per NOME, prima che esista un suo dispositivo", async () => {
    // È ORG-04 vista dal davanti: l'ordine naturale è invitare e poi collegarsi,
    // non aspettare che qualcuno compaia per poterlo nominare.
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    const org = orgDi(db);

    const r = await chiama(router, `/api/auth/orgs/${org}/members`, "POST", { body: { name: "Mircea" } });
    expect(r?.status).toBe(200);
    const { personId } = await r!.json() as { personId: string };

    const m = await (await chiama(router, `/api/auth/orgs/${org}/members`))!.json() as {
      members: Array<{ id: string; name: string; role: string; devices: number; owner: boolean }>
    };
    const nuovo = m.members.find((x) => x.id === personId)!;
    expect(nuovo.name).toBe("Mircea");
    // Chi entra NON amministra, e non possiede la macchina: due proprietà
    // diverse che un'unica riga sbagliata confonderebbe.
    expect(nuovo.role).toBe("member");
    expect(nuovo.owner).toBe(false);
    expect(nuovo.devices).toBe(0);
  });

  test("un membro dice quando si è fatto vivo l'ultima volta, non solo quanti ferri ha", async () => {
    // «Tre dispositivi» descrive uguale chi è online adesso e chi non apre
    // l'app da marzo. `lastSeenAt` è l'unica cosa che serve a chi guarda per
    // sapere con chi sta lavorando, ed è il dato su cui si costruisce la
    // presence dell'organizzazione.
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    const org = orgDi(db);
    const io = (db.query("SELECT person_id AS id FROM installation_owners").get() as { id: string }).id;

    type M = { id: string; devices: number; lastSeenAt: number | null };
    const leggi = async () => ((await (await chiama(router, `/api/auth/orgs/${org}/members`))!.json()) as { members: M[] })
      .members.find((x) => x.id === io)!;

    // Senza dispositivi vivi non si è visti: `null`, non zero. Zero sarebbe una
    // data — il 1970 — e ordinando per «ultimo visto» finirebbe in fondo
    // insieme a chi c'è stato davvero e molto tempo fa.
    expect((await leggi()).lastSeenAt).toBeNull();

    const quando = Date.now() - 60_000;
    db.query(
      "INSERT INTO devices (id, name, token_hash, created_at, last_seen_at, first_ip, revoked_at, role, person_id) VALUES (?, ?, ?, ?, ?, ?, NULL, 'member', ?)",
    ).run("dev-presenza", "Mac", "hash", quando, quando, "127.0.0.1", io);

    const dopo = await leggi();
    expect(dopo.devices).toBe(1);
    expect(dopo.lastSeenAt).toBe(quando);

    // Un dispositivo REVOCATO non tiene viva la presence: chi ha tolto la
    // fiducia a tutte le sue macchine non è «online da allora».
    db.query("UPDATE devices SET revoked_at = ? WHERE id = 'dev-presenza'").run(Date.now());
    expect((await leggi()).lastSeenAt).toBeNull();
  });

  test("il proprietario compare per primo, e non si può togliere", async () => {
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    const org = orgDi(db);
    const io = (db.query("SELECT person_id AS id FROM installation_owners").get() as { id: string }).id;

    const m = await (await chiama(router, `/api/auth/orgs/${org}/members`))!.json() as {
      members: Array<{ id: string; owner: boolean }>
    };
    expect(m.members[0]!.id).toBe(io);
    expect(m.members[0]!.owner).toBe(true);

    // Togliersi dalla propria organizzazione è l'unico gesto che lascerebbe la
    // macchina senza nessuno che la possiede.
    const r = await chiama(router, `/api/auth/orgs/${org}/members?personId=${io}`, "DELETE");
    expect(r?.status).toBe(400);
    expect(db.query("SELECT local_blocked_at FROM org_members WHERE person_id = ?").get(io))
      .toEqual({ local_blocked_at: null });
  });

  test("togliere qualcuno scrive il blocco LOCALE, non la revoca remota", async () => {
    // La differenza è tutta qui: `revoked_at` è del piano di controllo e il
    // primo aggiornamento lo riscrive, `local_blocked_at` è tuo e nessuna
    // sincronizzazione lo tocca. Scrivere nella colonna sbagliata vorrebbe dire
    // vedere la propria revoca annullarsi da sola lunedì mattina.
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    const org = orgDi(db);
    const { personId } = await (await chiama(router, `/api/auth/orgs/${org}/members`, "POST", {
      body: { name: "Chi se ne va" },
    }))!.json() as { personId: string };

    expect((await chiama(router, `/api/auth/orgs/${org}/members?personId=${personId}`, "DELETE"))?.status).toBe(200);

    const riga = db.query("SELECT revoked_at, local_blocked_at FROM org_members WHERE person_id = ?")
      .get(personId) as { revoked_at: number | null; local_blocked_at: number | null };
    expect(riga.revoked_at).toBeNull();
    expect(riga.local_blocked_at).not.toBeNull();

    // E la sincronizzazione che ripristina la riga remota non lo scioglie.
    db.run("UPDATE org_members SET revoked_at = NULL, rev = rev + 1 WHERE person_id = ?", [personId]);
    expect((db.query("SELECT local_blocked_at FROM org_members WHERE person_id = ?")
      .get(personId) as { local_blocked_at: number | null }).local_blocked_at).not.toBeNull();
  });

  test("riaggiungere qualcuno gli toglie il blocco: altrimenti «è dentro e non vede niente»", async () => {
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    const org = orgDi(db);
    const { personId } = await (await chiama(router, `/api/auth/orgs/${org}/members`, "POST", {
      body: { name: "Torna" },
    }))!.json() as { personId: string };
    await chiama(router, `/api/auth/orgs/${org}/members?personId=${personId}`, "DELETE");

    await chiama(router, `/api/auth/orgs/${org}/members`, "POST", { body: { personId } });

    const m = await (await chiama(router, `/api/auth/orgs/${org}/members`))!.json() as {
      members: Array<{ id: string; blocked: boolean }>
    };
    expect(m.members.find((x) => x.id === personId)!.blocked).toBe(false);
  });

  test("una persona già nota si riusa invece di duplicarla", async () => {
    // Due persone che sono una persona sola dividono in due ciò che è stato
    // condiviso con loro, e la divisione è silenziosa.
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    const org = orgDi(db);
    db.run("INSERT INTO people (id, display_name, created_at, origin, rev, updated_at) VALUES ('p9','Nota',1,'local',1,1)");

    await chiama(router, `/api/auth/orgs/${org}/members`, "POST", { body: { personId: "p9" } });
    await chiama(router, `/api/auth/orgs/${org}/members`, "POST", { body: { personId: "p9" } });

    expect((db.query("SELECT COUNT(*) AS n FROM org_members WHERE person_id = 'p9'").get() as { n: number }).n).toBe(1);
    expect((db.query("SELECT COUNT(*) AS n FROM people").get() as { n: number }).n).toBe(2);
  });

  test("senza nome e senza persona non si inventa un membro vuoto", async () => {
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    const org = orgDi(db);
    expect((await chiama(router, `/api/auth/orgs/${org}/members`, "POST", { body: { name: "   " } }))?.status).toBe(400);
    expect((await chiama(router, `/api/auth/orgs/${org}/members`, "POST", { body: { personId: "boh" } }))?.status).toBe(404);
    expect((await chiama(router, `/api/auth/orgs/nonesiste/members`, "POST", { body: { name: "X" } }))?.status).toBe(404);
    expect((db.query("SELECT COUNT(*) AS n FROM people").get() as { n: number }).n).toBe(1);
  });

  test("riaggiungere NON cancella la revoca del piano di controllo", async () => {
    // Le due revoche non sono intercambiabili: `local_blocked_at` è tua e la
    // sincronizzazione non la tocca, `revoked_at` è della licenza. Azzerarle
    // insieme — com'era — voleva dire che il gesto più innocuo
    // dell'interfaccia, riaggiungere qualcuno, scavalcava in silenzio una
    // revoca decisa altrove.
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    const org = orgDi(db);
    const { personId } = await (await chiama(router, `/api/auth/orgs/${org}/members`, "POST", {
      body: { name: "Revocato dalla licenza" },
    }))!.json() as { personId: string };

    // Il piano di controllo lo revoca, e tu localmente lo togli.
    db.run("UPDATE org_members SET revoked_at = 111 WHERE person_id = ?", [personId]);
    await chiama(router, `/api/auth/orgs/${org}/members?personId=${personId}`, "DELETE");

    const r = await chiama(router, `/api/auth/orgs/${org}/members`, "POST", { body: { personId } });
    expect(await r!.json()).toEqual({ ok: true, personId, revocataAltrove: true });

    const riga = db.query("SELECT revoked_at, local_blocked_at FROM org_members WHERE person_id = ?")
      .get(personId) as { revoked_at: number | null; local_blocked_at: number | null };
    expect(riga.revoked_at, "la revoca della licenza deve restare").toBe(111);
    expect(riga.local_blocked_at, "il blocco locale invece si toglie").toBeNull();
  });

  test("chi hai tolto sparisce dalla rubrica dei destinatari", async () => {
    // Il ramo delle organizzazioni guardava già il blocco locale, quello delle
    // persone no: una persona aggiunta e poi tolta restava per sempre fra i
    // destinatari, e condividere con lei sarebbe riuscito.
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    const org = orgDi(db);
    const { personId } = await (await chiama(router, `/api/auth/orgs/${org}/members`, "POST", {
      body: { name: "Passato di qui" },
    }))!.json() as { personId: string };

    const rubrica = async () => JSON.stringify(await (await chiama(router, "/api/auth/subjects"))!.json());
    expect(await rubrica(), "finché c'è, è un destinatario").toContain(personId);

    await chiama(router, `/api/auth/orgs/${org}/members?personId=${personId}`, "DELETE");
    expect(await rubrica(), "tolto, non deve più comparire").not.toContain(personId);

    // Ma chi non è in NESSUN gruppo resta un destinatario legittimo: è il caso
    // della persona nata approvando un dispositivo con «è di un'altra persona».
    db.run("INSERT INTO people (id, display_name, created_at, origin, rev, updated_at) VALUES ('senza','Senza gruppo',1,'local',1,1)");
    expect(await rubrica(), "nessuna appartenenza non vuol dire esclusa").toContain("senza");
  });

  test("i membri si contano allo stesso modo dalle due rotte", async () => {
    // Erano due definizioni diverse sulla stessa organizzazione: dopo aver
    // tolto qualcuno, `/api/auth/me` diceva «siete in due» e la rubrica non
    // offriva il gruppo, perché per lei eri di nuovo solo.
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    const org = orgDi(db);
    const { personId } = await (await chiama(router, `/api/auth/orgs/${org}/members`, "POST", {
      body: { name: "Uno di troppo" },
    }))!.json() as { personId: string };

    const contaMe = async () =>
      ((await (await chiama(router, "/api/auth/me"))!.json()) as { org: { members: number } }).org.members;
    const nellaRubrica = async () =>
      JSON.stringify(await (await chiama(router, "/api/auth/subjects"))!.json()).includes(org);

    expect(await contaMe()).toBe(2);
    expect(await nellaRubrica(), "due membri: il gruppo si può nominare").toBe(true);

    await chiama(router, `/api/auth/orgs/${org}/members?personId=${personId}`, "DELETE");
    expect(await contaMe(), "tolto uno, si torna a uno").toBe(1);
    expect(await nellaRubrica(), "e il gruppo di uno non si nomina").toBe(false);
  });

  test("su uno schema senza la 084 la rotta tace invece di esplodere", async () => {
    // Una installazione che non ha ancora fatto la migration non deve vedere un
    // 500: deve vedere che qui non c'è niente.
    const db = dbFresco();
    const router = createAuthRouter(creaCtx(db).ctx);
    const r = await chiama(router, "/api/auth/orgs/x/members");
    expect(r?.status).toBe(200);
    expect(await r!.json()).toEqual({ members: [] });
  });
});

describe("rotte auth · le organizzazioni: crearle, cancellarle, e chi comanda", () => {
  function db084(): Database {
    const db = new Database(":memory:");
    db.run(TASKS_DDL);
    db.run("CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT, updated_at INTEGER)");
    for (const m of [...MIGRAZIONI, "084-people-orgs.sql"]) {
      db.run(readFileSync(join(RADICE, "server", "db", "migrations", m), "utf8"));
    }
    return db;
  }
  const miaOrg = (db: Database) => (db.query("SELECT org_id AS id FROM installation").get() as { id: string }).id;
  const io = (db: Database) =>
    (db.query("SELECT person_id AS id FROM installation_owners WHERE is_default = 1").get() as { id: string }).id;

  type Gruppo = { id: string; name: string; members: number; role: string | null; installation: boolean };
  const elenco = async (router: ReturnType<typeof createAuthRouter>) =>
    ((await (await chiama(router, "/api/auth/orgs"))!.json()) as { orgs: Gruppo[] }).orgs;

  test("`/api/auth/me` segue `installation`, non la riga più vecchia della tabella", async () => {
    // La trappola prima di qualunque seconda organizzazione: `ORDER BY
    // created_at LIMIT 1` risponde giusto per caso finché ce n'è una, e alla
    // seconda l'installazione cambia identità in silenzio — altro nome
    // nell'intestazione, altri membri, nessun errore da nessuna parte.
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    db.run("INSERT INTO orgs (id, name, created_at, origin, rev, updated_at) VALUES ('vecchia','Arrivata prima',1,'local',0,1)");

    const me = await (await chiama(router, "/api/auth/me"))!.json() as { org: { id: string; name: string } };
    expect(me.org.id).toBe(miaOrg(db));
    expect(me.org.name).not.toBe("Arrivata prima");
  });

  test("si crea un gruppo, e nasce con un proprietario VIVO dentro", async () => {
    // Un gruppo senza nessun proprietario è un gruppo che nessuno può
    // amministrare, e da cui si esce solo con una UPDATE a mano.
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);

    const r = await chiama(router, "/api/auth/orgs", "POST", { body: { name: "Studio" } });
    expect(r?.status).toBe(200);
    const { id } = await r!.json() as { id: string };

    const g = (await elenco(router)).find((x) => x.id === id)!;
    expect(g.name).toBe("Studio");
    expect(g.role, "chi lo crea lo amministra").toBe("owner");
    expect(g.members).toBe(1);
    expect(g.installation, "non è il gruppo dell'installazione: quello resta uno").toBe(false);
    expect((await elenco(router)).find((x) => x.installation)!.id).toBe(miaOrg(db));

    expect((db.query("SELECT role FROM org_members WHERE org_id = ?").get(id) as { role: string }).role).toBe("owner");
  });

  test("senza nome non si crea un gruppo senza nome", async () => {
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    expect((await chiama(router, "/api/auth/orgs", "POST", { body: { name: "   " } }))?.status).toBe(400);
    expect((db.query("SELECT COUNT(*) AS n FROM orgs").get() as { n: number }).n).toBe(1);
  });

  test("cancellare SCRIVE `revoked_at`, e il gruppo sparisce da elenco e rubrica", async () => {
    // La colonna era letta in quattro punti e scritta da nessuno: un
    // interruttore di sicurezza che nessun gesto poteva premere.
    const db = db084();
    const { ctx } = creaCtx(db);
    const chiuse: string[] = [];
    (ctx as { closeDeviceSockets?: (id: string) => void }).closeDeviceSockets = (id) => { chiuse.push(id); };
    const router = createAuthRouter(ctx);

    const { id } = await (await chiama(router, "/api/auth/orgs", "POST", { body: { name: "Da chiudere" } }))!.json() as { id: string };
    const { personId } = await (await chiama(router, `/api/auth/orgs/${id}/members`, "POST", { body: { name: "Socio" } }))!.json() as { personId: string };
    db.run("INSERT INTO devices (id, name, token_hash, created_at, role, person_id) VALUES ('d-socio','Telefono','h',1,'guest',?)", [personId]);

    expect(JSON.stringify(await (await chiama(router, "/api/auth/subjects"))!.json()), "in due, il gruppo si può nominare").toContain(id);

    const r = await chiama(router, `/api/auth/orgs/${id}`, "DELETE");
    expect(r?.status).toBe(200);
    expect((db.query("SELECT revoked_at FROM orgs WHERE id = ?").get(id) as { revoked_at: number | null }).revoked_at).not.toBeNull();
    expect((await elenco(router)).some((x) => x.id === id)).toBe(false);
    expect(JSON.stringify(await (await chiama(router, "/api/auth/subjects"))!.json())).not.toContain(id);
    // Una socket aperta porta i principali timbrati all'upgrade e non li
    // rilegge: senza chiuderla la revoca vale sull'HTTP e non su ciò che
    // continua ad arrivare dal vivo.
    expect(chiuse, "i dispositivi dei membri vanno staccati").toContain("d-socio");
  });

  test("il gruppo dell'installazione non si cancella", async () => {
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    const r = await chiama(router, `/api/auth/orgs/${miaOrg(db)}`, "DELETE");
    expect(r?.status).toBe(400);
    expect((db.query("SELECT revoked_at FROM orgs WHERE id = ?").get(miaOrg(db)) as { revoked_at: number | null }).revoked_at).toBeNull();
  });

  test("cancellare un gruppo che non c'è è un 404, non un ok silenzioso", async () => {
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    expect((await chiama(router, "/api/auth/orgs/nonesiste", "DELETE"))?.status).toBe(404);
  });

  test("PATCH sui MEMBRI cambia il ruolo — non finisce nel ramo che rinomina il gruppo", async () => {
    // L'ordine delle rotte: `startsWith('/api/auth/orgs/')` non sa dove finisce
    // un id, quindi la PATCH ai membri cadeva nel ramo del rinomina, che faceva
    // una UPDATE su `orgs` con id `<id>/members` — zero righe toccate e un
    // `ok: true` in risposta. Il gesto non faceva niente e diceva di sì.
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    const org = miaOrg(db);
    const nomePrima = (db.query("SELECT name FROM orgs WHERE id = ?").get(org) as { name: string }).name;
    const { personId } = await (await chiama(router, `/api/auth/orgs/${org}/members`, "POST", { body: { name: "Da promuovere" } }))!.json() as { personId: string };

    const r = await chiama(router, `/api/auth/orgs/${org}/members`, "PATCH", { body: { personId, role: "admin", name: "NOME RUBATO" } });
    expect(r?.status).toBe(200);
    expect((db.query("SELECT role FROM org_members WHERE person_id = ?").get(personId) as { role: string }).role).toBe("admin");
    expect((db.query("SELECT name FROM orgs WHERE id = ?").get(org) as { name: string }).name, "il nome del gruppo non si tocca da qui").toBe(nomePrima);

    // E il ruolo esce anche dalla rotta che lo legge: una colonna scritta che
    // nessuno rilegge è indistinguibile da una non scritta.
    const m = await (await chiama(router, `/api/auth/orgs/${org}/members`))!.json() as { members: Array<{ id: string; role: string }> };
    expect(m.members.find((x) => x.id === personId)!.role).toBe("admin");
  });

  test("un ruolo che il database non conosce si rifiuta prima di provarci", async () => {
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    const org = miaOrg(db);
    const { personId } = await (await chiama(router, `/api/auth/orgs/${org}/members`, "POST", { body: { name: "X" } }))!.json() as { personId: string };
    expect((await chiama(router, `/api/auth/orgs/${org}/members`, "PATCH", { body: { personId, role: "superuser" } }))?.status).toBe(400);
    expect((await chiama(router, `/api/auth/orgs/${org}/members`, "PATCH", { body: { personId: "chi?", role: "admin" } }))?.status).toBe(404);
    expect((db.query("SELECT role FROM org_members WHERE person_id = ?").get(personId) as { role: string }).role).toBe("member");
  });

  test("l'ULTIMO proprietario non si retrocede; il penultimo sì", async () => {
    // Zero proprietari vivi = gruppo immodificabile per chiunque. Il controllo
    // positivo accanto serve a dimostrare che il rifiuto è la REGOLA e non
    // l'incapacità della rotta di promuovere chicchessia.
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    const org = miaOrg(db);
    const me = io(db);

    expect((await chiama(router, `/api/auth/orgs/${org}/members`, "PATCH", { body: { personId: me, role: "member" } }))?.status).toBe(400);
    expect((db.query("SELECT role FROM org_members WHERE person_id = ?").get(me) as { role: string }).role).toBe("owner");

    const { personId } = await (await chiama(router, `/api/auth/orgs/${org}/members`, "POST", { body: { name: "Secondo padrone" } }))!.json() as { personId: string };
    expect((await chiama(router, `/api/auth/orgs/${org}/members`, "PATCH", { body: { personId, role: "owner" } }))?.status).toBe(200);
    expect((await chiama(router, `/api/auth/orgs/${org}/members`, "PATCH", { body: { personId: me, role: "member" } }))?.status).toBe(200);
    expect((db.query("SELECT role FROM org_members WHERE person_id = ?").get(me) as { role: string }).role).toBe("member");
  });

  test("un `member` non amministra il gruppo di qualcun altro, e nel proprio sì", async () => {
    // È l'unico potere che `org_members.role` ha, ed è quello che la 084 le
    // assegna. Con una sola organizzazione «proprietario della macchina» e
    // «proprietario del gruppo» coincidevano per caso: alla seconda, no.
    //
    // Il controllo positivo in coda non è cortesia: senza, tre 403 di fila
    // sarebbero indistinguibili da una rotta che rifiuta sempre.
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    const me = io(db);
    db.run("INSERT INTO people (id, display_name, created_at, origin, rev, updated_at) VALUES ('estraneo','Estraneo',1,'local',0,1)");
    db.run("INSERT INTO orgs (id, name, created_at, origin, rev, updated_at) VALUES ('altrui','Gruppo altrui',9,'local',0,9)");
    db.run("INSERT INTO org_members (org_id, person_id, role, joined_at, rev, updated_at) VALUES ('altrui','estraneo','owner',9,0,9)");
    db.run("INSERT INTO org_members (org_id, person_id, role, joined_at, rev, updated_at) VALUES ('altrui',?,'member',9,0,9)", [me]);

    expect((await chiama(router, "/api/auth/orgs/altrui/members", "POST", { body: { name: "Intruso" } }))?.status).toBe(403);
    expect((await chiama(router, "/api/auth/orgs/altrui/members?personId=estraneo", "DELETE"))?.status).toBe(403);
    expect((await chiama(router, "/api/auth/orgs/altrui/members", "PATCH", { body: { personId: "estraneo", role: "member" } }))?.status).toBe(403);
    expect((await chiama(router, "/api/auth/orgs/altrui", "PATCH", { body: { name: "Mio adesso" } }))?.status).toBe(403);
    expect((await chiama(router, "/api/auth/orgs/altrui", "DELETE"))?.status).toBe(403);

    expect((db.query("SELECT name FROM orgs WHERE id = 'altrui'").get() as { name: string }).name).toBe("Gruppo altrui");
    expect((db.query("SELECT COUNT(*) AS n FROM org_members WHERE org_id = 'altrui'").get() as { n: number }).n).toBe(2);
    expect((db.query("SELECT revoked_at FROM orgs WHERE id = 'altrui'").get() as { revoked_at: number | null }).revoked_at).toBeNull();

    // E nel PROPRIO gruppo gli stessi gesti riescono.
    const mio = miaOrg(db);
    expect((await chiama(router, `/api/auth/orgs/${mio}/members`, "POST", { body: { name: "Benvenuto" } }))?.status).toBe(200);
    expect((await chiama(router, `/api/auth/orgs/${mio}`, "PATCH", { body: { name: "Casa mia" } }))?.status).toBe(200);
    expect((db.query("SELECT name FROM orgs WHERE id = ?").get(mio) as { name: string }).name).toBe("Casa mia");
  });

  test("chi è stato TOLTO dal gruppo non lo amministra più", async () => {
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    db.run("INSERT INTO people (id, display_name, created_at, origin, rev, updated_at) VALUES ('estraneo','Estraneo',1,'local',0,1)");
    db.run("INSERT INTO orgs (id, name, created_at, origin, rev, updated_at) VALUES ('altrui','Gruppo altrui',9,'local',0,9)");
    db.run("INSERT INTO org_members (org_id, person_id, role, joined_at, rev, updated_at) VALUES ('altrui','estraneo','owner',9,0,9)");
    db.run("INSERT INTO org_members (org_id, person_id, role, joined_at, rev, updated_at) VALUES ('altrui',?,'admin',9,0,9)", [io(db)]);

    expect((await chiama(router, "/api/auth/orgs/altrui/members", "POST", { body: { name: "Uno" } }))?.status, "da admin si invita").toBe(200);
    db.run("UPDATE org_members SET local_blocked_at = 7 WHERE org_id = 'altrui' AND person_id = ?", [io(db)]);
    expect((await chiama(router, "/api/auth/orgs/altrui/members", "POST", { body: { name: "Due" } }))?.status, "tolto, non più").toBe(403);
  });

  test("un gruppo revocato non si amministra più", async () => {
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    const { id } = await (await chiama(router, "/api/auth/orgs", "POST", { body: { name: "Effimero" } }))!.json() as { id: string };
    expect((await chiama(router, `/api/auth/orgs/${id}`, "DELETE"))?.status).toBe(200);
    expect((await chiama(router, `/api/auth/orgs/${id}/members`, "POST", { body: { name: "Tardi" } }))?.status).toBe(404);
    // Già revocato = sconosciuto, la stessa risposta della POST sui membri: due
    // rotte che guardano la stessa riga non possono dire una «non c'è» e
    // l'altra «fatto», o il secondo clic sembra riuscito.
    expect((await chiama(router, `/api/auth/orgs/${id}`, "DELETE"))?.status, "già revocato: non si revoca due volte").toBe(404);

    // ── E RINOMINARE, che è lo stesso potere.
    //
    // Il ruolo da solo non basta: revocare un gruppo non tocca le sue righe in
    // `org_members`, quindi `canAdministerOrg` restava `true` e la PATCH
    // rispondeva `ok: true` scrivendo il nome DENTRO la riga revocata — mentre
    // la DELETE e le tre rotte dei membri sullo stesso id dicevano
    // «organizzazione sconosciuta». Lo stato è raggiungibile dalla UI vera:
    // `IdentitySection` carica i gruppi una volta al montaggio, quindi una
    // seconda finestra rinominava un gruppo cancellato altrove.
    const prima = (db.query("SELECT name FROM orgs WHERE id = ?").get(id) as { name: string }).name;
    expect((await chiama(router, `/api/auth/orgs/${id}`, "PATCH", { body: { name: "Resuscitato" } }))?.status).toBe(404);
    expect((db.query("SELECT name FROM orgs WHERE id = ?").get(id) as { name: string }).name, "il nome non si scrive in una riga revocata").toBe(prima);

    // La LETTURA dice la stessa cosa delle scritture. Era l'unica delle quattro
    // rotte su `/members` a non chiederlo: rispondeva 200 con la rubrica intera
    // di un gruppo che `GET /api/auth/orgs` non elencava nemmeno.
    const g = await chiama(router, `/api/auth/orgs/${id}/members`);
    expect(g?.status).toBe(404);
    expect(JSON.stringify(await g!.json()), "e non la rubrica di un morto").not.toContain("Effimero");

    // Il controllo POSITIVO: gli stessi tre gesti sul gruppo VIVO riescono, o
    // tre 404 di fila sarebbero indistinguibili da rotte che rifiutano sempre.
    const vivo = miaOrg(db);
    expect((await chiama(router, `/api/auth/orgs/${vivo}`, "PATCH", { body: { name: "Ancora qui" } }))?.status).toBe(200);
    expect((db.query("SELECT name FROM orgs WHERE id = ?").get(vivo) as { name: string }).name).toBe("Ancora qui");
    expect((await chiama(router, `/api/auth/orgs/${vivo}/members`))?.status).toBe(200);
  });

  test("i membri di un gruppo che non è mai esistito sono un 404, non un elenco vuoto", async () => {
    // «Non esiste» e «non ha membri» sono due risposte diverse, e la DELETE su
    // un id inventato dice già 404: se la GET rispondesse 200 con `[]`, la
    // stessa domanda avrebbe due risposte a seconda del verbo.
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    expect((await chiama(router, "/api/auth/orgs/mai-esistito/members"))?.status).toBe(404);
    expect((await chiama(router, `/api/auth/orgs/${miaOrg(db)}/members`))?.status, "e su un gruppo vero, 200").toBe(200);
  });

  test("su uno schema più vecchio della 084 le rotte tacciono invece di esplodere", async () => {
    const db = dbFresco();
    const router = createAuthRouter(creaCtx(db).ctx);
    const r = await chiama(router, "/api/auth/orgs");
    expect(r?.status).toBe(200);
    expect(await r!.json()).toEqual({ orgs: [] });
    expect((await chiama(router, "/api/auth/orgs", "POST", { body: { name: "X" } }))?.status).toBe(400);
    expect((await chiama(router, "/api/auth/orgs/x", "DELETE"))?.status).toBe(400);
    expect((await chiama(router, "/api/auth/orgs/x/members", "PATCH", { body: { personId: "p", role: "admin" } }))?.status).toBe(400);
    // Rinominare è una SCRITTURA e rifiuta come le altre — non 403 «non
    // amministri», che su una macchina non ancora migrata è una diagnosi
    // sbagliata: non è un permesso che manca, è la tabella.
    expect((await chiama(router, "/api/auth/orgs/x", "PATCH", { body: { name: "Y" } }))?.status).toBe(400);
    // Le LETTURE invece tacciono, come fa `GET /api/auth/orgs` qui sopra.
    const m = await chiama(router, "/api/auth/orgs/x/members");
    expect(m?.status).toBe(200);
    expect(await m!.json()).toEqual({ members: [] });
  });
});

/**
 * La rubrica e il cancello devono rispondere UGUALE.
 *
 * `GET /api/auth/subjects` è il menu da cui il pannello sceglie;
 * `POST /api/auth/shares` è il gesto vero. Erano due implementazioni della
 * stessa domanda — una `SELECT` con un `NOT EXISTS` scritto dentro la rubrica,
 * e `motivoRifiutoSoggetto` dentro il cancello — e su un caso non concordavano:
 * la persona TOLTA da ogni gruppo spariva dal menu e la POST sullo stesso id
 * rispondeva `200`. Il verso in cui una divergenza così sbaglia è il peggiore:
 * non solleva niente, CONCEDE.
 */
describe("rotte auth · la rubrica e il cancello non possono divergere", () => {
  function db084(): Database {
    const db = new Database(":memory:");
    db.run(TASKS_DDL);
    db.run("CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT, updated_at INTEGER)");
    for (const m of [...MIGRAZIONI, "084-people-orgs.sql"]) {
      db.run(readFileSync(join(RADICE, "server", "db", "migrations", m), "utf8"));
    }
    db.run("INSERT INTO tasks (id, text, status, project_id, created_at, updated_at) VALUES ('t1','La scheda','todo', 'p-test', '2026-01-01', '2026-01-01')");
    return db;
  }
  const miaOrg = (db: Database) => (db.query("SELECT org_id AS id FROM installation").get() as { id: string }).id;

  /** Una persona MEMBRO del gruppo di questa installazione. */
  function collega(db: Database, id: string): string {
    db.run("INSERT INTO people (id, display_name, created_at, origin, rev, updated_at) VALUES (?,?,1,'local',0,1)", [id, id]);
    db.run("INSERT INTO org_members (org_id, person_id, role, joined_at, rev, updated_at) VALUES (?,?, 'member',1,0,1)",
      [miaOrg(db), id]);
    return id;
  }

  const inRubrica = async (router: ReturnType<typeof createAuthRouter>, id: string) => {
    const b = await (await chiama(router, "/api/auth/subjects"))!.json() as
      { subjects: Array<{ subjectType: string; subjectId: string }> };
    return b.subjects.some((s) => s.subjectType === "person" && s.subjectId === id);
  };

  const condividi = (router: ReturnType<typeof createAuthRouter>, id: string) =>
    chiama(router, "/api/auth/shares", "POST", {
      body: { resourceType: "task", resourceId: "t1", subjectType: "person", subjectId: id },
    });

  test("un membro vivo: la rubrica lo offre E il cancello lo accetta", async () => {
    // Il controllo POSITIVO. Senza, un `subjects` che restituisse sempre vuoto
    // e un cancello che rifiutasse sempre passerebbero il caso qui sotto: è
    // questo test che dimostra che il canale di osservazione funziona.
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    const p = collega(db, "viva");

    expect(await inRubrica(router, p), "la rubrica deve offrirla").toBe(true);
    expect((await condividi(router, p))?.status, "il cancello deve accettarla").toBe(200);
    expect(db.query("SELECT COUNT(*) c FROM grants").get()).toEqual({ c: 1 });
  });

  test("TOLTA da ogni gruppo: sparisce dalla rubrica E il cancello la rifiuta", async () => {
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    const p = collega(db, "tolta");
    // Esattamente ciò che scrive `DELETE /api/auth/orgs/:id/members`.
    db.run("UPDATE org_members SET local_blocked_at = 99 WHERE person_id = ?", [p]);

    expect(await inRubrica(router, p), "la rubrica non deve più offrirla").toBe(false);
    const r = await condividi(router, p);
    // Il difetto che questa riga fissa: qui rispondeva 200 e scriveva la
    // concessione, mandando la scheda a qualcuno che avevi tolto.
    expect(r?.status, "il cancello deve rifiutarla come fa la rubrica").toBe(400);
    expect((await r!.json() as { error: string }).error).toBe("person_removed");
    expect(db.query("SELECT COUNT(*) c FROM grants").get()).toEqual({ c: 0 });
  });

  test("il rifiuto è un CODICE, non una frase italiana", async () => {
    // `ShareControl` fa `setErrore(body.error)` e lo stampa tale e quale: una
    // frase italiana qui compariva sotto un titolo inglese.
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    db.run("INSERT INTO devices (id, name, token_hash, created_at, role) VALUES ('mio','Mio','h',1,'owner')");

    const r = await chiama(router, "/api/auth/shares", "POST", {
      body: { resourceType: "task", resourceId: "t1", subjectType: "device", subjectId: "mio" },
    });
    expect(r?.status).toBe(400);
    expect((await r!.json() as { error: string }).error).toBe("device_not_guest");
  });
});


/**
 * `people.revoked_at` era LETTA in otto punti e SCRITTA in nessuno.
 *
 * La stessa forma che `orgs.revoked_at` aveva prima della DELETE dei gruppi: un
 * interruttore di sicurezza che nessun gesto poteva premere — e la 084 lo dice
 * di sé stessa, «una colonna che sembra un interruttore di sicurezza e non è
 * cablata a niente è peggio della sua assenza».
 *
 * Il buco vero che lasciava aperto: una persona INVITATA per nome — creata da
 * `POST /orgs/:id/members {name}` prima che collegasse qualcosa — e poi tolta
 * restava una riga che nessun gesto poteva più toccare. Fuori dalla rubrica,
 * fuori dall'elenco dei membri, fuori dai principali, e dentro il database per
 * sempre: un errore di battitura era definitivo.
 *
 * Il gesto è SEPARATO da «togli dal gruppo», e i due test in fondo dicono
 * perché: fonderli renderebbe impossibile rimettere dentro qualcuno, e
 * cancellare qualcuno ancora attaccato a qualcosa gli toglierebbe l'accesso in
 * silenzio.
 */
describe("rotte auth · cancellare una persona dalla rubrica", () => {
  function db084(): Database {
    const db = new Database(":memory:");
    db.run(TASKS_DDL);
    db.run("CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT, updated_at INTEGER)");
    for (const m of [...MIGRAZIONI, "084-people-orgs.sql"]) {
      db.run(readFileSync(join(RADICE, "server", "db", "migrations", m), "utf8"));
    }
    return db;
  }
  const miaOrg = (db: Database) => (db.query("SELECT org_id AS id FROM installation").get() as { id: string }).id;
  const revocaDi = (db: Database, pid: string) =>
    (db.query("SELECT revoked_at FROM people WHERE id = ?").get(pid) as { revoked_at: number | null }).revoked_at;

  /** Invita per nome, come fa la schermata: la persona NASCE qui. */
  async function invita(router: ReturnType<typeof createAuthRouter>, org: string, nome: string): Promise<string> {
    const r = await chiama(router, `/api/auth/orgs/${org}/members`, "POST", { body: { name: nome } });
    return (await r!.json() as { personId: string }).personId;
  }
  const togliDalGruppo = (router: ReturnType<typeof createAuthRouter>, org: string, pid: string) =>
    chiama(router, `/api/auth/orgs/${org}/members?personId=${encodeURIComponent(pid)}`, "DELETE");
  const cancella = (router: ReturnType<typeof createAuthRouter>, pid: string) =>
    chiama(router, `/api/auth/people/${encodeURIComponent(pid)}`, "DELETE");

  test("una persona tolta dai gruppi si cancella, e la colonna viene SCRITTA", async () => {
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    const org = miaOrg(db);
    const pid = await invita(router, org, "Errore Di Battitura");
    expect(revocaDi(db, pid), "appena invitata è viva").toBeNull();

    await togliDalGruppo(router, org, pid);
    expect((await cancella(router, pid))?.status).toBe(200);
    expect(revocaDi(db, pid), "la lapide si scrive").not.toBeNull();
  });

  test("cancellata, sparisce dalla rubrica dei destinatari", async () => {
    // La prova che la colonna non è scritta a vuoto: gli otto punti che la
    // LEGGONO cambiano risposta. Qui si guarda il primo — se `revoked_at`
    // restasse `NULL`, la persona sarebbe ancora offerta.
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    const org = miaOrg(db);
    const pid = await invita(router, org, "Da Cancellare");
    const nella = async () => {
      const b = await (await chiama(router, "/api/auth/subjects"))!.json() as
        { subjects: Array<{ subjectType: string; subjectId: string }> };
      return b.subjects.some((s) => s.subjectType === "person" && s.subjectId === pid);
    };
    expect(await nella(), "prima c'è").toBe(true);

    await togliDalGruppo(router, org, pid);
    await cancella(router, pid);
    expect(await nella(), "dopo non c'è più").toBe(false);
  });

  test("il secondo clic dice «non c'è», non «fatto»", async () => {
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    const org = miaOrg(db);
    const pid = await invita(router, org, "Una Volta Sola");
    await togliDalGruppo(router, org, pid);
    await cancella(router, pid);

    const r = await cancella(router, pid);
    expect(r?.status).toBe(404);
    expect((await r!.json() as { error: string }).error).toBe("unknown_person");
  });

  test("chi è ancora in un gruppo NON si cancella", async () => {
    // Cancellarla le toglierebbe in silenzio ciò che a quel gruppo era stato
    // condiviso: `resolvePrincipals` scarta la persona appena la colonna c'è.
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    const pid = await invita(router, miaOrg(db), "Ancora Dentro");

    const r = await cancella(router, pid);
    expect(r?.status).toBe(409);
    expect((await r!.json() as { error: string }).error).toBe("still_a_member");
    expect(revocaDi(db, pid)).toBeNull();
  });

  test("chi ha ancora un DISPOSITIVO vivo non si cancella", async () => {
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    const org = miaOrg(db);
    const pid = await invita(router, org, "Ha Un Telefono");
    db.run("INSERT INTO devices (id, name, token_hash, created_at, role, person_id) VALUES ('tel','Telefono','h',1,'guest',?)",
      [pid]);
    await togliDalGruppo(router, org, pid);

    const r = await cancella(router, pid);
    expect(r?.status).toBe(409);
    expect((await r!.json() as { error: string }).error).toBe("still_has_devices");
    expect(revocaDi(db, pid)).toBeNull();

    // Revocato il dispositivo, il gesto passa: il rifiuto era una condizione,
    // non un divieto.
    db.run("UPDATE devices SET revoked_at = 5 WHERE id = 'tel'");
    expect((await cancella(router, pid))?.status).toBe(200);
    expect(revocaDi(db, pid)).not.toBeNull();
  });

  test("il proprietario dell'installazione non si cancella MAI", async () => {
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    const mio = (db.query("SELECT person_id AS id FROM installation_owners").get() as { id: string }).id;

    const r = await cancella(router, mio);
    expect(r?.status).toBe(400);
    expect((await r!.json() as { error: string }).error).toBe("cannot_remove_self");
    expect(revocaDi(db, mio)).toBeNull();
  });

  test("togliere dal gruppo NON cancella: rimetterla dentro deve restare possibile", async () => {
    // I due gesti restano due. Fonderli sembrerebbe una semplificazione e
    // renderebbe irreversibile il gesto più reversibile che c'è.
    const db = db084();
    const router = createAuthRouter(creaCtx(db).ctx);
    const org = miaOrg(db);
    const pid = await invita(router, org, "Torna Indietro");
    await togliDalGruppo(router, org, pid);
    expect(revocaDi(db, pid), "togliere dal gruppo non scrive la lapide").toBeNull();

    const r = await chiama(router, `/api/auth/orgs/${org}/members`, "POST", { body: { personId: pid } });
    expect(r?.status, "e rimetterla dentro riesce").toBe(200);
  });
});
