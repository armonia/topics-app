/**
 * L'account, contro uno SQLite vero e le migration vere.
 *
 * Ciò che questo file difende è UNA frase: collegare un account non fa comparire
 * un abitante nuovo su questa macchina. Il modo in cui una cosa del genere si
 * guasta non è un'eccezione — è una `INSERT` aggiunta in buona fede da chi
 * risolve il caso «la persona non c'è», e dopo quella riga esistono due «te»
 * sulla stessa installazione. Quindi le righe di `people` si CONTANO prima e
 * dopo ogni gesto, in tutti i rami, compresi quelli che falliscono.
 *
 * Lo schema non è riscritto a mano: si applicano le migration 080/082/083/084.
 * Un test che ricostruisce le tabelle a memoria smette di accorgersi proprio
 * della cosa che qui fa più male — gli indici UNIQUE su `people(email)` e
 * `people(remote_id)`, che sono ciò che rende necessari due dei rami di rifiuto.
 *
 * @covers ACCOUNT-01, ACCOUNT-02
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TASKS_DDL } from "../db/test-schema";

import {
  leggiAccountUrl, normalizzaEmail, statoAccount, collegaAccount, scollegaAccount,
  chiediCodice, verificaCodice, type OpzioniServizio,
} from "./account";

const RADICE = join(import.meta.dir, "..", "..");
const MIGRAZIONI = ["080-devices.sql", "082-task-shares.sql", "083-grants.sql", "084-people-orgs.sql"];

function dbFresco(): Database {
  const db = new Database(":memory:");
  db.run(TASKS_DDL);
  db.run("CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT, updated_at INTEGER)");
  for (const m of MIGRAZIONI) {
    db.run(readFileSync(join(RADICE, "server", "db", "migrations", m), "utf8"));
  }
  return db;
}

/** La persona che la 084 crea: il proprietario dell'installazione. */
function proprietario(db: Database): { id: string; display_name: string } {
  return db.query(`
    SELECT p.id, p.display_name FROM installation_owners io JOIN people p ON p.id = io.person_id
     ORDER BY io.is_default DESC LIMIT 1`).get() as { id: string; display_name: string };
}

function manyPeople(db: Database): number {
  return Number((db.query("SELECT COUNT(*) AS n FROM people").get() as { n: number }).n);
}

function rigaPersona(db: Database, id: string) {
  return db.query("SELECT display_name, email, remote_id, rev, synced_at, origin FROM people WHERE id = ?")
    .get(id) as { display_name: string; email: string | null; remote_id: string | null; rev: number; synced_at: number | null; origin: string };
}

/** Aggiunge alla rubrica una persona che NON è il proprietario. È il caso di
 *  chi era stato invitato prima di avere un account. */
function aggiungiPersona(db: Database, nome: string, email: string | null, revocata = false): string {
  const id = `p-${nome.toLowerCase()}`;
  db.query(`INSERT INTO people (id, display_name, email, created_at, revoked_at, origin, rev, updated_at)
            VALUES (?,?,?,?,?,'local',0,?)`).run(id, nome, email, 1000, revocata ? 2000 : null, 1000);
  return id;
}

const IDENTITA = { accountId: "acct-77", email: "Attilio@Esempio.TEST", displayName: "Attilio" };

// ─────────────────────────────────────────────────────────────────────────────

describe("configurazione · spento è il default", () => {
  test("senza la variabile non c'è servizio, e non è un errore", () => {
    expect(leggiAccountUrl({})).toBeNull();
    expect(leggiAccountUrl({ TOPICS_ACCOUNT_URL: "   " })).toBeNull();
  });

  test("normalizza la barra finale e rifiuta ciò che non è http(s)", () => {
    expect(leggiAccountUrl({ TOPICS_ACCOUNT_URL: "https://conti.esempio.test/api/" }))
      .toBe("https://conti.esempio.test/api");
    expect(leggiAccountUrl({ TOPICS_ACCOUNT_URL: "https://conti.esempio.test" }))
      .toBe("https://conti.esempio.test");
    expect(leggiAccountUrl({ TOPICS_ACCOUNT_URL: "file:///etc/passwd" })).toBeNull();
    expect(leggiAccountUrl({ TOPICS_ACCOUNT_URL: "non un url" })).toBeNull();
  });

  test("l'indirizzo si riduce a minuscolo e senza spazi, e la forma si controlla", () => {
    expect(normalizzaEmail("  Attilio@Esempio.TEST ")).toBe("attilio@esempio.test");
    expect(normalizzaEmail("attilio+topics@esempio.test")).toBe("attilio+topics@esempio.test");
    expect(normalizzaEmail("attilio")).toBeNull();
    expect(normalizzaEmail("a@b")).toBeNull();
    expect(normalizzaEmail(42)).toBeNull();
    expect(normalizzaEmail(null)).toBeNull();
  });
});

describe("stato · si legge dal database e da nient'altro", () => {
  let db: Database;
  beforeEach(() => { db = dbFresco(); });

  test("prima di collegare: non collegato, ma la persona c'è", () => {
    const io = proprietario(db);
    const s = statoAccount(db, io.id, true);
    expect(s).toEqual({
      configured: true, linked: false, accountId: null, email: null,
      personId: io.id, personName: io.display_name, linkedAt: null,
    });
  });

  test("`configured` è indipendente da `linked`: si resta collegati col servizio spento", () => {
    const io = proprietario(db);
    expect(collegaAccount(db, { identita: IDENTITA, actingPersonId: io.id, now: 5000 }).ok).toBe(true);
    // Il servizio sparisce: `configured: false`. Il collegamento NON si scioglie.
    const s = statoAccount(db, io.id, false);
    expect(s.configured).toBe(false);
    expect(s.linked).toBe(true);
    expect(s.accountId).toBe("acct-77");
    expect(s.linkedAt).toBe(5000);
  });

  test("su uno schema anteriore alla 084 non solleva: dice «non collegato»", () => {
    const nudo = new Database(":memory:");
    const s = statoAccount(nudo, "chiunque", true);
    expect(s.linked).toBe(false);
    expect(s.accountId).toBeNull();
  });
});

describe("aggancio · non nasce mai una persona nuova", () => {
  let db: Database;
  beforeEach(() => { db = dbFresco(); });

  test("prima attivazione: si prende la persona che agisce, e il conteggio non si muove", () => {
    const io = proprietario(db);
    const prima = manyPeople(db);

    const e = collegaAccount(db, { identita: IDENTITA, actingPersonId: io.id, now: 7000 });
    expect(e).toEqual({ ok: true, personId: io.id, come: "acting" });
    expect(manyPeople(db)).toBe(prima);

    const r = rigaPersona(db, io.id);
    expect(r.remote_id).toBe("acct-77");
    // L'indirizzo si scrive normalizzato, non come lo ha battuto il servizio.
    expect(r.email).toBe("attilio@esempio.test");
    expect(r.synced_at).toBe(7000);
    expect(r.rev).toBe(1);
    // `origin` NON diventa 'cloud': la riga è nata qui e nessun servizio l'ha
    // mai scritta. Vedi la testata di `account.ts`.
    expect(r.origin).toBe("local");
  });

  test("il nome scelto qui non viene sovrascritto da quello dell'account", () => {
    const io = proprietario(db);
    collegaAccount(db, {
      identita: { ...IDENTITA, displayName: "Un Altro Nome" }, actingPersonId: io.id, now: 7000,
    });
    expect(rigaPersona(db, io.id).display_name).toBe(io.display_name);
  });

  test("riattivare lo stesso account sulla propria riga è idempotente e la ritrova", () => {
    const io = proprietario(db);
    collegaAccount(db, { identita: IDENTITA, actingPersonId: io.id, now: 7000 });
    const prima = manyPeople(db);

    const e = collegaAccount(db, { identita: IDENTITA, actingPersonId: io.id, now: 9000 });
    // `remote_id` e non `acting`: la riga portava GIÀ questo account, ed è
    // l'unico modo per distinguere una riattivazione da una prima attivazione.
    expect(e).toEqual({ ok: true, personId: io.id, come: "remote_id" });
    expect(manyPeople(db)).toBe(prima);
    expect(rigaPersona(db, io.id).synced_at).toBe(9000);
  });

  test("chi era in rubrica CON QUELL'INDIRIZZO viene riconosciuto, non duplicato", () => {
    // La riga di chi agisce porta l'indirizzo da prima che esistesse un account:
    // è il caso di chi era stato aggiunto a mano alla rubrica.
    const io = proprietario(db);
    db.query("UPDATE people SET email = ? WHERE id = ?").run("attilio@esempio.test", io.id);
    const prima = manyPeople(db);

    const e = collegaAccount(db, { identita: IDENTITA, actingPersonId: io.id, now: 7000 });
    expect(e).toEqual({ ok: true, personId: io.id, come: "email" });
    expect(manyPeople(db)).toBe(prima);
    expect(rigaPersona(db, io.id).remote_id).toBe("acct-77");
  });

  test("un indirizzo che è di UN'ALTRA riga si rifiuta, invece di agganciarsi lì", () => {
    // Il guasto che questo chiude: l'identità finiva sulla riga trovata per
    // indirizzo, che NON è chi agisce — e da lì in poi «ho un account?» aveva
    // due risposte, con `DELETE` incapace di raggiungere l'aggancio.
    const io = proprietario(db);
    const invitato = aggiungiPersona(db, "Mircea", "mircea@esempio.test");
    const prima = manyPeople(db);

    const e = collegaAccount(db, {
      identita: { accountId: "acct-9", email: "Mircea@Esempio.test" },
      actingPersonId: io.id,
      now: 7000,
    });
    expect(e).toEqual({ ok: false, codice: "belongs_to_other_person" });
    expect(manyPeople(db)).toBe(prima);
    expect(rigaPersona(db, invitato).remote_id).toBeNull();
    expect(rigaPersona(db, io.id).remote_id).toBeNull();
  });

  test("un account che è di UN'ALTRA riga si rifiuta: l'indice unico lo direbbe comunque, ma peggio", () => {
    const io = proprietario(db);
    collegaAccount(db, { identita: IDENTITA, actingPersonId: io.id, now: 7000 });
    const prima = manyPeople(db);

    // Un secondo dispositivo, un'altra persona alla tastiera, lo stesso account.
    const altro = aggiungiPersona(db, "Ospite", null);
    const e = collegaAccount(db, { identita: IDENTITA, actingPersonId: altro, now: 9000 });
    expect(e).toEqual({ ok: false, codice: "belongs_to_other_person" });
    expect(manyPeople(db)).toBe(prima + 1); // solo quella aggiunta a mano qui sopra
    expect(rigaPersona(db, altro).remote_id).toBeNull();
    // E la riga che l'account ce l'ha davvero non è stata toccata.
    expect(rigaPersona(db, io.id).synced_at).toBe(7000);
    expect(rigaPersona(db, io.id).rev).toBe(1);
  });

  test("chi porta già un ALTRO account non se lo vede sostituire in silenzio", () => {
    const io = proprietario(db);
    collegaAccount(db, { identita: IDENTITA, actingPersonId: io.id, now: 7000 });
    const prima = manyPeople(db);

    const e = collegaAccount(db, {
      identita: { accountId: "acct-diverso", email: "altro@esempio.test" },
      actingPersonId: io.id,
      now: 8000,
    });
    expect(e).toEqual({ ok: false, codice: "already_linked_other" });
    expect(manyPeople(db)).toBe(prima);
    // Niente è cambiato: né l'account né l'indirizzo.
    expect(rigaPersona(db, io.id).remote_id).toBe("acct-77");
    expect(rigaPersona(db, io.id).email).toBe("attilio@esempio.test");
  });

  test("un indirizzo che appartiene a una persona REVOCATA si dichiara, non si aggira", () => {
    const io = proprietario(db);
    aggiungiPersona(db, "Uscito", "uscito@esempio.test", true);
    const prima = manyPeople(db);

    const e = collegaAccount(db, {
      identita: { accountId: "acct-5", email: "uscito@esempio.test" },
      actingPersonId: io.id,
      now: 7000,
    });
    expect(e).toEqual({ ok: false, codice: "person_revoked" });
    expect(manyPeople(db)).toBe(prima);
    expect(rigaPersona(db, io.id).remote_id).toBeNull();
  });

  test("un ACCOUNT che appartiene a una persona REVOCATA si dichiara, non si aggira", () => {
    // Come per l'indirizzo: `idx_people_remote` è UNIQUE e le righe revocate non
    // le esclude, quindi riscrivere quel valore altrove salterebbe comunque.
    const io = proprietario(db);
    const uscito = aggiungiPersona(db, "Uscito", "uscito@esempio.test", true);
    db.query("UPDATE people SET remote_id = ? WHERE id = ?").run("acct-77", uscito);
    const prima = manyPeople(db);

    const e = collegaAccount(db, { identita: IDENTITA, actingPersonId: io.id, now: 7000 });
    expect(e).toEqual({ ok: false, codice: "person_revoked" });
    expect(manyPeople(db)).toBe(prima);
    expect(rigaPersona(db, io.id).remote_id).toBeNull();
  });

  test("senza nessuna persona a cui agganciarsi si rifiuta, e non se ne inventa una", () => {
    const prima = manyPeople(db);
    expect(collegaAccount(db, { identita: IDENTITA, actingPersonId: null, now: 7000 }))
      .toEqual({ ok: false, codice: "no_person" });
    expect(collegaAccount(db, { identita: IDENTITA, actingPersonId: "mai-esistita", now: 7000 }))
      .toEqual({ ok: false, codice: "no_person" });
    // E una riga revocata non si resuscita agganciandole un account.
    const uscito = aggiungiPersona(db, "Uscito", null, true);
    expect(collegaAccount(db, { identita: IDENTITA, actingPersonId: uscito, now: 7000 }))
      .toEqual({ ok: false, codice: "no_person" });
    expect(rigaPersona(db, uscito).remote_id).toBeNull();
    expect(manyPeople(db)).toBe(prima + 1); // solo `Uscito`
  });

  test("un carico senza account o senza indirizzo non si interpreta", () => {
    const io = proprietario(db);
    expect(collegaAccount(db, {
      identita: { accountId: "  ", email: "a@b.test" }, actingPersonId: io.id, now: 1,
    })).toEqual({ ok: false, codice: "bad_response" });
    expect(collegaAccount(db, {
      identita: { accountId: "acct-1", email: "non-un-indirizzo" }, actingPersonId: io.id, now: 1,
    })).toEqual({ ok: false, codice: "bad_response" });
    expect(rigaPersona(db, io.id).remote_id).toBeNull();
  });
});

describe("seconda installazione · si riconcilia sulla STESSA persona", () => {
  test("due database, due righe locali, un solo `remote_id`", () => {
    const primaMacchina = dbFresco();
    const secondMachine = dbFresco();

    const ioA = proprietario(primaMacchina);
    const ioB = proprietario(secondMachine);
    // Le due installazioni partono da due righe DIVERSE: gli id li fa
    // `randomblob`, apposta perché due database che si incontrano non
    // collidano. Se questa asserzione cadesse, il test successivo passerebbe
    // per il motivo sbagliato.
    expect(ioA.id).not.toBe(ioB.id);

    const primaA = manyPeople(primaMacchina);
    const primaB = manyPeople(secondMachine);

    expect(collegaAccount(primaMacchina, { identita: IDENTITA, actingPersonId: ioA.id, now: 100 }))
      .toEqual({ ok: true, personId: ioA.id, come: "acting" });
    expect(collegaAccount(secondMachine, { identita: IDENTITA, actingPersonId: ioB.id, now: 200 }))
      .toEqual({ ok: true, personId: ioB.id, come: "acting" });

    // Nessuna delle due ha guadagnato un abitante.
    expect(manyPeople(primaMacchina)).toBe(primaA);
    expect(manyPeople(secondMachine)).toBe(primaB);

    // E le due righe portano la stessa identità remota: è QUESTA la chiave
    // condivisa, non la riga — ogni installazione ha il proprio database.
    expect(rigaPersona(primaMacchina, ioA.id).remote_id)
      .toBe(rigaPersona(secondMachine, ioB.id).remote_id);
    expect(rigaPersona(primaMacchina, ioA.id).remote_id).toBe("acct-77");
  });
});

describe("staccarsi · è un gesto locale", () => {
  let db: Database;
  beforeEach(() => { db = dbFresco(); });

  test("toglie l'account e LASCIA l'indirizzo, che era un'etichetta da prima", () => {
    const io = proprietario(db);
    collegaAccount(db, { identita: IDENTITA, actingPersonId: io.id, now: 7000 });

    expect(scollegaAccount(db, io.id, 8000)).toEqual({ ok: true });
    const r = rigaPersona(db, io.id);
    expect(r.remote_id).toBeNull();
    expect(r.synced_at).toBeNull();
    expect(r.email).toBe("attilio@esempio.test");
    expect(r.rev).toBe(2);
    expect(statoAccount(db, io.id, true).linked).toBe(false);
  });

  test("il secondo clic non è un errore", () => {
    const io = proprietario(db);
    expect(scollegaAccount(db, io.id, 8000)).toEqual({ ok: true });
    expect(scollegaAccount(db, io.id, 9000)).toEqual({ ok: true });
  });

  test("senza persona si rifiuta con un codice, non con un'eccezione", () => {
    expect(scollegaAccount(db, null, 1)).toEqual({ ok: false, codice: "no_person" });
    expect(scollegaAccount(db, "persona-che-non-esiste", 1)).toEqual({ ok: false, codice: "no_person" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

function servizio(fetchImpl: typeof fetch, baseUrl: string | null = "https://conti.esempio.test"): OpzioniServizio {
  return { baseUrl, fetchImpl, installationId: "inst-di-prova", timeoutMs: 50 };
}

function risposta(status: number, corpo: unknown): Response {
  return new Response(typeof corpo === "string" ? corpo : JSON.stringify(corpo), {
    status, headers: { "content-type": "application/json" },
  });
}

describe("il servizio remoto · ogni fallimento ha un nome", () => {
  test("senza servizio configurato non si prova nemmeno", async () => {
    let chiamate = 0;
    const f = (() => { chiamate += 1; return Promise.resolve(risposta(200, {})); }) as unknown as typeof fetch;
    expect(await chiediCodice(servizio(f, null), "a@b.test")).toEqual({ ok: false, codice: "not_configured" });
    expect(chiamate).toBe(0);
  });

  test("il codice parte, e la richiesta porta l'installazione", async () => {
    let visto: { url: string; corpo: Record<string, unknown> } | null = null;
    const f = ((url: string, init: RequestInit) => {
      visto = { url, corpo: JSON.parse(String(init.body)) as Record<string, unknown> };
      return Promise.resolve(risposta(200, { expiresAt: 1234 }));
    }) as unknown as typeof fetch;

    expect(await chiediCodice(servizio(f), "a@b.test")).toEqual({ ok: true, dato: { expiresAt: 1234 } });
    expect(visto!.url).toBe("https://conti.esempio.test/v1/account/code");
    expect(visto!.corpo).toEqual({ email: "a@b.test", installationId: "inst-di-prova" });
  });

  test("rete caduta, 5xx e 429 sono tre risposte diverse", async () => {
    const caduta = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    expect(await chiediCodice(servizio(caduta), "a@b.test"))
      .toEqual({ ok: false, codice: "service_unreachable" });

    const rotto = (() => Promise.resolve(risposta(503, { error: "giù" }))) as unknown as typeof fetch;
    expect(await chiediCodice(servizio(rotto), "a@b.test"))
      .toEqual({ ok: false, codice: "service_unreachable" });

    const troppe = (() => Promise.resolve(risposta(429, { error: "piano" }))) as unknown as typeof fetch;
    expect(await chiediCodice(servizio(troppe), "a@b.test"))
      .toEqual({ ok: false, codice: "rate_limited" });

    const nega = (() => Promise.resolve(risposta(403, { error: "no" }))) as unknown as typeof fetch;
    expect(await chiediCodice(servizio(nega), "a@b.test"))
      .toEqual({ ok: false, codice: "service_refused" });
  });

  test("un `200` che non è la risposta attesa NON si interpreta", async () => {
    const vuoto = (() => Promise.resolve(risposta(200, { ciao: 1 }))) as unknown as typeof fetch;
    expect(await verificaCodice(servizio(vuoto), "a@b.test", "123456"))
      .toEqual({ ok: false, codice: "bad_response" });

    const spazzatura = (() => Promise.resolve(risposta(200, "<html>"))) as unknown as typeof fetch;
    expect(await verificaCodice(servizio(spazzatura), "a@b.test", "123456"))
      .toEqual({ ok: false, codice: "bad_response" });
  });

  test("il codice sbagliato è `bad_code`, non un guasto del servizio", async () => {
    const no = (() => Promise.resolve(risposta(400, { error: "codice scaduto" }))) as unknown as typeof fetch;
    expect(await verificaCodice(servizio(no), "a@b.test", "000000"))
      .toEqual({ ok: false, codice: "bad_code" });
  });

  test("la verifica restituisce l'identità, normalizzata", async () => {
    const si = (() => Promise.resolve(risposta(200, {
      accountId: " acct-77 ", email: "Attilio@Esempio.TEST", displayName: " Attilio ",
    }))) as unknown as typeof fetch;
    expect(await verificaCodice(servizio(si), "attilio@esempio.test", "123456")).toEqual({
      ok: true,
      dato: { accountId: "acct-77", email: "attilio@esempio.test", displayName: "Attilio" },
    });
  });
});
