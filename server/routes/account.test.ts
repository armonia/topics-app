/**
 * La rotta dell'account non è un cancello, e questo file lo fissa.
 *
 * Il modo in cui una rotta del genere si guasta è sempre lo stesso: qualcuno
 * decide che «il servizio non risponde» è un errore del server, e da quel
 * momento un'interfaccia che chiede «ho un account?» riceve un `5xx` —
 * indistinguibile, per chi guarda, da una macchina rotta. Qui la `GET` risponde
 * `200` in ogni caso, non fa MAI una richiesta in uscita, e nessun ramo di
 * questa rotta produce uno stato ≥ 500 (c'è un test che li percorre tutti).
 *
 * L'altra cosa che difende è l'invariante di ORG-08 vista dal filo: dopo aver
 * collegato un account, spegnere il servizio non scollega nessuno. Il controllo
 * positivo che rende quell'asserzione capace di fallire sta nello stesso test —
 * lo stesso `fetch` rotto DEVE far fallire la richiesta di un codice nuovo,
 * altrimenti «resta collegato» passerebbe anche con una rete che funziona.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createAccountRouter } from "./account";
import { createAuthRouter } from "./auth";
import { isGuestAllowedPath } from "../lib/grants";
import type { AppContext } from "../types";
import { alterMigrationsAfter, TASKS_DDL } from "../db/test-schema";

const RADICE = join(import.meta.dir, "..", "..");
const MIGRAZIONI = [
  "080-devices.sql", "082-task-shares.sql", "083-grants.sql", "084-people-orgs.sql",
  // Le ALTER arrivate dopo la 084 su queste tabelle: cercate, non elencate.
  // Senza, la prima colonna nuova che una rotta legge fa esplodere la query e
  // la risposta diventa un `null` che nomina il sintomo e non la causa.
  ...alterMigrationsAfter("084-people-orgs.sql", ["orgs", "people", "devices", "grants", "task_shares"], RADICE),
];
const BASE = "https://conti.esempio.test";

function dbFresco(): Database {
  const db = new Database(":memory:");
  db.run(TASKS_DDL);
  db.run("CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT, updated_at INTEGER)");
  for (const m of MIGRAZIONI) {
    db.run(readFileSync(join(RADICE, "server", "db", "migrations", m), "utf8"));
  }
  return db;
}

function proprietario(db: Database): { id: string; display_name: string } {
  return db.query(`
    SELECT p.id, p.display_name FROM installation_owners io JOIN people p ON p.id = io.person_id
     ORDER BY io.is_default DESC LIMIT 1`).get() as { id: string; display_name: string };
}

/** Una persona della rubrica che NON è il proprietario: è il caso di chi era
 *  stato aggiunto a mano prima che esistessero gli account. */
function aggiungiPersona(db: Database, nome: string, email: string | null): string {
  const id = `p-${nome.toLowerCase()}`;
  db.query(`INSERT INTO people (id, display_name, email, created_at, revoked_at, origin, rev, updated_at)
            VALUES (?,?,?,?,NULL,'local',0,?)`).run(id, nome, email, 1000, 1000);
  return id;
}

function rigaPersona(db: Database, id: string): { email: string | null; remote_id: string | null } {
  return db.query("SELECT email, remote_id FROM people WHERE id = ?")
    .get(id) as { email: string | null; remote_id: string | null };
}

function risposta(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });
}

/** Il servizio che funziona: manda il codice e riconosce `123456`. */
function servizioBuono(): { f: typeof fetch; chiamate: () => number } {
  let n = 0;
  const f = ((url: string, init: RequestInit) => {
    n += 1;
    const corpo = JSON.parse(String(init.body)) as { code?: string; email?: string };
    if (String(url).endsWith("/v1/account/code")) return Promise.resolve(risposta(200, { expiresAt: 999 }));
    if (corpo.code !== "123456") return Promise.resolve(risposta(400, { error: "codice sbagliato" }));
    return Promise.resolve(risposta(200, { accountId: "acct-77", email: corpo.email, displayName: "Attilio" }));
  }) as unknown as typeof fetch;
  return { f, chiamate: () => n };
}

/** La rete caduta, che conta anche i tentativi: serve a dimostrare che la `GET`
 *  non ne fa nessuno, invece di limitarsi a non fallire. */
function servizioRotto(): { f: typeof fetch; chiamate: () => number } {
  let n = 0;
  const f = (() => { n += 1; return Promise.reject(new Error("ECONNREFUSED")); }) as unknown as typeof fetch;
  return { f, chiamate: () => n };
}

function creaCtx(db: Database) {
  return {
    db,
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    readJSON: async (req: Request) => {
      try { return await req.json() as unknown; } catch { return null; }
    },
    requestIdentity: () => null,
    relayConfig: () => ({ baseUrl: null, installationId: "inst-test" }),
  } as unknown as AppContext;
}

type Rotta = ReturnType<typeof createAccountRouter>;

function chiama(rotta: Rotta, method: string, percorso: string, corpo?: unknown): Promise<Response | null> {
  const url = new URL(`http://127.0.0.1:3333${percorso}`);
  const req = new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  return rotta(req, url, url.pathname, method) as Promise<Response | null>;
}

interface StatoSulFilo {
  configured: boolean; linked: boolean; accountId: string | null; email: string | null;
  personId: string | null; personName: string | null; linkedAt: number | null;
  ok?: boolean; reconciled?: string; code?: string;
}

const EMAIL = "attilio@esempio.test";

describe("rotta account · leggere non fallisce mai e non tocca la rete", () => {
  let db: Database;
  beforeEach(() => { db = dbFresco(); });

  test("senza servizio configurato: 200, `configured: false`, e la persona c'è", async () => {
    const rete = servizioRotto();
    const rotta = createAccountRouter(creaCtx(db), { env: {}, fetchImpl: rete.f });
    const r = await chiama(rotta, "GET", "/api/auth/account");
    expect(r?.status).toBe(200);
    const b = await r!.json() as StatoSulFilo;
    expect(b.configured).toBe(false);
    expect(b.linked).toBe(false);
    expect(b.personId).toBe(proprietario(db).id);
    // Nessun tentativo in uscita: è la proprietà, non un effetto collaterale.
    expect(rete.chiamate()).toBe(0);
  });

  test("col servizio configurato la GET continua a non chiamare nessuno", async () => {
    const rete = servizioBuono();
    const rotta = createAccountRouter(creaCtx(db), { env: { TOPICS_ACCOUNT_URL: BASE }, fetchImpl: rete.f });
    const b = await (await chiama(rotta, "GET", "/api/auth/account"))!.json() as StatoSulFilo;
    expect(b.configured).toBe(true);
    expect(rete.chiamate()).toBe(0);
  });
});

describe("attivazione · codice via email", () => {
  let db: Database;
  beforeEach(() => { db = dbFresco(); });

  test("il giro completo: codice, verifica, e l'account finisce sulla persona che c'era", async () => {
    const rete = servizioBuono();
    const rotta = createAccountRouter(creaCtx(db), {
      env: { TOPICS_ACCOUNT_URL: BASE }, fetchImpl: rete.f, now: () => 4242,
    });
    const io = proprietario(db);
    const personeprima = (db.query("SELECT COUNT(*) AS n FROM people").get() as { n: number }).n;

    const c = await chiama(rotta, "POST", "/api/auth/account/code", { email: " Attilio@Esempio.TEST " });
    expect(c?.status).toBe(200);
    expect(await c!.json()).toEqual({ ok: true, expiresAt: 999 });

    const v = await chiama(rotta, "POST", "/api/auth/account/verify", { email: EMAIL, code: "123456" });
    expect(v?.status).toBe(200);
    const b = await v!.json() as StatoSulFilo;
    expect(b.ok).toBe(true);
    // Sul filo esce lo STATO e nient'altro: `reconciled` non c'è più, perché
    // nessuna superficie lo leggeva — e un campo che nessuno legge è una
    // promessa di compatibilità presa senza motivo.
    expect(b.reconciled).toBeUndefined();
    expect(b.linked).toBe(true);
    expect(b.accountId).toBe("acct-77");
    expect(b.personId).toBe(io.id);
    expect(b.linkedAt).toBe(4242);

    // Nessun abitante nuovo su questa macchina.
    expect((db.query("SELECT COUNT(*) AS n FROM people").get() as { n: number }).n).toBe(personeprima);

    // E lo stato letto dopo dice la stessa cosa: una forma sola.
    const dopo = await (await chiama(rotta, "GET", "/api/auth/account"))!.json() as StatoSulFilo;
    expect(dopo.linked).toBe(true);
    expect(dopo.accountId).toBe("acct-77");
    expect(dopo.email).toBe(EMAIL);
  });

  test("un indirizzo storto è 400; un codice sbagliato è 409 con `bad_code`", async () => {
    const rete = servizioBuono();
    const rotta = createAccountRouter(creaCtx(db), { env: { TOPICS_ACCOUNT_URL: BASE }, fetchImpl: rete.f });

    const storto = await chiama(rotta, "POST", "/api/auth/account/code", { email: "attilio" });
    expect(storto?.status).toBe(400);
    expect(await storto!.json()).toEqual({ ok: false, code: "invalid_email" });

    const sbagliato = await chiama(rotta, "POST", "/api/auth/account/verify", { email: EMAIL, code: "000000" });
    expect(sbagliato?.status).toBe(409);
    expect(await sbagliato!.json()).toEqual({ ok: false, code: "bad_code" });
    // E niente si è agganciato.
    const s = await (await chiama(rotta, "GET", "/api/auth/account"))!.json() as StatoSulFilo;
    expect(s.linked).toBe(false);
  });

  test("senza servizio configurato l'attivazione si rifiuta con un codice, non con un 5xx", async () => {
    const rotta = createAccountRouter(creaCtx(db), { env: {}, fetchImpl: servizioRotto().f });
    const r = await chiama(rotta, "POST", "/api/auth/account/code", { email: EMAIL });
    expect(r?.status).toBe(409);
    expect(await r!.json()).toEqual({ ok: false, code: "not_configured" });
  });
});

describe("i tre verbi parlano della STESSA persona", () => {
  let db: Database;
  beforeEach(() => { db = dbFresco(); });

  /**
   * Il guasto che questo blocco tiene chiuso è invisibile a occhio: l'attivazione
   * risponde `ok`, e il pannello — che subito dopo rilegge lo stato — torna a
   * dire «nessun account collegato». Succedeva quando `verify` agganciava
   * l'identità alla riga che porta quell'INDIRIZZO mentre `GET` e `DELETE`
   * rispondevano di chi sta AGENDO: due persone diverse, tre verbi che non
   * parlano più della stessa. E il danno non era solo cosmetico — `DELETE`
   * cadeva sul ramo idempotente («questa persona non ha account, va bene lo
   * stesso») e l'aggancio restava sulla riga altrui, senza nessun gesto per
   * toglierlo.
   */
  test("l'indirizzo di UN'ALTRA riga si rifiuta invece di agganciarsi lì", async () => {
    const rotta = createAccountRouter(creaCtx(db), {
      env: { TOPICS_ACCOUNT_URL: BASE }, fetchImpl: servizioBuono().f, now: () => 4242,
    });
    const io = proprietario(db);
    // Mircea era in rubrica con QUELL'indirizzo, e non è chi sta agendo.
    const mircea = aggiungiPersona(db, "Mircea", EMAIL);

    const v = await chiama(rotta, "POST", "/api/auth/account/verify", { email: EMAIL, code: "123456" });
    expect(v?.status).toBe(409);
    expect(await v!.json()).toEqual({ ok: false, code: "belongs_to_other_person" });

    // Niente si è agganciato, né alla riga altrui né alla mia.
    expect(rigaPersona(db, mircea).remote_id).toBeNull();
    expect(rigaPersona(db, io.id).remote_id).toBeNull();

    const s = await (await chiama(rotta, "GET", "/api/auth/account"))!.json() as StatoSulFilo;
    expect(s.linked).toBe(false);
    expect(s.personId).toBe(io.id);
  });

  test("quando l'indirizzo è GIÀ il mio: si collega, e GET e DELETE parlano di me", async () => {
    // ── CONTROLLO POSITIVO del test qui sopra: lo STESSO servizio e lo STESSO
    //    codice devono poter riuscire, altrimenti «si rifiuta» passerebbe anche
    //    con una verifica rotta in ogni caso.
    const rotta = createAccountRouter(creaCtx(db), {
      env: { TOPICS_ACCOUNT_URL: BASE }, fetchImpl: servizioBuono().f, now: () => 4242,
    });
    const io = proprietario(db);
    // La mia riga porta quell'indirizzo da prima: è il ramo `email`, quello che
    // riconosce chi era in rubrica prima di avere un account.
    db.query("UPDATE people SET email = ? WHERE id = ?").run(EMAIL, io.id);

    const v = await chiama(rotta, "POST", "/api/auth/account/verify", { email: EMAIL, code: "123456" });
    expect(v?.status).toBe(200);
    const b = await v!.json() as StatoSulFilo;
    expect(b.ok).toBe(true);
    expect(b.linked).toBe(true);
    expect(b.personId).toBe(io.id);

    // La GET dice la stessa cosa della verifica: stessa persona, stesso account.
    const dopo = await (await chiama(rotta, "GET", "/api/auth/account"))!.json() as StatoSulFilo;
    expect(dopo.linked).toBe(true);
    expect(dopo.accountId).toBe("acct-77");
    expect(dopo.personId).toBe(b.personId);

    // E staccare arriva DAVVERO alla riga che portava l'account: il ramo
    // idempotente di `scollegaAccount` risponde `ok` anche quando non c'era
    // niente da togliere, quindi la prova è la colonna, non lo stato.
    const d = await chiama(rotta, "DELETE", "/api/auth/account");
    expect(d?.status).toBe(200);
    expect(((await d!.json()) as StatoSulFilo).linked).toBe(false);
    expect(rigaPersona(db, io.id).remote_id).toBeNull();
    // L'indirizzo resta: era un'etichetta della rubrica da prima dell'account.
    expect(rigaPersona(db, io.id).email).toBe(EMAIL);
  });
});

describe("ORG-08 · perdere il servizio non toglie niente", () => {
  let db: Database;
  beforeEach(() => { db = dbFresco(); });

  test("collegato ieri, servizio giù oggi: si resta collegati, e il nuovo tentativo lo dice", async () => {
    // 1. Si collega con il servizio funzionante.
    const buono = servizioBuono();
    const conRete = createAccountRouter(creaCtx(db), {
      env: { TOPICS_ACCOUNT_URL: BASE }, fetchImpl: buono.f, now: () => 100,
    });
    await chiama(conRete, "POST", "/api/auth/account/code", { email: EMAIL });
    const v = await chiama(conRete, "POST", "/api/auth/account/verify", { email: EMAIL, code: "123456" });
    expect(((await v!.json()) as StatoSulFilo).linked).toBe(true);

    // 2. Il servizio sparisce.
    const rotto = servizioRotto();
    const senzaRete = createAccountRouter(creaCtx(db), {
      env: { TOPICS_ACCOUNT_URL: BASE }, fetchImpl: rotto.f,
    });

    const s = await chiama(senzaRete, "GET", "/api/auth/account");
    expect(s?.status).toBe(200);
    const b = await s!.json() as StatoSulFilo;
    expect(b.linked).toBe(true);
    expect(b.accountId).toBe("acct-77");
    expect(b.linkedAt).toBe(100);

    // ── CONTROLLO POSITIVO. Senza questo, «resta collegato» passerebbe anche
    //    con una rete perfettamente viva, e l'asserzione qui sopra non
    //    dimostrerebbe niente: il canale di osservazione va provato rotto.
    const tentativo = await chiama(senzaRete, "POST", "/api/auth/account/code", { email: EMAIL });
    expect(tentativo?.status).toBe(409);
    expect(await tentativo!.json()).toEqual({ ok: false, code: "service_unreachable" });
    expect(rotto.chiamate()).toBe(1);

    // 3. E staccarsi funziona lo stesso: è un gesto locale.
    const d = await chiama(senzaRete, "DELETE", "/api/auth/account");
    expect(d?.status).toBe(200);
    expect(((await d!.json()) as StatoSulFilo).linked).toBe(false);
    // Nessun'altra richiesta in uscita: né la GET né la DELETE ne fanno.
    expect(rotto.chiamate()).toBe(1);
  });

  test("nessun ramo di questa rotta risponde 5xx", async () => {
    const rotto = servizioRotto();
    const casi: Array<[string, string, unknown]> = [
      ["GET", "/api/auth/account", undefined],
      ["DELETE", "/api/auth/account", undefined],
      ["POST", "/api/auth/account/code", { email: EMAIL }],
      ["POST", "/api/auth/account/code", { email: "storta" }],
      ["POST", "/api/auth/account/code", null],
      ["POST", "/api/auth/account/verify", { email: EMAIL, code: "123456" }],
      ["POST", "/api/auth/account/verify", { email: EMAIL }],
      ["POST", "/api/auth/account/verify", null],
    ];
    for (const env of [{}, { TOPICS_ACCOUNT_URL: BASE }]) {
      const rotta = createAccountRouter(creaCtx(db), { env, fetchImpl: rotto.f });
      for (const [m, p, corpo] of casi) {
        const r = await chiama(rotta, m, p, corpo);
        expect(r).not.toBeNull();
        expect(r!.status).toBeLessThan(500);
      }
    }
  });

  test("uno schema anteriore alla 084 non rompe la rotta: dice «non collegato»", async () => {
    const nudo = new Database(":memory:");
    const rotta = createAccountRouter(creaCtx(nudo), { env: { TOPICS_ACCOUNT_URL: BASE }, fetchImpl: servizioRotto().f });
    const r = await chiama(rotta, "GET", "/api/auth/account");
    expect(r?.status).toBe(200);
    const b = await r!.json() as StatoSulFilo;
    expect(b.linked).toBe(false);
    expect(b.personId).toBeNull();
  });
});

describe("una domanda sola, una risposta sola", () => {
  test("`/api/auth/account` e `/api/auth/me` dicono la STESSA persona", async () => {
    // Sono due rotte che rispondono a «chi sono»: se un giorno una delle due
    // cambia il modo di derivarla, la schermata mostrerebbe un account intestato
    // a un nome e una rubrica intestata a un altro, senza che niente fallisca.
    // Questo test è l'unico posto in cui quella divergenza si vede.
    const db = dbFresco();
    const ctx = creaCtx(db);
    const account = createAccountRouter(ctx, { env: { TOPICS_ACCOUNT_URL: BASE }, fetchImpl: servizioBuono().f });
    const auth = createAuthRouter(ctx);

    const daAccount = await (await chiama(account, "GET", "/api/auth/account"))!.json() as StatoSulFilo;

    const url = new URL("http://127.0.0.1:3333/api/auth/me");
    const r = await auth(new Request(url), url, url.pathname, "GET");
    const daMe = await r!.json() as { person: { id: string; name: string } | null };

    expect(daMe.person).not.toBeNull();
    expect(daAccount.personId).toBe(daMe.person!.id);
    expect(daAccount.personName).toBe(daMe.person!.name);
  });
});

describe("gli ospiti non arrivano qui", () => {
  test("i percorsi dell'account non sono in allowlist, e l'allowlist funziona", () => {
    // Il controllo positivo prima: se questa cadesse, le tre `false` qui sotto
    // sarebbero vere per il motivo sbagliato (per esempio una funzione che
    // risponde `false` a tutto).
    expect(isGuestAllowedPath("/api/auth/shared")).toBe(true);
    expect(isGuestAllowedPath("/api/auth/account")).toBe(false);
    expect(isGuestAllowedPath("/api/auth/account/code")).toBe(false);
    expect(isGuestAllowedPath("/api/auth/account/verify")).toBe(false);
  });

  test("percorsi altrui: la rotta si sfila invece di rispondere", async () => {
    const rotta = createAccountRouter(creaCtx(dbFresco()), { env: {}, fetchImpl: servizioRotto().f });
    expect(await chiama(rotta, "GET", "/api/auth/me")).toBeNull();
    expect(await chiama(rotta, "PATCH", "/api/auth/account")).toBeNull();
  });
});
