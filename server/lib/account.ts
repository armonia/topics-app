/**
 * L'ACCOUNT: agganciare un'identità REMOTA alla persona che esiste già qui.
 *
 * ── COSA È UN ACCOUNT, E COSA NON È ─────────────────────────────────────────
 * Non è un utente da creare. È un `remote_id` scritto su una riga di `people`
 * che c'era prima — quella del proprietario dell'installazione, che la
 * migration 084 crea senza rete, senza login e senza che nessuno sappia che
 * questa macchina esiste. Collegare un account NON inserisce mai una persona:
 * `collegaAccount` non contiene una sola `INSERT INTO people`, e un test lo
 * fissa contando le righe prima e dopo.
 *
 * La ragione è ORG-08 e ORG-02 insieme. Se l'attivazione creasse una persona,
 * ti ritroveresti due «te» sulla stessa macchina — quello locale, che possiede
 * l'installazione, e quello dell'account, che non possiede niente — e da quel
 * momento in poi ogni domanda («chi sono?», «con chi condivido?», «chi vede
 * questa cosa?») avrebbe due risposte plausibili. La riconciliazione è quindi
 * l'unico gesto ammesso: si TROVA la persona giusta e le si scrive addosso
 * l'identità remota.
 *
 * ── «LA PERSONA GIUSTA» È SEMPRE CHI STA AGENDO ─────────────────────────────
 * L'identità atterra sulla riga di `actingPersonId` o su NESSUNA. Non è una
 * semplificazione: è l'unica scelta che tiene d'accordo i tre verbi della rotta
 * (`server/routes/account.ts`), che alla domanda «chi sono» rispondono tutti
 * con la persona che agisce. Quando `verify` agganciava invece la riga trovata
 * per indirizzo, l'attivazione rispondeva «fatto» su una persona e la lettura
 * subito dopo diceva «nessun account collegato» su un'altra — con `DELETE` che
 * cadeva sul proprio ramo idempotente e lasciava l'aggancio dov'era, senza più
 * un gesto per toglierlo. È la stessa ORG-02 di sopra, arrivata per un'altra
 * strada: due «te», e nessuna domanda con una sola risposta.
 *
 * Le altre due chiavi restano, ma come CONTROLLI e non come bersagli:
 *   - `remote_id = accountId` su un'altra riga → si rifiuta. `idx_people_remote`
 *     è UNIQUE: scrivere quel valore qui salterebbe comunque, a runtime.
 *   - `email` su un'altra riga → si rifiuta, per lo stesso indice su
 *     `people(email)`. È il caso di chi era stato aggiunto a mano alla rubrica:
 *     quella riga va sistemata dall'umano (è lui? è un altro?), e finché non lo
 *     è, un `belongs_to_other_person` dice cosa c'è di mezzo. Sceglierlo per
 *     conto suo vorrebbe dire spostare un'identità che non è nostra.
 * Ciò che resta è il RICONOSCIMENTO (`ComeRiconciliato`): la riga di chi agisce
 * portava già questo account, o già quell'indirizzo, o nessuno dei due.
 *
 * Su UNA SECONDA INSTALLAZIONE è la prima attivazione a scattare, e va letta bene:
 * il DB è un altro, la riga è un'altra, ma dopo l'attivazione le DUE righe
 * portano lo STESSO `remote_id`. È esattamente ciò che «riconciliare sulla
 * stessa persona» significa in un sistema in cui ogni installazione ha il
 * proprio database: la chiave condivisa è il `remote_id`, non la riga.
 *
 * ── PERDERE IL SERVIZIO NON TOGLIE NIENTE ───────────────────────────────────
 * Lo stato dell'account si legge da `people`, e da NIENT'ALTRO: nessuna
 * chiamata, nessun timeout, nessun momento in cui un servizio giù cambia ciò
 * che questa macchina ti lascia fare (ORG-08). Un account collegato resta
 * collegato mentre la rete non c'è; ciò che si perde è solo il gesto di
 * collegarne uno NUOVO, e quel rifiuto arriva con un codice che lo dice invece
 * di somigliare a un guasto della macchina. Non esiste una funzione qui dentro
 * che ri-validi un collegamento contro il servizio: una revalidazione è, per
 * costruzione, un modo in cui un servizio giù ti declassa.
 *
 * ── PERCHÉ UN CODICE VIA EMAIL ──────────────────────────────────────────────
 * Non passkey (serve un autenticatore, e lega l'identità a un ferro — che è
 * esattamente ciò che questo modello smette di fare) e non Google (un terzo che
 * viene a sapere che questa installazione esiste, il contrario di ORG-08). Il
 * codice via email usa l'unica cosa che di una persona conosciamo già, e che la
 * rubrica di `people` porta da sempre: l'indirizzo.
 *
 * ── ORIGIN RESTA 'local', E NON È UNA DIMENTICANZA ──────────────────────────
 * `people.origin` dice CHI HA SCRITTO la riga, non «se ha un account»: questa
 * riga è nata qui, e continua a essere nostra finché un piano di controllo non
 * la possiede davvero. Chiamare 'cloud' una riga che nessun servizio ha mai
 * scritto vorrebbe dire mentire alla prima sincronizzazione, che su quel campo
 * deciderà chi vince un merge.
 */
import type { Database } from "bun:sqlite";

/** Forma minima del database, così i test passano uno SQLite in memoria. */
type Db = Pick<Database, "query">;

// ─────────────────────────────────────────────────────────────────────────────
// Il vocabolario
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Il vocabolario dei rifiuti e la forma dello stato vivono in `shared/account.ts`
 * e si ri-esportano da qui: sono ciò che viaggia sul filo, e due dichiarazioni
 * per la stessa cosa sono due dichiarazioni che un giorno divergono senza che
 * nessun compilatore se ne accorga (`tests/unit/no-type-mirrors.test.ts`).
 *
 * Ri-esportati sono i TIPI, che è ciò di cui questo lato ha bisogno: qui i
 * codici si SCRIVONO — ogni rifiuto è un letterale che `CodiceAccount` vincola
 * a uno dell'elenco — e non si validano mai, perché un codice non entra: esce.
 * L'array `CODICI_ACCOUNT` serve a chi un codice lo RICEVE e deve riconoscerlo,
 * cioè al client, che lo importa da `shared/account`
 * (`client/src/components/Settings/accountState.ts`). Ri-esportarlo anche da
 * qui era una porta senza nessuno che ci passasse; il giorno in cui il server
 * dovesse validare un codice che gli arriva, la strada è la stessa del client —
 * importarlo da `shared/`, non ricopiare l'elenco.
 */
export type { CodiceAccount, AccountState } from "../../shared/account";
import type { CodiceAccount, AccountState } from "../../shared/account";

// ─────────────────────────────────────────────────────────────────────────────
// La configurazione
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dove vive il servizio degli account, se vive.
 *
 * Stessa normalizzazione di `leggiRelayUrl` e per lo stesso motivo — barra
 * finale via, solo `http`/`https` — ma variabile SEPARATA: relay e account sono
 * due servizi, e legarli vorrebbe dire che accendere l'uno accende l'altro.
 * Assente è il default: senza la variabile l'attivazione non si offre affatto,
 * e la macchina è identica a prima.
 */
export function leggiAccountUrl(env: Record<string, string | undefined>): string | null {
  const raw = (env.TOPICS_ACCOUNT_URL ?? "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.origin}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

/**
 * L'indirizzo, ridotto alla forma su cui si confronta e si scrive: senza spazi
 * e minuscolo. `null` se non ha la forma di un indirizzo.
 *
 * Il controllo è volutamente LARGO. Una regex severa sulle email rifiuta
 * indirizzi validi (i TLD lunghi, i `+`, gli unicode) e il prezzo di quel
 * rifiuto lo paga una persona vera che non riesce a entrare; a dire se
 * l'indirizzo esiste è il codice che ci arriva, non noi.
 */
export function normalizzaEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v.length < 3 || v.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return null;
  return v;
}

// ─────────────────────────────────────────────────────────────────────────────
// LO STATO: si legge dal database e da nient'altro
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Chi è collegato su questa installazione.
 *
 * `personId` è la persona di cui si chiede lo stato — normalmente quella che
 * agisce. Non fa rete e non solleva: uno schema anteriore alla 084 produce uno
 * stato «non collegato», che è la verità, invece di un errore.
 */
export function statoAccount(db: Db, personId: string | null, configured: boolean): AccountState {
  const vuoto: AccountState = {
    configured, linked: false, accountId: null, email: null,
    personId, personName: null, linkedAt: null,
  };
  if (!personId) return { ...vuoto, personId: null };
  try {
    const r = db.query(`
      SELECT id, display_name AS name, email, remote_id, synced_at
        FROM people WHERE id = ? AND revoked_at IS NULL`).get(personId) as
      { id: string; name: string; email: string | null; remote_id: string | null; synced_at: number | null } | undefined;
    if (!r) return vuoto;
    return {
      configured,
      linked: !!r.remote_id,
      accountId: r.remote_id,
      email: r.email,
      personId: r.id,
      personName: r.name,
      linkedAt: r.remote_id ? r.synced_at : null,
    };
  } catch {
    return vuoto;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// L'AGGANCIO
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Da COSA la riga di chi agisce è stata riconosciuta — non «quale riga è stata
 * scelta», che è sempre e solo quella di chi agisce (vedi `collegaAccount`):
 *   - `remote_id`: portava già QUESTO account. È una riattivazione.
 *   - `email`: portava già quell'indirizzo, da prima che ci fosse un account.
 *   - `acting`: né l'uno né l'altro. È la prima attivazione.
 *
 * NON esce sul filo. C'era, e nessuna superficie lo leggeva: un campo che
 * nessuno legge è una promessa di compatibilità presa senza motivo, e il giorno
 * in cui una schermata vorrà dire «bentornato» lo si rimette insieme al suo
 * lettore. Qui resta perché è l'unico modo, per un test, di vedere QUALE dei
 * tre riconoscimenti è scattato: senza, i tre casi si somigliano tutti.
 */
export type ComeRiconciliato = "remote_id" | "email" | "acting";

export type EsitoCollega =
  | { ok: true; personId: string; come: ComeRiconciliato }
  | { ok: false; codice: CodiceAccount };

export interface RemoteIdentity {
  accountId: string;
  email: string;
  /** Il nome sull'account. Facoltativo, e NON sovrascrive un nome già scelto
   *  qui: chi si è dato un nome sulla propria macchina non se lo vede cambiare
   *  da un servizio. Riempie solo un nome vuoto. */
  displayName?: string;
}

interface RigaPersona {
  id: string;
  remote_id: string | null;
  revoked_at: number | null;
}

/**
 * Aggancia l'identità remota a una persona che ESISTE GIÀ.
 *
 * Nessuna `INSERT INTO people`, in nessun ramo: se non c'è una persona a cui
 * agganciarsi il gesto si rifiuta con `no_person`. È l'invariante centrale di
 * questo modulo, e vale la pena dire perché non è pigrizia: la sola strada per
 * cui un servizio esterno potrebbe far comparire un abitante nuovo su questa
 * macchina passerebbe da qui, e chi ne fa comparire uno finisce, prima o poi,
 * per volerlo far comparire dentro `installation_owners`.
 */
export function collegaAccount(
  db: Db,
  o: { identita: RemoteIdentity; actingPersonId: string | null; now: number },
): EsitoCollega {
  const email = normalizzaEmail(o.identita.email);
  if (!email) return { ok: false, codice: "bad_response" };
  const accountId = o.identita.accountId.trim();
  if (!accountId) return { ok: false, codice: "bad_response" };

  try {
    // 1. IL BERSAGLIO È CHI STA AGENDO. Sempre, senza eccezioni: è ciò che tiene
    //    d'accordo i tre verbi della rotta, che alla domanda «chi sono» rispondono
    //    tutti con `actingPersonId`. Agganciare l'identità a una riga diversa
    //    faceva rispondere «fatto» a `verify` e «nessun account» alla `GET`
    //    subito dopo, con `DELETE` che cadeva sul proprio ramo idempotente e
    //    lasciava l'aggancio dov'era, irraggiungibile.
    if (!o.actingPersonId) return { ok: false, codice: "no_person" };
    const io = db.query(
      "SELECT id, remote_id, revoked_at FROM people WHERE id = ?",
    ).get(o.actingPersonId) as RigaPersona | undefined;
    if (!io || io.revoked_at !== null) return { ok: false, codice: "no_person" };

    // 2. LE DUE CHIAVI UNICHE, prima di scrivere. `idx_people_remote` e l'indice
    //    su `people(email)` sono UNIQUE e NON escludono le righe revocate:
    //    scrivere un valore che vive su un'altra riga salterebbe comunque, a
    //    runtime, nel punto peggiore. Qui si dichiara invece di scoprirlo.
    const perRemote = db.query(
      "SELECT id, remote_id, revoked_at FROM people WHERE remote_id = ?",
    ).get(accountId) as RigaPersona | undefined;
    if (perRemote && perRemote.id !== io.id) {
      return { ok: false, codice: perRemote.revoked_at !== null ? "person_revoked" : "belongs_to_other_person" };
    }
    const perEmail = db.query(
      "SELECT id, remote_id, revoked_at FROM people WHERE lower(email) = ?",
    ).get(email) as RigaPersona | undefined;
    if (perEmail && perEmail.id !== io.id) {
      return { ok: false, codice: perEmail.revoked_at !== null ? "person_revoked" : "belongs_to_other_person" };
    }

    // 3. E se la mia riga porta GIÀ un altro account, non glielo si sostituisce
    //    in silenzio: sposterebbe un'identità senza che nessuno l'abbia chiesto.
    if (io.remote_id && io.remote_id !== accountId) {
      return { ok: false, codice: "already_linked_other" };
    }

    const bersaglio = io.id;
    const come: ComeRiconciliato =
      io.remote_id === accountId ? "remote_id" : perEmail ? "email" : "acting";

    const nome = (o.identita.displayName ?? "").trim();
    // `rev` sale e `updated_at` si muove perché questa riga è appena diventata
    // riconciliabile: sono le colonne che la 084 ha messo apposta per il giorno
    // in cui due database si incontrano, e lasciarle ferme qui vorrebbe dire
    // consegnare a quel merge una riga che dice «non sono mai cambiata».
    // `synced_at` è il momento dell'aggancio: l'ultima volta che questa riga e
    // il servizio si sono detti qualcosa.
    db.query(`
      UPDATE people
         SET remote_id  = ?,
             email      = ?,
             display_name = CASE WHEN ? <> '' AND (display_name IS NULL OR display_name = '')
                                 THEN ? ELSE display_name END,
             rev        = rev + 1,
             updated_at = ?,
             synced_at  = ?
       WHERE id = ?`).run(accountId, email, nome, nome, o.now, o.now, bersaglio);
    return { ok: true, personId: bersaglio, come };
  } catch {
    // Tabelle assenti (schema anteriore alla 084) o un vincolo che non
    // avevamo previsto: non si inventa un aggancio a metà.
    return { ok: false, codice: "unavailable" };
  }
}

/**
 * Staccare l'account. È un gesto LOCALE e funziona senza rete — deve, perché
 * altrimenti un servizio giù ti lascerebbe legato a un'identità che non puoi
 * togliere.
 *
 * L'indirizzo NON si cancella: in questa casa l'email è un'etichetta della
 * rubrica da prima che esistessero gli account, e toglierla farebbe sparire una
 * persona dall'elenco di chi ti riconosce. Ciò che va via è `remote_id` — cioè
 * l'unica cosa che l'account aveva aggiunto.
 */
export function scollegaAccount(
  db: Db,
  personId: string | null,
  now: number,
): { ok: true } | { ok: false; codice: CodiceAccount } {
  if (!personId) return { ok: false, codice: "no_person" };
  try {
    const r = db.query("SELECT id, remote_id, revoked_at FROM people WHERE id = ?")
      .get(personId) as RigaPersona | undefined;
    if (!r || r.revoked_at !== null) return { ok: false, codice: "no_person" };
    // Già staccato: si risponde `ok` e non «sconosciuto». Il secondo clic su un
    // gesto idempotente non deve somigliare a un errore.
    if (!r.remote_id) return { ok: true };
    db.query(`
      UPDATE people SET remote_id = NULL, synced_at = NULL, rev = rev + 1, updated_at = ?
       WHERE id = ?`).run(now, personId);
    return { ok: true };
  } catch {
    return { ok: false, codice: "unavailable" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IL SERVIZIO REMOTO
// ─────────────────────────────────────────────────────────────────────────────

export type OutcomeNetwork<T> = { ok: true; dato: T } | { ok: false; codice: CodiceAccount };

export interface OpzioniServizio {
  baseUrl: string | null;
  /** Iniettabile: i test non aprono socket, e il modulo non conosce `globalThis`. */
  fetchImpl: typeof fetch;
  /** Va sul filo perché è il soggetto della licenza, ed è ciò che permette al
   *  servizio di legare un codice a QUESTA macchina. Non è un segreto
   *  (`server/services/relay-config.ts`). */
  installationId: string;
  /** Oltre questo, la risposta non arriverà: meglio un rifiuto dichiarato che
   *  un'interfaccia appesa. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Da uno stato HTTP a un codice. `rifiutato` è il codice del caso «il servizio
 *  ha risposto e ha detto di no», che è diverso per le due chiamate: chiedere
 *  un codice a un indirizzo che non va bene non è la stessa cosa che sbagliare
 *  il codice. */
function codeFromState(status: number, rifiutato: CodiceAccount): CodiceAccount {
  if (status === 429) return "rate_limited";
  if (status >= 500) return "service_unreachable";
  return rifiutato;
}

async function chiamata<T>(
  o: OpzioniServizio,
  percorso: string,
  corpo: Record<string, unknown>,
  rifiutato: CodiceAccount,
  leggi: (b: Record<string, unknown>) => T | null,
): Promise<OutcomeNetwork<T>> {
  if (!o.baseUrl) return { ok: false, codice: "not_configured" };
  let res: Response;
  try {
    res = await o.fetchImpl(`${o.baseUrl}${percorso}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...corpo, installationId: o.installationId }),
      signal: AbortSignal.timeout(o.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch {
    // Rete caduta, DNS, timeout: da qui è un fatto solo, ed è transitorio.
    return { ok: false, codice: "service_unreachable" };
  }
  if (!res.ok) return { ok: false, codice: codeFromState(res.status, rifiutato) };
  let bodyReply: unknown;
  try {
    bodyReply = await res.json() as unknown;
  } catch {
    return { ok: false, codice: "bad_response" };
  }
  if (!bodyReply || typeof bodyReply !== "object") return { ok: false, codice: "bad_response" };
  const dato = leggi(bodyReply as Record<string, unknown>);
  // Un `200` con un carico che non è quello atteso NON si interpreta: è un
  // servizio che risponde un'altra cosa, e crederci vorrebbe dire agganciare
  // l'identità di qualcuno a un valore inventato.
  if (dato === null) return { ok: false, codice: "bad_response" };
  return { ok: true, dato };
}

/**
 * «Manda un codice a questo indirizzo.» Non dice se l'indirizzo esiste — quella
 * è una domanda a cui un servizio di account non deve rispondere a chi non ha
 * ancora dimostrato niente.
 */
export function chiediCodice(
  o: OpzioniServizio,
  email: string,
): Promise<OutcomeNetwork<{ expiresAt: number | null }>> {
  return chiamata(o, "/v1/account/code", { email }, "service_refused", (b) => ({
    expiresAt: typeof b.expiresAt === "number" && Number.isFinite(b.expiresAt) ? b.expiresAt : null,
  }));
}

/** «Questo è il codice»: in cambio, l'identità remota. */
export function verificaCodice(
  o: OpzioniServizio,
  email: string,
  codice: string,
): Promise<OutcomeNetwork<RemoteIdentity>> {
  return chiamata(o, "/v1/account/verify", { email, code: codice }, "bad_code", (b) => {
    const accountId = typeof b.accountId === "string" ? b.accountId.trim() : "";
    const indirizzo = normalizzaEmail(b.email) ?? normalizzaEmail(email);
    if (!accountId || !indirizzo) return null;
    const nome = typeof b.displayName === "string" ? b.displayName.trim() : "";
    return { accountId, email: indirizzo, displayName: nome || undefined };
  });
}
