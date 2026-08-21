import type { AppContext, RouteHandler } from "../types";
import {
  hashToken, mintSessionToken, mintPairingCode,
  buildSessionCookie, buildClearedSessionCookie,
  readSessionCookie, PAIRING_CODE_TTL_MS,
  type DeviceRecord,
} from "../lib/device-auth";
import { isLoopbackAddress } from "../lib/auth-gate";
import { isLocalTransport } from "../lib/tunnel";
import { resolveIdentity } from "../lib/identity";
import { resolvePrincipals } from "../lib/principals";
import { isResourceType } from "../lib/grants";
import { valutaQuota } from "../lib/pairing-quota";
import { nuovaChiave } from "../../shared/relay-crypto";
import {
  grantedByType, subjectsOf, putGrant, dropGrant, type SubjectKind,
} from "../lib/grants-query";
import {
  installationOrgId, liveMemberCount, orgRole, canAdministerOrg, liveOwnerCount,
  actingPersonId, isOrgRole, orgAlive, type OrgRole,
} from "../lib/orgs";
import { consentito } from "../lib/licenza";
import { subjectRejection, canReceive, livePersonMemberships } from "../lib/recipients";

/**
 * Appaiamento e sessioni per dispositivo.
 *
 * IL VERSO: il dispositivo nuovo MOSTRA un codice, la macchina già fidata lo
 * CONFERMA. Non è estetica. Uno schema in cui il telefono inserisce un PIN va
 * difeso dal brute-force con un rate limiter, e in questo server non ne esiste
 * nessuno (zero `429` in tutto il repo). Invertendo il verso il pezzo rischioso
 * sparisce: il codice non è un segreto da indovinare ma un'etichetta da
 * confrontare, e chi approva è già dentro.
 *
 * Le richieste in attesa vivono in MEMORIA, non nel DB. Durano tre minuti — il
 * tempo di girare lo sguardo da uno schermo all'altro — e un riavvio del server
 * le azzera, che è l'esito giusto: una richiesta sopravvissuta a un riavvio è
 * una richiesta che nessuno sta più guardando.
 */

interface PendingPairing {
  id: string;
  code: string;
  /**
   * Il segreto di RITIRO, e non è la stessa cosa del `requestId`.
   *
   * Il riferimento gira: `auth:pair-requested` lo porta alle socket del
   * proprietario perché il cartello di approvazione possa comparire. Il gettone
   * invece esce una volta sola, e deve uscire verso CHI HA CHIESTO — non verso
   * chiunque abbia visto passare il riferimento. Tenerli separati è ciò che
   * rende innocuo il primo: nasce qui, torna solo nella risposta alla richiesta,
   * e non compare in nessun frame.
   */
  claim: string;
  name: string;
  ip: string | null;
  createdAt: number;
  state: "pending" | "approved" | "denied";
  /** Valorizzato solo dopo l'approvazione, e consegnato UNA volta sola. */
  token: string | null;
}

const pending = new Map<string, PendingPairing>();

/** I timer di scadenza, uno per richiesta. Vivono accanto alla mappa e non
 *  dentro l'oggetto: `PendingPairing` è ciò che si consegna e si serializza,
 *  e un handle di timer lì dentro sarebbe una cosa che non si può guardare. */
const scadenze = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Quante socket vive ha ciascun dispositivo, adesso. Un conteggio e non un
 * booleano perche' un dispositivo apre piu' socket (quella primaria, i
 * terminali, il browser): decrementare a una chiusura non deve spegnere il
 * pallino se le altre sono ancora su.
 *
 * Vive in memoria e non nel DB: e' uno stato di CONNESSIONE, non un fatto da
 * ricordare. Un riavvio del server azzera tutte le socket davvero, quindi
 * azzerare la mappa e' la verita', non una perdita.
 */
const liveSockets = new Map<string, number>();

export function noteDeviceConnected(deviceId: string): void {
  liveSockets.set(deviceId, (liveSockets.get(deviceId) ?? 0) + 1);
}

export function noteDeviceDisconnected(deviceId: string): void {
  const n = (liveSockets.get(deviceId) ?? 0) - 1;
  if (n > 0) liveSockets.set(deviceId, n);
  else liveSockets.delete(deviceId);
}

/** Test-only: la mappa e' di modulo, e un test che conta le socket deve poter
 *  ripartire da zero. */
export function __resetLiveSocketsForTests(): void {
  liveSockets.clear();
}

/**
 * Test-only: azzera le richieste di appaiamento in attesa.
 *
 * Serve per la stessa ragione per cui `pending` vive in memoria e non nel DB —
 * e' stato di sessione, non un fatto da ricordare — ma in un file di test tutti
 * i casi condividono il modulo, quindi le richieste di un caso restano appese
 * al successivo finche' non scadono (tre minuti: un'eternita' per una suite).
 * Senza questo, il tetto complessivo scatta a meta' suite e i casi dopo
 * falliscono per un motivo che non e' il loro.
 */
export function __resetPendingForTests(): void {
  pending.clear();
  // I timer vanno spenti, non solo dimenticati: uno lasciato acceso spara in
  // mezzo al test successivo e ne annuncia la scadenza di una richiesta che
  // quel test non ha mai fatto.
  for (const t of scadenze.values()) clearTimeout(t);
  scadenze.clear();
}

/** Invecchia una richiesta in attesa, per provare la scadenza senza aspettare
 *  tre minuti veri. Tocca `createdAt` e basta: il tempo lo legge `sweep`, e un
 *  test che spostasse l'orologio proverebbe un mondo diverso da quello vero. */
export function __invecchiaPendingPerTests(id: string, di: number): void {
  const p = pending.get(id);
  if (p) p.createdAt -= di;
}

function scordaScadenza(id: string): void {
  const t = scadenze.get(id);
  if (t !== undefined) { clearTimeout(t); scadenze.delete(id); }
}

function sweep(now: number, avvisa?: (id: string) => void): void {
  for (const [id, p] of pending) {
    if (now - p.createdAt > PAIRING_CODE_TTL_MS) {
      pending.delete(id); scordaScadenza(id);
      scordaScadenza(id);
      // Scomparire in silenzio non basta. Il cartello di approvazione compare
      // per un broadcast (`auth:pair-requested`) e vive nella memoria del
      // client: senza l'annuncio contrario resta sullo schermo per sempre, e
      // chi lo clicca prende un 404 su una richiesta che il server ha
      // dimenticato da un pezzo. Su un endpoint esposto a Internet è peggio
      // che un fastidio: la richiesta di uno sconosciuto continua a invitare
      // un clic molto dopo che avrebbe dovuto sparire.
      avvisa?.(id);
    }
  }
}

/**
 * Un nome leggibile a partire dallo user-agent. «iPhone» dice a un umano cosa
 * sta autorizzando; «Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X)…»
 * no — e un elenco di dispositivi illeggibile è un elenco che non si guarda.
 */
export function deviceNameFromUserAgent(ua: string | null): string {
  if (!ua) return "Dispositivo sconosciuto";
  const m: Array<[RegExp, string]> = [
    [/iPhone/i, "iPhone"],
    [/iPad/i, "iPad"],
    [/Android/i, "Android"],
    [/Macintosh|Mac OS X/i, "Mac"],
    [/Windows/i, "Windows"],
    [/Linux/i, "Linux"],
  ];
  for (const [re, label] of m) if (re.test(ua)) return label;
  return "Dispositivo sconosciuto";
}

function isSubjectKind(v: string): v is SubjectKind {
  return v === "device" || v === "person" || v === "org";
}

/**
 * I DISPOSITIVI da avvisare quando cambia una concessione verso un soggetto.
 *
 * Non è lo stesso del soggetto: condividere con una PERSONA deve svegliare
 * tutti i suoi dispositivi, e condividere con un'organizzazione tutti quelli
 * dei suoi membri. Mandare al solo soggetto funzionerebbe unicamente nel caso
 * degenere in cui il soggetto È un dispositivo — cioè quello che stiamo
 * smettendo di dare per scontato.
 */
function dispositiviDelSoggetto(
  db: { query: (sql: string) => { all: (...a: unknown[]) => unknown[] } },
  kind: SubjectKind,
  id: string,
): string[] {
  try {
    if (kind === "device") return [id];
    if (kind === "person") {
      return (db.query("SELECT id FROM devices WHERE person_id = ? AND revoked_at IS NULL").all(id) as Array<{ id: string }>)
        .map((r) => r.id);
    }
    return (db.query(`
      SELECT d.id FROM devices d
        JOIN org_members om ON om.person_id = d.person_id
       WHERE om.org_id = ? AND om.revoked_at IS NULL AND om.local_blocked_at IS NULL
         AND d.revoked_at IS NULL`).all(id) as Array<{ id: string }>).map((r) => r.id);
  } catch {
    // Schema più vecchio della 084: resta il solo caso che esisteva.
    return kind === "device" ? [id] : [];
  }
}

/**
 * Togliere a un dispositivo revocato anche le PUSH.
 *
 * Chiudergli le socket non bastava: la push non passa da un filo aperto, la
 * consegna Apple o Google a partire da una riga di `push_subscriptions`. Finché
 * quella riga c'era, un telefono revocato continuava a ricevere titoli di task,
 * domande degli agenti e descrizioni di approvazione — per sempre, e senza
 * nessun modo di accorgersene da questa parte.
 *
 * Si CANCELLA e non si spegne (`enabled = 0`): quella colonna è la preferenza
 * dell'utente, e riusarla per una revoca vorrebbe dire che riappaiare il
 * telefono lo troverebbe «spento» senza che nessuno l'abbia spento. La riga
 * nuova la scrive la prossima `subscribe`, che è comunque obbligatoria — le
 * chiavi del push manager non sopravvivono a una revoca.
 *
 * DOVE **NON** VA, e prima ci andava: togliere qualcuno da un gruppo, o
 * cancellare un gruppo. Quei due gesti passano da `dispositiviDelSoggetto`, che
 * per costruzione restituisce solo dispositivi con `revoked_at IS NULL` — cioè
 * telefoni ancora appaiati e legittimi, che restano tali. Cancellargli la riga
 * di push era una revoca dell'HARDWARE fatta per sbaglio: la push spariva per
 * sempre mentre il client continuava a mostrare «iscritto», perché quello stato
 * lo legge dal browser e non dal server. I punti veri sono DUE: la revoca del
 * dispositivo e il logout, cioè i due posti in cui `devices.revoked_at` viene
 * scritto.
 *
 * Esportata perché il test la guidi con un db finto: la distinzione fra «la
 * colonna non c'è» e «è andato storto qualcos'altro» non si può misurare da
 * fuori, e senza quella distinzione il `catch` muto rendeva i due casi
 * indistinguibili.
 */
export function dimenticaPush(
  db: { query: (sql: string) => { run: (...a: unknown[]) => unknown } },
  deviceId: string,
): void {
  try {
    db.query("DELETE FROM push_subscriptions WHERE auth_device_id = ?").run(deviceId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Schema più vecchio della colonna (o della tabella): non c'è niente da
    // togliere, e una revoca non deve fallire per le notifiche.
    if (/no such column|no such table/i.test(msg)) return;
    // Tutto il resto è un guasto vero, e il suo esito è che un dispositivo
    // appena revocato CONTINUA a ricevere push. Il `catch {}` muto lo
    // ingoiava: qui almeno lascia una traccia leggibile.
    console.error(`[Push] revoca ${deviceId}: iscrizioni NON rimosse — ${msg}`);
  }
}

/**
 * A quale persona appartiene il dispositivo che si sta approvando.
 *
 * `deciso: false` vuol dire che lo schema non ha ancora le persone (più vecchio
 * della 084) o che il chiamante non ha detto niente e non c'è un proprietario
 * di default: in quel caso si ricade sul vecchio `role`, invece di inventare.
 */
function risolvePersonaPerAppaiamento(
  db: { query: (sql: string) => { get: (...a: unknown[]) => unknown; run: (...a: unknown[]) => unknown } },
  personId: unknown,
  personName: unknown,
  now: number,
): { deciso: boolean; personId: string | null; owner: boolean } {
  const nulla = { deciso: false, personId: null, owner: false };
  try {
    if (typeof personId === "string" && personId) {
      const p = db.query("SELECT revoked_at FROM people WHERE id = ?").get(personId) as { revoked_at: number | null } | undefined;
      if (!p || p.revoked_at !== null) return nulla;
      const owner = !!db.query("SELECT 1 FROM installation_owners WHERE person_id = ?").get(personId);
      return { deciso: true, personId, owner };
    }
    if (typeof personName === "string" && personName.trim()) {
      // Una persona NUOVA non è proprietaria: chi arriva per la prima volta
      // vede solo ciò che gli si condivide, e diventare proprietari è un gesto
      // a parte. Il verso opposto — nuovo quindi proprietario — trasformerebbe
      // un errore di battitura in un accesso pieno.
      const id = crypto.randomUUID().replace(/-/g, "");
      db.query(
        "INSERT INTO people (id, display_name, created_at, origin, rev, updated_at) VALUES (?,?,?,'local',1,?)",
      ).run(id, personName.trim().slice(0, 60), now, now);
      return { deciso: true, personId: id, owner: false };
    }
    // Niente detto: è il proprietario di default, se c'è.
    const io = db.query("SELECT person_id FROM installation_owners ORDER BY is_default DESC LIMIT 1")
      .get() as { person_id: string } | undefined;
    if (!io) return nulla;
    return { deciso: true, personId: io.person_id, owner: true };
  } catch {
    return nulla;
  }
}

export function createAuthRouter(ctx: AppContext): RouteHandler {
  const { json, readJSON, db } = ctx as AppContext & { db: { query: (sql: string) => { all: (...a: unknown[]) => unknown[]; get: (...a: unknown[]) => unknown; run: (...a: unknown[]) => unknown } } };

  const rowToDevice = (r: Record<string, unknown>): DeviceRecord => ({
    id: String(r.id),
    name: String(r.name),
    tokenHash: String(r.token_hash),
    createdAt: Number(r.created_at),
    lastSeenAt: r.last_seen_at === null ? null : Number(r.last_seen_at),
    firstIp: r.first_ip === null ? null : String(r.first_ip),
    revokedAt: r.revoked_at === null ? null : Number(r.revoked_at),
    role: r.role === 'guest' ? 'guest' : 'owner',
  });

  /** Le persone note, per raggruppare l'elenco e per offrire lo spostamento. */
  const elencoPersone = (): Array<{ id: string; name: string; owner: boolean }> => {
    try {
      return (db.query(`
        SELECT p.id, p.display_name AS name,
               (p.id IN (SELECT person_id FROM installation_owners)) AS owner
          FROM people p WHERE p.revoked_at IS NULL ORDER BY owner DESC, p.display_name
      `).all() as Array<{ id: string; name: string; owner: number }>)
        .map((p) => ({ id: p.id, name: p.name, owner: !!p.owner }));
    } catch {
      // Schema più vecchio della 084: nessuna persona, e il pannello resta
      // quello di prima invece di rompersi.
      return [];
    }
  };

  const personaDi = (deviceId: string): { id: string; name: string } | null => {
    try {
      const r = db.query(
        "SELECT p.id, p.display_name AS name FROM devices d JOIN people p ON p.id = d.person_id WHERE d.id = ?",
      ).get(deviceId) as { id: string; name: string } | undefined;
      return r ?? null;
    } catch { return null; }
  };

  const listDevices = (): DeviceRecord[] =>
    (db.query("SELECT * FROM devices ORDER BY revoked_at IS NOT NULL, last_seen_at DESC, created_at DESC").all() as Record<string, unknown>[])
      .map(rowToDevice);

  return async function authRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {
    if (!pathname.startsWith("/api/auth/")) return null;
    const now = Date.now();
    sweep(now, (id) => ctx.broadcast?.({ type: "auth:pair-resolved", requestId: id, approved: false }));
    const ip = ctx.requestIp?.(req) ?? null;
    // La stessa domanda del gate, e va posta con la stessa funzione: attraverso
    // il tunnel il peer È loopback, quindi `isLoopbackAddress(ip)` da solo
    // direbbe «sei la macchina» a chi ha bussato da Internet. Misurato: prima di
    // questa riga `/api/auth/session` rispondeva `as:"loopback", role:"owner"`
    // sulla porta del tunnel. Questo è il TERZO posto che traduceva l'identità
    // per conto suo — ed è il costo di averne tre.
    const loopback = isLocalTransport(req, ip, isLoopbackAddress);
    const secure = url.protocol === "https:";

    // ── Chi sono? Esente dall'identità: è la domanda che si fa PRIMA di averla.
    if (method === "GET" && pathname === "/api/auth/session") {
      // La STESSA traduzione del cancello e dell'upgrade WS. Era la terza copia
      // della domanda, con una terza query e una terza forma: ed è quella che
      // ha continuato a rispondere «sei la macchina» sulla porta del tunnel,
      // perché la sua copia non era stata aggiornata insieme alle altre.
      const io = resolveIdentity(db as never, req.headers.get("cookie"), loopback);
      if (io.locale) {
        return json({ paired: true, as: "loopback", name: "Questo computer", role: "owner" });
      }
      if (!io.device) return json({ paired: false, as: null, name: null });
      if (io.device.revokedAt !== null) {
        return json({ paired: false, as: null, name: null, code: "device_revoked" });
      }
      return json({
        paired: true, as: "device", name: io.device.name, deviceId: io.device.id,
        role: io.confined ? "guest" : "owner",
        // La persona, quando c'è: è ciò che il client mostrerà al posto del nome
        // del ferro appena l'interfaccia saprà parlarne.
        personId: io.personId,
      });
    }

    // ── Il dispositivo nuovo chiede accesso e riceve il codice DA MOSTRARE.
    if (method === "POST" && pathname === "/api/auth/pair/request") {
      // `sweep` è già passato: ciò che resta è vivo, non residuo.
      //
      // La coda piena NON respinge chi arriva: sfratta la richiesta più vecchia
      // dell'indirizzo che ne ha di più. Col tetto applicato come rifiuto, sette
      // indirizzi con tre richieste a testa bastavano a impedire al PROPRIETARIO
      // di appaiare il proprio telefono — un dispetto che non fa entrare nessuno
      // ma impedisce a te di far entrare qualcuno.
      const esito = valutaQuota([...pending.values()], ip);
      if (!esito.ok) return json({ error: "too_many_requests" }, 429);
      if (esito.sfratta) {
        // Evicting is not just dropping a map entry. The evicted request has
        // already raised a card on the owner's machine (`auth:pair-requested`)
        // and owns a live timer that would later announce the expiry of an id
        // that no longer exists.
        //
        // Without these two lines the card stays on screen forever and whoever
        // clicks it gets `pairing_expired` for a request the server forgot:
        // exactly the defect `sweep` exists to prevent, reopened through the
        // other door. That door now opens on every request past the cap.
        pending.delete(esito.sfratta);
        scordaScadenza(esito.sfratta);
        ctx.broadcast?.({ type: "auth:pair-resolved", requestId: esito.sfratta, approved: false });
      }
      const name = deviceNameFromUserAgent(req.headers.get("user-agent"));
      const id = crypto.randomUUID();
      const entry: PendingPairing = {
        id, code: mintPairingCode(), name, ip, createdAt: now, state: "pending", token: null,
        // 256 bit: non è un codice da leggere ad alta voce, è un segreto da
        // rimandare indietro.
        claim: crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, ""),
      };
      pending.set(id, entry);
      // La scadenza si annuncia DA SOLA, senza aspettare che qualcuno bussi.
      //
      // `sweep` gira all'inizio di ogni richiesta `/api/auth/*`, e per la
      // memoria del server basta. Ma il cartello vive nel client: se in quei
      // tre minuti nessuno chiama nulla, nessuno spazza, nessuno annuncia, e
      // la scheda resta sullo schermo. Il timer è ciò che rende la scadenza
      // una cosa che ACCADE invece di una che si scopre.
      //
      // `unref` perché un appaiamento in attesa non deve tenere in piedi il
      // processo: allo spegnimento la richiesta muore comunque, ed è l'esito
      // giusto — una richiesta sopravvissuta a un riavvio è una richiesta che
      // nessuno sta più guardando.
      const t = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id); scordaScadenza(id);
        scadenze.delete(id);
        ctx.broadcast?.({ type: "auth:pair-resolved", requestId: id, approved: false });
      }, PAIRING_CODE_TTL_MS);
      (t as unknown as { unref?: () => void }).unref?.();
      scadenze.set(id, t);
      // Il frame porta il riferimento e il codice — servono al cartello di
      // approvazione — ma NON il `claim`, che è l'unica cosa capace di ritirare
      // il gettone. È la separazione che rende innocuo il resto.
      ctx.broadcast?.({ type: "auth:pair-requested", requestId: id, code: entry.code, name, ip });
      return json({ requestId: id, code: entry.code, claim: entry.claim, name, expiresInMs: PAIRING_CODE_TTL_MS });
    }

    // ── Il dispositivo nuovo attende. Alla conferma riceve il cookie, UNA volta.
    // NOTA: esente dall'identita' (`isIdentityExemptPath`) — un dispositivo in
    // attesa non ne ha ancora una, ed e' proprio questa risposta a dargliela.
    if (method === "GET" && pathname === "/api/auth/pair/status") {
      const id = url.searchParams.get("requestId") ?? "";
      const entry = pending.get(id);
      // Riferimento sconosciuto e segreto sbagliato danno la STESSA risposta:
      // distinguerli direbbe a chi prova «questo riferimento esiste», che è
      // metà del lavoro.
      if (!entry || entry.claim !== (url.searchParams.get("claim") ?? "")) return json({ state: "expired" });
      if (entry.state === "denied") { pending.delete(id); return json({ state: "denied" }); }
      if (entry.state !== "approved" || !entry.token) return json({ state: "pending" });
      // Consegna unica: il token esce dalla memoria appena tocca il filo.
      const token = entry.token;
      pending.delete(id); scordaScadenza(id);
      // `json()` non porta header extra: qui serve `Set-Cookie`, quindi la
      // Response si costruisce a mano.
      return new Response(JSON.stringify({ state: "approved", name: entry.name }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "Set-Cookie": buildSessionCookie(token, { secure }),
        },
      });
    }

    // ── Da qui in giù serve già un'identità: il gate l'ha imposta a monte.

    if (method === "GET" && pathname === "/api/auth/pair/pending") {
      return json({
        requests: [...pending.values()]
          .filter((p) => p.state === "pending")
          .map(({ id, code, name, ip: from, createdAt }) => ({ id, code, name, ip: from, createdAt })),
      });
    }

    if (method === "POST" && (pathname === "/api/auth/pair/approve" || pathname === "/api/auth/pair/deny")) {
      const body = await readJSON(req) as {
        requestId?: string; role?: unknown; personId?: unknown; personName?: unknown;
      } | null;
      const entry = pending.get(body?.requestId ?? "");
      if (!entry) return json({ error: "pairing_expired" }, 404);

      if (pathname.endsWith("/deny")) {
        entry.state = "denied";
        ctx.broadcast?.({ type: "auth:pair-resolved", requestId: entry.id, approved: false });
        return json({ ok: true });
      }

      const token = mintSessionToken();
      const deviceId = crypto.randomUUID();

      // ── DI CHI È questo dispositivo, e il ruolo che ne DISCENDE.
      //
      // Il cartello chiede la persona, non il ruolo: il ruolo è derivato, e
      // chiederlo inviterebbe a contraddire il modello — si potrebbe dire
      // «proprietario» di un dispositivo attribuito a un estraneo, e allora
      // quale delle due frasi sarebbe quella vera?
      //
      // `personId` = una persona che c'è già. `personName` = una nuova, che è
      // il caso «lo sto dando a qualcun altro». Nessuno dei due = il
      // proprietario, che è il caso normale (il tuo secondo telefono).
      const pers = risolvePersonaPerAppaiamento(db, body?.personId, body?.personName, now);
      // `owner` DISCENDE dall'essere proprietari dell'installazione, non da una
      // scelta a parte. `role` resta accettato come alias legacy finché la
      // colonna esiste: un client non aggiornato continua a funzionare.
      const role = pers.deciso
        ? (pers.owner ? "owner" : "guest")
        : (body?.role === "guest" ? "guest" : "owner");
      db.query(
        "INSERT INTO devices (id, name, token_hash, created_at, last_seen_at, first_ip, revoked_at, role) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
      ).run(deviceId, entry.name, hashToken(token), now, now, entry.ip, role);
      if (pers.personId) {
        try {
          db.query("UPDATE devices SET person_id = ? WHERE id = ?").run(pers.personId, deviceId);
        } catch { /* schema più vecchio della 084 */ }
      }
      entry.state = "approved";
      entry.token = token;
      ctx.broadcast?.({ type: "auth:pair-resolved", requestId: entry.id, approved: true, deviceId });
      return json({ ok: true, deviceId, role });
    }

    if (method === "GET" && pathname === "/api/auth/devices") {
      const token = loopback ? null : readSessionCookie(req.headers.get("cookie"));
      const questoHash = token ? hashToken(token) : null;
      return json({
        // Il computer e' un dispositivo come gli altri e deve comparire: chiedere
        // «i miei dispositivi» e vedere solo gli altri e' una lista che mente per
        // omissione. Non ha una riga nel DB — qui si e' dentro per trasporto, non
        // per sessione — quindi la si compone, e non e' revocabile: revocare il
        // computer da cui gira il server non vuol dire niente.
        thisComputer: { name: "Questo computer", current: loopback },
        // Le persone conosciute, così l'elenco può raggruppare per PERSONA e
        // offrire lo spostamento. Senza, il pannello sa solo di ferri.
        people: elencoPersone(),
        devices: listDevices().map((d) => ({
          id: d.id, name: d.name, role: d.role, createdAt: d.createdAt,
          person: personaDi(d.id),
          lastSeenAt: d.lastSeenAt, firstIp: d.firstIp, revokedAt: d.revokedAt,
          // CONNESSO adesso, che non e' «autorizzato»: un dispositivo puo' essere
          // autorizzato da settimane e spento da ieri.
          connected: (liveSockets.get(d.id) ?? 0) > 0,
          // Quello da cui stai guardando. Senza, con tre iPhone in elenco non si
          // sa quale si sta per revocare — e ci si taglia fuori da soli.
          current: questoHash !== null && d.tokenHash === questoHash,
        })),
      });
    }

    // Rinomina. «iPhone» basta con un telefono; con tre l'elenco smette di
    // essere leggibile, e un elenco che non si legge non lo si guarda — cioe' la
    // revoca smette di avere un posto da cui partire.
    if (method === "PATCH" && pathname.startsWith("/api/auth/devices/")) {
      const id = decodeURIComponent(pathname.slice("/api/auth/devices/".length));
      const body = await readJSON(req) as { name?: unknown; personId?: unknown } | null;

      // ── Riassegnare un dispositivo a un'altra PERSONA.
      //
      // È la leva di correzione del backfill della 084, e senza di essa quella
      // migration è una consegna a metà: al momento dell'appaiamento nessuno
      // chiedeva di chi fosse un dispositivo, quindi il telefono di un collega
      // approvato una volta è finito sulla stessa persona dei tuoi. Se non si
      // può spostare, quell'errore è per sempre.
      //
      // NON tocca nessuna concessione: le grant puntano a una persona, e
      // spostare il ferro da una persona all'altra non è dire che le cose
      // condivise si spostano con lui.
      if ("personId" in (body ?? {})) {
        const pid = body?.personId;
        if (pid !== null && typeof pid !== "string") {
          return json({ error: "bad_person_id" }, 400);
        }
        try {
          if (pid !== null) {
            const p = db.query("SELECT revoked_at FROM people WHERE id = ?").get(pid) as { revoked_at: number | null } | undefined;
            if (!p) return json({ error: "unknown_person" }, 404);
            if (p.revoked_at !== null) return json({ error: "person_revoked" }, 400);
          }
          db.query("UPDATE devices SET person_id = ? WHERE id = ?").run(pid, id);
        } catch {
          return json({ error: "db_unavailable" }, 400);
        }
        // Il ruolo derivato può essere cambiato: le socket aperte portano
        // ancora quello di prima, timbrato all'upgrade e non più riletto.
        ctx.closeDeviceSockets?.(id);
        ctx.broadcast?.({ type: "auth:device-revoked", deviceId: id });
        return json({ ok: true, personId: pid });
      }

      const name = typeof body?.name === "string" ? body.name.trim().slice(0, 60) : "";
      if (!name) return json({ error: "name_required" }, 400);
      db.query("UPDATE devices SET name = ? WHERE id = ?").run(name, id);
      return json({ ok: true, name });
    }

    if (method === "DELETE" && pathname.startsWith("/api/auth/devices/")) {
      const id = decodeURIComponent(pathname.slice("/api/auth/devices/".length));
      // Revoca, non DELETE: una riga cancellata non racconta niente, una revocata
      // dice che quel dispositivo c'è stato e quando gli è stata tolta la fiducia.
      db.query("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id);
      // Prima il filo, poi l'annuncio. Una socket già aperta conserva l'identità
      // timbrata all'upgrade e non la rilegge: senza chiuderla, «revocato»
      // valeva sulle richieste HTTP e non su ciò che continuava ad arrivare.
      ctx.closeDeviceSockets?.(id);
      // E la push, che non passa da nessun filo: vedi `dimenticaPush`.
      dimenticaPush(db, id);
      ctx.broadcast?.({ type: "auth:device-revoked", deviceId: id });
      return json({ ok: true });
    }

    // ── Cosa ho, se sono un ospite.
    //
    // Esiste perché un ospite non può usare gli elenchi normali: `/api/topics` e
    // `/api/all-boards/tasks` restituiscono un INSIEME, e un gate che vede il
    // percorso non può filtrarne il corpo. Aggiungerli all'allowlist significava
    // consegnarli interi — provato, rispondeva 200 con tutte le chat.
    //
    // Questa rotta è l'opposto: parte dalle CONCESSIONI e va a prendere solo
    // quelle. Non può perdere niente perché non ha niente da filtrare.
    if (method === "GET" && pathname === "/api/auth/shared") {
      const ident = ctx.requestIdentity?.(req) ?? null;
      const subj = ident?.deviceId;
      if (!subj) return json({ tasks: [], topics: [] });
      // TUTTI i principali, non il solo ferro: sé stesso, la sua persona, le
      // organizzazioni vive di quella persona. È lo STESSO insieme con cui il
      // cancello (`server.ts`) decide se lasciar passare `/api/topics/:id`, e
      // deve esserlo — la domanda è una sola, e due risposte diverse alla stessa
      // domanda sono un difetto per costruzione.
      //
      // Il verso della divergenza era quello cattivo: la rubrica di
      // `/api/auth/subjects` offre la PERSONA quando il dispositivo ne ha una —
      // che è sempre, perché «è di un'altra persona» è il gesto che crea un
      // ospite — quindi ogni condivisione fatta dall'interfaccia atterrava su un
      // soggetto che il cancello onorava e l'inventario non vedeva. La chat era
      // leggibile per id e invisibile nell'unico elenco che un ospite ha.
      const { task: idTask, topic: idTopic } = grantedByType(db as never, resolvePrincipals(db as never, subj).list);
      const segna = (n: number) => Array(n).fill("?").join(",");
      const tasks = idTask.length
        ? db.query(`SELECT id, text, status, project_id, preview_image FROM tasks WHERE id IN (${segna(idTask.length)})`).all(...idTask)
        : [];
      const topics = idTopic.length
        ? db.query(`SELECT id, name, updated_at FROM topics WHERE id IN (${segna(idTopic.length)})`).all(...idTopic)
        : [];
      return json({ tasks, topics });
    }

    // ── Condivisione di un task con un ospite.
    // Vive qui e non in `routes/tasks.ts` perché è una decisione sui DISPOSITIVI:
    // chi può vedere cosa. Il filtro che la fa valere sta invece nel router dei
    // task, in un punto solo prima dello smistamento.
    // ── La RUBRICA dei destinatari.
    //
    // Esiste perché finora non esisteva: al suo posto si usava l'elenco dei
    // dispositivi filtrato per ruolo, il che rendeva letteralmente impossibile
    // condividere con qualcuno che non avesse ancora appaiato un telefono.
    // «Invitare» significava aspettare che il suo dispositivo comparisse, cioè
    // l'ordine rovesciato rispetto a come lo si racconta.
    if (method === "GET" && pathname === "/api/auth/subjects") {
      const soggetti: Array<{ subjectType: SubjectKind; subjectId: string; name: string; devices: number }> = [];

      // Quali dispositivi ospiti hanno già una PERSONA. Quelli non si offrono
      // come destinatari: la persona è il bersaglio migliore perché copre tutti
      // i suoi dispositivi, e offrirli entrambi mostrerebbe lo stesso umano due
      // volte con due significati diversi — «al suo portatile» e «a lui».
      let conPersona = new Set<string>();
      try {
        conPersona = new Set(
          (db.query("SELECT id FROM devices WHERE person_id IS NOT NULL").all() as Array<{ id: string }>)
            .map((r) => r.id),
        );
      } catch { /* schema più vecchio della 084 */ }

      // ── AUTORIZZAZIONE e PRESENTAZIONE, e restano due cose.
      //
      // Chi PUÒ ricevere lo decide `subjectRejection` — la stessa funzione che
      // usa `POST /api/auth/shares`, e non una seconda copia scritta qui: la
      // copia che c'era si era già separata dal cancello su un caso (la persona
      // tolta da ogni gruppo), e la rubrica la nascondeva mentre la POST la
      // accettava.
      //
      // Questa rubrica può essere più STRETTA per ragioni di disegno — non
      // offre un ospite che ha già una persona, né un gruppo da un membro solo
      // — ma non più LARGA. Le due righe qui sotto sono quelle ragioni, e sono
      // marcate come tali: unificarle dentro l'autorizzazione trasformerebbe
      // una scelta di presentazione in un divieto.
      for (const d of listDevices()) {
        if (!canReceive(db as never, "device", d.id)) continue;
        if (conPersona.has(d.id)) continue; // presentazione: lo stesso umano due volte
        soggetti.push({ subjectType: "device", subjectId: d.id, name: d.name, devices: 1 });
      }

      try {
        const persone = db.query(`
          SELECT p.id, p.display_name,
                 (SELECT COUNT(*) FROM devices d WHERE d.person_id = p.id AND d.revoked_at IS NULL) AS n
            FROM people p
           ORDER BY p.display_name`).all() as Array<{ id: string; display_name: string; n: number }>;
        for (const p of persone) {
          if (!canReceive(db as never, "person", p.id)) continue;
          soggetti.push({ subjectType: "person", subjectId: p.id, name: p.display_name, devices: Number(p.n) });
        }

        const orgs = db.query("SELECT id, name FROM orgs ORDER BY name")
          .all() as Array<{ id: string; name: string }>;
        for (const o of orgs) {
          if (!canReceive(db as never, "org", o.id)) continue;
          // Lo STESSO conteggio di `/api/auth/me` e `/api/auth/orgs`, e non una
          // terza copia della definizione di «membro»: le prime due si erano
          // già separate su questa esatta riga.
          const n = liveMemberCount(db as never, o.id);
          // Presentazione: un'organizzazione da UNA persona non si nomina — il
          // singolo è un'organizzazione di uno perché il codice abbia una
          // strada sola, non perché il prodotto abbia due vocabolari.
          if (n <= 1) continue;
          soggetti.push({ subjectType: "org", subjectId: o.id, name: o.name, devices: n });
        }
      } catch {
        // Schema più vecchio della 084: restano i soli dispositivi ospiti.
      }

      return json({ subjects: soggetti });
    }

    // Dove vive il relay e come si chiama questa installazione. Serve al client
    // per COMPORRE il link: il segreto ce l'ha già (glielo consegna la POST),
    // qui prende le due parti pubbliche. `enabled:false` è una risposta piena,
    // non un errore: senza relay il gesto semplicemente non si offre.
    if (method === "GET" && pathname === "/api/auth/relay") {
      const c = ctx.relayConfig?.();
      return json({
        enabled: !!c?.baseUrl,
        baseUrl: c?.baseUrl ?? null,
        // Il nome del PUNTO D'INCONTRO, non quello dell'installazione: è
        // questo che finisce nel link, e l'altro resta legato alla licenza.
        // Erano lo stesso valore, e finché lo sono stati mostrare un link
        // consegnava anche la credenziale con cui ci si dichiara questa
        // macchina sul relay (`shared/relay-identita.ts`).
        relayId: c?.relayId ?? null,
        connected: ctx.relayConnected?.() ?? false,
      });
    }

    // ── CHI SEI e QUAL È la tua organizzazione.
    //
    // Sotto `/api/auth/` e non su `/api/people` come diceva il piano: sono
    // domande d'identità, e stanno dove stanno le altre — così il cancello e
    // l'allowlist degli ospiti hanno un prefisso solo da conoscere invece di
    // due.
    //
    // Non c'è una POST per creare una persona-proprietaria: quella la crea la
    // migration, una volta, e resta una. Qui si può solo dirle come si chiama —
    // che è la differenza fra rinominare sé stessi e potersi nominare
    // proprietari.
    if (method === "GET" && pathname === "/api/auth/me") {
      try {
        const io = db.query(`
          SELECT p.id, p.display_name AS name, p.email
            FROM installation_owners io JOIN people p ON p.id = io.person_id
           ORDER BY io.is_default DESC LIMIT 1`).get() as
          { id: string; name: string; email: string | null } | undefined;
        // ── QUALE organizzazione, e perché non «la prima».
        //
        // Era `FROM orgs WHERE revoked_at IS NULL ORDER BY created_at LIMIT 1`:
        // la riga più VECCHIA della tabella, senza guardare chi stesse
        // chiedendo e senza guardare `installation`, che è la tabella nata per
        // rispondere a questa domanda (084 §5). Finché di organizzazioni ce n'è
        // una la risposta è giusta per caso; alla seconda l'installazione
        // cambia identità in silenzio — altro nome nell'intestazione, altri
        // membri, nessun errore da nessuna parte. Adesso la domanda si fa in un
        // posto solo, `server/lib/orgs.ts`.
        const orgId = installationOrgId(db as never);
        const org = orgId
          ? db.query("SELECT id, name, logo_url FROM orgs WHERE id = ?").get(orgId) as { id: string; name: string; logo_url: string | null } | undefined
          : undefined;
        return json({
          person: io ?? null,
          // Il conteggio esce dalla stessa funzione di `/api/auth/subjects` e di
          // `/api/auth/orgs`: erano tre definizioni di «membro» e due si erano
          // già separate — l'interfaccia diceva «siete in due» e la rubrica non
          // offriva il gruppo, perché per lei eri di nuovo solo.
          org: org ? { id: org.id, name: org.name, logo_url: org.logo_url ?? null, members: liveMemberCount(db as never, org.id) } : null,
        });
      } catch {
        // Schema più vecchio della 084: non c'è ancora nessuno da nominare.
        return json({ person: null, org: null });
      }
    }

    // ── LE ORGANIZZAZIONI: elencarle e crearne.
    //
    // Fino a oggi ce n'era una sola e la faceva la migration. Nasce qui la
    // seconda, e nasce con un `owner` VIVO — il modo di ritrovarsi con un
    // gruppo che nessuno può amministrare è crearne uno senza nessun
    // proprietario dentro.
    if (pathname === "/api/auth/orgs") {
      const io = actingPersonId(db as never, ctx.requestIdentity?.(req)?.deviceId ?? null);

      if (method === "GET") {
        try {
          const righe = db.query(
            "SELECT id, name, logo_url, created_at FROM orgs WHERE revoked_at IS NULL ORDER BY created_at",
          ).all() as Array<{ id: string; name: string; logo_url: string | null; created_at: number }>;
          const installazione = installationOrgId(db as never);
          return json({
            orgs: righe.map((o) => ({
              id: o.id,
              name: o.name,
              logo_url: o.logo_url ?? null,
              members: liveMemberCount(db as never, o.id),
              // Il ruolo di CHI CHIEDE, non un ruolo assoluto: è ciò che
              // decide quali gesti l'interfaccia può offrire senza proporne uno
              // che il server rifiuterà.
              role: orgRole(db as never, o.id, io),
              // Il gruppo di questa installazione non si cancella: è l'ancora a
              // cui `/api/auth/me` risponde, e senza di lui l'identità della
              // macchina diventa «una delle organizzazioni, forse».
              installation: o.id === installazione,
            })),
          });
        } catch { return json({ orgs: [] }); }
      }

      if (method === "POST") {
        const body = await readJSON(req) as { name?: unknown } | null;
        const nome = typeof body?.name === "string" ? body.name.trim().slice(0, 80) : "";
        if (!nome) return json({ error: "name_required" }, 400);
        if (!io) return json({ error: "no_person_for_org" }, 400);
        try {
          const id = crypto.randomUUID().replace(/-/g, "");
          db.query(
            "INSERT INTO orgs (id, name, created_at, origin, rev, updated_at) VALUES (?,?,?,'local',1,?)",
          ).run(id, nome, now, now);
          // Chi lo crea lo amministra. È l'unico modo in cui `role` può valere
          // qualcosa senza un piano di controllo che lo scriva: il primo
          // membro è un `owner`, e i successivi entrano come `member`.
          db.query(
            "INSERT INTO org_members (org_id, person_id, role, joined_at, rev, updated_at) VALUES (?,?, 'owner', ?, 1, ?)",
          ).run(id, io, now, now);
          return json({ ok: true, id, name: nome });
        } catch {
          return json({ error: "db_unavailable" }, 400);
        }
      }
    }

    // ── CANCELLARE un'organizzazione.
    //
    // `revoked_at` e non un DELETE, come ovunque nella 084: una riga cancellata
    // non racconta niente, e `org_members` la referenzia con ON DELETE RESTRICT
    // — un DELETE fallirebbe, e fallirebbe a runtime. La colonna era LETTA in
    // quattro punti e SCRITTA da nessuno: un interruttore di sicurezza che
    // nessun gesto poteva premere.
    if (method === "DELETE" && /^\/api\/auth\/orgs\/[^/]+$/.test(pathname)) {
      const id = decodeURIComponent(pathname.slice("/api/auth/orgs/".length));
      try {
        // Già revocato = sconosciuto, la STESSA risposta che dà la POST dei
        // membri: due rotte che guardano la stessa riga non possono dire una
        // «non c'è» e l'altra «fatto», o il secondo clic sembra riuscito. E la
        // domanda si fa con la funzione che la fanno tutte — era una SELECT
        // scritta a mano qui e una closure là dentro, cioè due copie in attesa
        // di separarsi.
        const viva = orgAlive(db as never, id);
        if (viva === null) return json({ error: "db_unavailable" }, 400);
        if (!viva) return json({ error: "unknown_org" }, 404);
        if (id === installationOrgId(db as never)) {
          return json({ error: "installation_org_undeletable" }, 400);
        }
        const io = actingPersonId(db as never, ctx.requestIdentity?.(req)?.deviceId ?? null);
        if (!canAdministerOrg(db as never, id, io)) {
          return json({ error: "not_org_admin" }, 403);
        }
        // I dispositivi PRIMA della revoca: dopo, la JOIN su `org_members` non
        // li trova più e resterebbero con una socket aperta e i principali di
        // prima — timbrati all'upgrade e non più riletti.
        const dispositivi = dispositiviDelSoggetto(db, "org", id);
        db.query("UPDATE orgs SET revoked_at = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND revoked_at IS NULL")
          .run(now, now, id);
        // Solo le socket. Questi dispositivi NON sono revocati — la loro riga in
        // `devices` è intatta e `dispositiviDelSoggetto` restituisce solo quelli
        // vivi — quindi cancellargli l'iscrizione di push sarebbe togliere le
        // notifiche a un telefono ancora appaiato, per sempre e senza che dal
        // client si veda (il pulsante legge il browser, non il server).
        for (const d of dispositivi) ctx.closeDeviceSockets?.(d);
        return json({ ok: true });
      } catch {
        return json({ error: "db_unavailable" }, 400);
      }
    }

    // ── CANCELLARE una persona dalla rubrica.
    //
    // `people.revoked_at` era LETTA in otto punti — la rubrica, il cancello
    // delle condivisioni, l'elenco dei membri, l'appaiamento, l'aggancio di un
    // account, `resolvePrincipals` in entrambi i salti — e SCRITTA in nessuno.
    // La stessa forma che `orgs.revoked_at` aveva prima della sua DELETE, e la
    // 084 lo dice di sé stessa: «una colonna che sembra un interruttore di
    // sicurezza e non è cablata a niente è peggio della sua assenza».
    //
    // Il buco vero che lasciava aperto: una persona INVITATA per nome — creata
    // da `POST /orgs/:id/members {name}` prima che collegasse qualcosa — e poi
    // tolta restava una riga che nessun gesto poteva più toccare. Un errore di
    // battitura era definitivo.
    //
    // È un gesto SEPARATO da «togli dal gruppo», e deve esserlo: fonderli
    // renderebbe impossibile rimettere dentro qualcuno, che è il gesto
    // immediatamente successivo più comune.
    if (method === "DELETE" && /^\/api\/auth\/people\/[^/]+$/.test(pathname)) {
      const id = decodeURIComponent(pathname.slice("/api/auth/people/".length));
      try {
        const p = db.query("SELECT revoked_at FROM people WHERE id = ?")
          .get(id) as { revoked_at: number | null } | undefined;
        // Già cancellata = sconosciuta, la stessa risposta che dà la DELETE dei
        // gruppi: due letture della stessa riga non possono dire una «non c'è»
        // e l'altra «fatto», o il secondo clic sembra riuscito.
        if (!p || p.revoked_at !== null) return json({ error: "unknown_person" }, 404);
        // Il proprietario dell'installazione non si cancella: sarebbe l'unico
        // gesto capace di lasciare la macchina senza nessuno che la possieda.
        if (db.query("SELECT 1 FROM installation_owners WHERE person_id = ?").get(id)) {
          return json({ error: "cannot_remove_self" }, 400);
        }
        // Prima si toglie dai gruppi, poi si cancella. Non è cerimonia: la
        // lapide fa ricadere il suo dispositivo su «solo il ferro»
        // (`resolvePrincipals`), quindi cancellare una persona ancora dentro un
        // gruppo le toglierebbe in silenzio ciò che a quel gruppo era stato
        // condiviso — un effetto che il gesto non annuncia.
        if (livePersonMemberships(db as never, id) > 0) {
          return json({ error: "still_a_member" }, 409);
        }
        // Stessa ragione per i DISPOSITIVI: una persona con un telefono vivo è
        // qualcuno che entra ancora da qui, e cancellarla dalla rubrica non è
        // il modo di togliergli l'accesso — quello è revocare il dispositivo.
        const conDispositivo = db.query(
          "SELECT COUNT(*) AS n FROM devices WHERE person_id = ? AND revoked_at IS NULL",
        ).get(id) as { n: number } | undefined;
        if (Number(conDispositivo?.n ?? 0) > 0) return json({ error: "still_has_devices" }, 409);

        // Nessuna socket da chiudere, e non è una dimenticanza: le due
        // condizioni qui sopra hanno già stabilito che questa persona non ha
        // nessun dispositivo vivo. La DELETE dei gruppi le chiude perché lì i
        // dispositivi ci sono; qui la stessa riga sarebbe un giro su una lista
        // sempre vuota, cioè un rito che sembra una precauzione.
        db.query("UPDATE people SET revoked_at = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND revoked_at IS NULL")
          .run(now, now, id);
        return json({ ok: true });
      } catch {
        return json({ error: "db_unavailable" }, 400);
      }
    }

    // Il percorso è ancorato in fondo con `$`: senza, questo ramo intercettava
    // anche `/api/auth/orgs/<id>/members` — `startsWith` non sa dove finisce un
    // id — e una PATCH ai membri finiva in una UPDATE su `orgs` con id
    // `<id>/members`, cioè zero righe toccate e un `ok: true` in risposta. Il
    // gesto non faceva niente e diceva di averlo fatto.
    if (method === "PATCH" && /^\/api\/auth\/(people|orgs)\/[^/]+$/.test(pathname)) {
      const persona = pathname.startsWith("/api/auth/people/");
      const id = decodeURIComponent(pathname.slice(persona ? "/api/auth/people/".length : "/api/auth/orgs/".length));
      const body = await readJSON(req) as { name?: unknown; email?: unknown; logo_url?: unknown } | null;
      const name = typeof body?.name === "string" ? body.name.trim().slice(0, 80) : null;
      // `null` esplicito cancella l'email; assente la lascia com'è. Sono due
      // intenzioni diverse e vanno distinte, o non si può più togliere un
      // indirizzo messo per sbaglio.
      const email = body?.email === null ? null
        : typeof body?.email === "string" ? body.email.trim().slice(0, 200) : undefined;
      // `null` esplicito rimuove il logo; assente lo lascia com'è.
      const logoUrl = body?.logo_url === null ? null
        : typeof body?.logo_url === "string" ? body.logo_url.trim().slice(0, 4096) : undefined;
      if (name !== null && !name) return json({ error: "name_required" }, 400);

      // Rinominare un gruppo è amministrarlo, e passa dallo stesso ruolo che
      // decide gli inviti: due porte sullo stesso potere con due regole diverse
      // sono la porta più debole delle due. Le PERSONE restano fuori — chi si
      // rinomina rinomina sé stesso, e non è un potere dentro un gruppo.
      if (!persona) {
        // ESISTE, prima del ruolo. Il ruolo da solo non basta: `canAdministerOrg`
        // guarda `org_members`, e revocare un gruppo NON tocca le sue righe di
        // appartenenza — quindi su un gruppo cancellato restava `true` e questa
        // rotta scriveva il nome dentro la riga revocata rispondendo `ok: true`,
        // mentre DELETE e le tre rotte dei membri sullo stesso id dicevano
        // «organizzazione sconosciuta». È uno stato che si raggiunge dalla UI
        // vera: `IdentitySection` carica i gruppi una volta al montaggio e non
        // ha un invalidamento via WS, quindi una seconda finestra che mostra
        // ancora un gruppo cancellato altrove rinominava un morto.
        const viva = orgAlive(db as never, id);
        if (viva === null) return json({ error: "db_unavailable" }, 400);
        if (!viva) return json({ error: "unknown_org" }, 404);
        const io = actingPersonId(db as never, ctx.requestIdentity?.(req)?.deviceId ?? null);
        if (!canAdministerOrg(db as never, id, io)) {
          return json({ error: "not_org_admin" }, 403);
        }
      }

      try {
        if (name) {
          db.query(`UPDATE ${persona ? "people" : "orgs"} SET ${persona ? "display_name" : "name"} = ?, rev = rev + 1, updated_at = ? WHERE id = ?`)
            .run(name, now, id);
        }
        if (persona && email !== undefined) {
          db.query("UPDATE people SET email = ?, rev = rev + 1, updated_at = ? WHERE id = ?").run(email || null, now, id);
        }
        if (!persona && logoUrl !== undefined) {
          db.query("UPDATE orgs SET logo_url = ?, rev = rev + 1, updated_at = ? WHERE id = ?").run(logoUrl, now, id);
        }
      } catch {
        return json({ error: "db_unavailable" }, 400);
      }
      return json({ ok: true });
    }

    // ── I MEMBRI di un'organizzazione.
    //
    // Chi può ARRIVARE qui: solo una richiesta non confinata — il cancello non
    // mette `/api/auth/orgs/` in allowlist, quindi un ospite si ferma prima, e
    // non si aggiunge un secondo controllo che direbbe la stessa cosa in un
    // altro modo: due guardie sulla stessa porta sono due occasioni di aprirla.
    //
    // Chi può SCRIVERE qui è una domanda DIVERSA, ed è l'unica a cui
    // `org_members.role` risponde (084, righe 96-102). Non è la stessa del
    // cancello: essere proprietario di questa macchina non ti rende
    // amministratore di un gruppo di qualcun altro di cui sei un membro
    // qualunque — e con una sola organizzazione le due domande coincidevano per
    // caso, il che è il motivo per cui la colonna è rimasta a lungo scritta e
    // mai imposta.
    if (/^\/api\/auth\/orgs\/[^/]+\/members$/.test(pathname)) {
      const orgId = decodeURIComponent(pathname.split("/")[4]);
      const ioPersona = actingPersonId(db as never, ctx.requestIdentity?.(req)?.deviceId ?? null);
      /** L'organizzazione esiste? Prima del ruolo, o «non esiste» diventerebbe
       *  «non ti è permesso» — due risposte diverse che nascondono l'una
       *  l'altra. */
      const orgViva = () => orgAlive(db as never, orgId);

      if (method === "GET") {
        try {
          // La LETTURA fa la stessa domanda delle tre scritture su questo
          // percorso. Era l'unica delle quattro a non farla: su un gruppo
          // revocato rispondeva 200 con la rubrica intera, mentre POST, PATCH e
          // DELETE sullo stesso id rispondevano 404 e `GET /api/auth/orgs` quel
          // gruppo non lo elencava nemmeno. Una schermata che legge da qui
          // mostrava dei membri e poi falliva su ogni gesto, senza mai dire
          // perché.
          const viva = orgViva();
          // Schema più vecchio della 084: si tace come fa `GET /api/auth/orgs`,
          // che risponde `{orgs: []}` invece di un errore. Le letture degradano,
          // le scritture rifiutano — ed è la stessa regola su entrambe le rotte.
          if (viva === null) return json({ members: [] });
          if (!viva) return json({ error: "unknown_org" }, 404);
          // `last_seen`: l'ultima volta che questa persona si e' fatta viva, sul
          // dispositivo piu' recente. `devices` dice quante macchine ha, che e'
          // una proprieta' dell'anagrafica; questo dice se c'e' ADESSO, che e'
          // l'unica cosa che serve a chi guarda per sapere con chi sta
          // lavorando. Senza, «tre dispositivi» descrive uguale chi e' online e
          // chi non apre l'app da marzo.
          const righe = db.query(`
            SELECT p.id, p.display_name AS name, p.email, m.role, m.joined_at,
                   m.revoked_at, m.local_blocked_at,
                   (SELECT COUNT(*) FROM devices d WHERE d.person_id = p.id AND d.revoked_at IS NULL) AS devices,
                   (SELECT MAX(d.last_seen_at) FROM devices d WHERE d.person_id = p.id AND d.revoked_at IS NULL) AS last_seen,
                   (p.id IN (SELECT person_id FROM installation_owners)) AS owner
              FROM org_members m JOIN people p ON p.id = m.person_id
             WHERE m.org_id = ? AND p.revoked_at IS NULL
             ORDER BY owner DESC, p.display_name`).all(orgId) as Array<Record<string, unknown>>;
          return json({
            members: righe.map((r) => ({
              id: r.id, name: r.name, email: r.email, role: r.role,
              devices: Number(r.devices), owner: !!r.owner,
              // Millisecondi o null: la soglia dell'«online» la decide chi
              // disegna, non questa rotta. Un server che dichiarasse «online:
              // true» congelerebbe qui una finestra temporale che il client non
              // puo' piu' cambiare, e due schermate con due soglie diverse
              // direbbero due verita' sullo stesso membro.
              lastSeenAt: r.last_seen === null || r.last_seen === undefined ? null : Number(r.last_seen),
              // Le DUE revoche restano distinte anche qui: una l'ha decisa il
              // piano di controllo, l'altra tu — e solo la seconda sopravvive
              // al prossimo aggiornamento.
              revoked: r.revoked_at !== null,
              blocked: r.local_blocked_at !== null,
            })),
          });
        } catch { return json({ members: [] }); }
      }

      if (method === "POST") {
        const body = await readJSON(req) as { personId?: unknown; name?: unknown; email?: unknown } | null;
        try {
          // Le tre scritture di questo blocco fanno le STESSE due domande, e le
          // fanno con le stesse due righe: la seconda copia scritta a mano è
          // quella che un giorno dimentica una delle due revoche.
          const viva = orgViva();
          if (viva === null) return json({ error: "db_unavailable" }, 400);
          if (!viva) return json({ error: "unknown_org" }, 404);
          if (!canAdministerOrg(db as never, orgId, ioPersona)) {
            return json({ error: "not_org_admin" }, 403);
          }

          // ── IL POSTO ────────────────────────────────────────────────────
          // Qui e in NESSUN altro punto di questo blocco: i posti governano
          // l'ingresso e nient'altro (`server/lib/licenza.ts`). Sulla lettura,
          // sulla rimozione e sul cambio di ruolo non si chiede niente alla
          // licenza — un conteggio che può togliere è un conteggio che un
          // giorno espelle qualcuno mentre la fatturazione ha un problema.
          //
          // La domanda si fa alla porta unica, non con un `if` scritto qui: due
          // punti che rispondono a «c'è posto?» sono due punti che un giorno
          // rispondono diversamente, e quello che decide davvero è questo.
          //
          // Chi è GIÀ dentro non consuma un posto in più: ripetere questa POST
          // su un membro vivo è idempotente, e non deve diventare l'unico gesto
          // che si rompe a gruppo pieno.
          const giaMembro = typeof body?.personId === "string" && body.personId
            ? orgRole(db as never, orgId, body.personId) !== null
            : false;
          // Senza il servizio della licenza innestato non c'è un'autorità a cui
          // chiedere, e non se ne inventa una: si lascia passare, che è il verso
          // in cui questo modulo sbaglia sempre.
          const licenza = ctx.licenza?.();
          if (!giaMembro && licenza) {
            const esito = consentito(licenza.stato(), {
              tipo: "aggiungi_persona_al_gruppo",
              membriVivi: liveMemberCount(db as never, orgId),
            });
            if (!esito.ok) {
              // Il codice esce con i due numeri: «rifiutato» senza dire quanti
              // posti ci sono e quanti se ne stanno usando manda a cercare il
              // problema nella parte sbagliata.
              return json(
                esito.codice === "no_seats_left"
                  ? { error: esito.codice, seats: esito.posti, members: esito.membri }
                  : { error: esito.codice },
                403,
              );
            }
          }

          let pid: string;
          if (typeof body?.personId === "string" && body.personId) {
            const p = db.query("SELECT revoked_at FROM people WHERE id = ?").get(body.personId) as { revoked_at: number | null } | undefined;
            if (!p) return json({ error: "unknown_person" }, 404);
            if (p.revoked_at !== null) return json({ error: "person_revoked" }, 400);
            pid = body.personId;
          } else {
            const nome = typeof body?.name === "string" ? body.name.trim().slice(0, 80) : "";
            if (!nome) return json({ error: "name_required" }, 400);
            const email = typeof body?.email === "string" ? body.email.trim().slice(0, 200) : null;
            // Si crea la persona QUI, senza aspettare che appaia un suo
            // dispositivo: è il punto di ORG-04 — invitare qualcuno viene prima
            // che quel qualcuno si colleghi, non dopo.
            pid = crypto.randomUUID().replace(/-/g, "");
            db.query(
              "INSERT INTO people (id, display_name, email, created_at, origin, rev, updated_at) VALUES (?,?,?,?,'local',1,?)",
            ).run(pid, nome, email || null, now, now);
          }

          // `member` e non `admin`: chi entra non amministra. Promuovere è un
          // gesto in più, e deve esserlo.
          db.query(
            "INSERT OR IGNORE INTO org_members (org_id, person_id, role, joined_at, rev, updated_at) VALUES (?,?, 'member', ?, 1, ?)",
          ).run(orgId, pid, now, now);
          // Rientrare toglie il blocco LOCALE, e SOLO quello. `revoked_at` è
          // del piano di controllo — è la licenza — e la migration lo dichiara
          // (`084-people-orgs.sql:108-110`). Azzerarlo da qui, com'era, voleva
          // dire che riaggiungere qualcuno scavalcava in silenzio una revoca
          // decisa altrove: il gesto più innocuo dell'interfaccia diventava il
          // modo di annullare una licenza.
          db.query("UPDATE org_members SET local_blocked_at = NULL WHERE org_id = ? AND person_id = ?")
            .run(orgId, pid);
          // E se la revoca remota c'è, si dice invece di far finta: altrimenti
          // la persona ricompare in elenco e continua a non vedere niente,
          // senza che nessuna schermata spieghi perché.
          const remota = db.query("SELECT revoked_at FROM org_members WHERE org_id = ? AND person_id = ?")
            .get(orgId, pid) as { revoked_at: number | null } | undefined;
          if (remota?.revoked_at != null) {
            return json({ ok: true, personId: pid, revocataAltrove: true });
          }
          return json({ ok: true, personId: pid });
        } catch {
          return json({ error: "db_unavailable" }, 400);
        }
      }

      if (method === "DELETE") {
        const pid = url.searchParams.get("personId") ?? "";
        try {
          const viva = orgViva();
          if (viva === null) return json({ error: "db_unavailable" }, 400);
          if (!viva) return json({ error: "unknown_org" }, 404);
          if (!canAdministerOrg(db as never, orgId, ioPersona)) {
            return json({ error: "not_org_admin" }, 403);
          }
          const owner = db.query("SELECT 1 FROM installation_owners WHERE person_id = ?").get(pid);
          // Il proprietario dell'installazione non si toglie dalla propria
          // organizzazione: sarebbe l'unico gesto capace di lasciare la
          // macchina senza nessuno che la possieda.
          if (owner) return json({ error: "cannot_remove_self" }, 400);
          // `local_blocked_at`, non `revoked_at`: questa è una decisione presa
          // QUI, e deve sopravvivere al prossimo aggiornamento dal piano di
          // controllo. Scriverla nell'altra colonna vorrebbe dire vederla
          // annullare dal primo pull, in silenzio.
          db.query("UPDATE org_members SET local_blocked_at = ? WHERE org_id = ? AND person_id = ? AND local_blocked_at IS NULL")
            .run(now, orgId, pid);
          // E NON la lapide della persona: togliere dal gruppo e cancellare
          // dalla rubrica sono due gesti, e confonderli renderebbe impossibile
          // RIMETTERE dentro qualcuno — che è il gesto immediatamente successivo
          // più comune. La lapide si scrive da `DELETE /api/auth/people/:id`.
          // Anche qui solo le socket: togliere dal gruppo non è revocare il
          // telefono. Vedi `dimenticaPush`.
          for (const d of dispositiviDelSoggetto(db, "person", pid)) ctx.closeDeviceSockets?.(d);
          return json({ ok: true });
        } catch {
          return json({ error: "db_unavailable" }, 400);
        }
      }

      // ── PROMUOVERE e RETROCEDERE.
      //
      // Il gesto che rende `role` una colonna e non una decorazione: senza di
      // lui l'unico ruolo scrivibile sarebbe quello dell'INSERT — `member` per
      // chi entra, `owner` per chi crea — e un gruppo non potrebbe mai cambiare
      // amministratore. Un enum a tre valori di cui due sono irraggiungibili è
      // un enum che mente.
      if (method === "PATCH") {
        const body = await readJSON(req) as { personId?: unknown; role?: unknown } | null;
        const pid = typeof body?.personId === "string" ? body.personId : "";
        if (!pid) return json({ error: "person_required" }, 400);
        if (!isOrgRole(body?.role)) return json({ error: "unknown_role" }, 400);
        const ruolo: OrgRole = body.role;
        try {
          const viva = orgViva();
          if (viva === null) return json({ error: "db_unavailable" }, 400);
          if (!viva) return json({ error: "unknown_org" }, 404);
          if (!canAdministerOrg(db as never, orgId, ioPersona)) {
            return json({ error: "not_org_admin" }, 403);
          }
          const attuale = orgRole(db as never, orgId, pid);
          // Chi è stato tolto o revocato non ha un ruolo da cambiare: si
          // riaggiunge, e quello è un altro gesto. Promuovere un assente
          // scriverebbe una riga viva senza passare da nessuna delle due
          // colonne di revoca.
          if (!attuale) return json({ error: "not_a_member" }, 404);
          if (attuale === ruolo) return json({ ok: true, personId: pid, role: ruolo });
          // Zero proprietari vivi = gruppo immodificabile per chiunque, e
          // l'unico modo di uscirne sarebbe una UPDATE a mano nel database.
          // L'ULTIMO proprietario non si retrocede; il penultimo sì.
          if (attuale === "owner" && liveOwnerCount(db as never, orgId) <= 1) {
            return json({ error: "last_owner" }, 400);
          }
          db.query(`
            UPDATE org_members SET role = ?, rev = rev + 1, updated_at = ?
             WHERE org_id = ? AND person_id = ?`).run(ruolo, now, orgId, pid);
          return json({ ok: true, personId: pid, role: ruolo });
        } catch {
          return json({ error: "db_unavailable" }, 400);
        }
      }
    }

    // ── I LINK: condividere con chi NON è sulla tua rete.
    //
    // Un link è una CAPACITÀ su una cosa sola, non un accesso: fuori dalla rete
    // non si può chiedere a un ospite di appaiare un dispositivo — quel gesto
    // vuole due schermi vicini e un codice da confrontare. Quindi chi ha il
    // link vede quella cosa, e nient'altro.
    //
    // La chiave NON esce mai da qui in una risposta successiva: si consegna una
    // volta sola, al momento della creazione, perché è quello l'unico istante
    // in cui serve. Un endpoint che la restituisce a richiesta trasformerebbe
    // ogni lettura dell'elenco in una copia del segreto.
    if (pathname === "/api/auth/share-links") {
      if (method === "GET") {
        const tipo = url.searchParams.get("resourceType") ?? "task";
        const id = url.searchParams.get("resourceId") ?? "";
        if (!isResourceType(tipo)) return json({ error: "unknown_resource_type" }, 400);
        try {
          const righe = db.query(`
            SELECT ref, created_at, expires_at, revoked_at, opened_count, last_opened_at
              FROM share_links WHERE resource_type = ? AND resource_id = ?
             ORDER BY created_at DESC`).all(tipo, id) as Array<Record<string, unknown>>;
          return json({
            links: righe.map((r) => ({
              ref: r.ref, createdAt: r.created_at, expiresAt: r.expires_at,
              revokedAt: r.revoked_at, openedCount: r.opened_count, lastOpenedAt: r.last_opened_at,
              // Scaduto è diverso da revocato, e chi guarda deve poterlo dire:
              // uno è passato da solo, l'altro l'ha deciso qualcuno.
              scaduto: Number(r.expires_at) <= now,
            })),
          });
        } catch { return json({ links: [] }); }
      }

      if (method === "POST") {
        // SENZA RELAY NON SI CONIA. Era il buco: `/api/auth/relay` diceva
        // `enabled:false` e il bottone spariva dall'interfaccia, ma questa
        // rotta continuava a produrre link validi — un interruttore che
        // nasconde il gesto senza toglierlo è peggio di nessun interruttore,
        // perché fa credere di aver spento una cosa che è ancora accesa.
        //
        // Solo la POST. Elencare e REVOCARE restano raggiungibili a relay
        // spento: chi ha appena spento è esattamente chi deve poter revocare
        // ciò che aveva già distribuito.
        if (!ctx.relayConfig?.()?.baseUrl) {
          return json({ error: "public_sharing_off" }, 409);
        }
        const body = await readJSON(req) as {
          resourceType?: string; resourceId?: string; giorni?: unknown;
        } | null;
        const tipo = body?.resourceType ?? "task";
        const risorsa = body?.resourceId;
        if (!isResourceType(tipo)) return json({ error: "unknown_resource_type" }, 400);
        if (!risorsa) return json({ error: "resource_id_required" }, 400);

        // La scadenza c'è sempre e ha un tetto: un link senza scadenza è un
        // link che qualcuno ritrova in una chat fra due anni e che funziona
        // ancora. Sette giorni di default, trenta al massimo.
        const g = typeof body?.giorni === "number" && body.giorni > 0 ? Math.min(body.giorni, 30) : 7;
        const ref = crypto.randomUUID().replace(/-/g, "").slice(0, 22);
        const key = nuovaChiave();
        try {
          db.query(
            "INSERT INTO share_links (ref, key, resource_type, resource_id, created_at, expires_at) VALUES (?,?,?,?,?,?)",
          ).run(ref, key, tipo, risorsa, now, now + g * 86_400_000);
        } catch {
          return json({ error: "db_unavailable" }, 400);
        }
        // La chiave esce SOLO qui. Chi chiama la mette nel frammento dell'URL e
        // poi la dimentica: il server non la ripropone mai più.
        return json({ ref, key, expiresAt: now + g * 86_400_000 });
      }

      if (method === "DELETE") {
        const ref = url.searchParams.get("ref") ?? "";
        try {
          db.query("UPDATE share_links SET revoked_at = ? WHERE ref = ? AND revoked_at IS NULL").run(now, ref);
        } catch { /* schema più vecchio della 085 */ }
        return json({ ok: true });
      }
    }

    if (pathname === "/api/auth/shares") {
      // Generico sul TIPO di risorsa: `task` e `topic` oggi, e domani ciò che
      // avrà una riga vera. Una rotta per tipo sarebbe la stessa divergenza che
      // il modello unico serve a evitare.
      if (method === "GET") {
        const tipo = url.searchParams.get("resourceType") ?? "task";
        const id = url.searchParams.get("resourceId") ?? url.searchParams.get("taskId") ?? "";
        if (!isResourceType(tipo)) return json({ error: "unknown_resource_type" }, 400);
        // I soggetti stanno in `grants` e il NOME sta altrove: prima li univa
        // una JOIN su `devices`, che assumeva che ogni soggetto fosse un
        // dispositivo. Ora il nome si risolve DOPO, per tipo di soggetto —
        // così una riga verso una persona o un'organizzazione non sparisce
        // dall'elenco solo perché la JOIN non la trova.
        const righe = subjectsOf(db as never, tipo, id).filter((r) => r.level !== "deny");
        const nomeDispositivo = new Map(
          (db.query("SELECT id, name FROM devices WHERE revoked_at IS NULL").all() as Array<{ id: string; name: string }>)
            .map((d) => [d.id, d.name]),
        );
        // I nomi degli altri soggetti. Senza, una riga verso una persona
        // mostrava il suo UUID — «Condiviso con a8e3c1e4…», che non risponde a
        // nessuna delle domande per cui si apre questo pannello.
        const nomeSoggetto = new Map<string, string>();
        try {
          for (const p of db.query("SELECT id, display_name FROM people").all() as Array<{ id: string; display_name: string }>) {
            nomeSoggetto.set(`person:${p.id}`, p.display_name);
          }
          for (const o of db.query("SELECT id, name FROM orgs").all() as Array<{ id: string; name: string }>) {
            nomeSoggetto.set(`org:${o.id}`, o.name);
          }
        } catch { /* schema più vecchio della 084 */ }
        return json({
          shares: righe
            // Un dispositivo revocato non compare: la sua riga di concessione
            // resta (non si cancella la storia) ma non ha piu' effetto.
            .filter((r) => r.subjectType !== "device" || nomeDispositivo.has(r.subjectId))
            .map((r) => ({
              subjectType: r.subjectType,
              subjectId: r.subjectId,
              // `deviceId` resta come alias legacy per una release: il client
              // vecchio continua a leggerlo mentre quello nuovo passa a
              // `subjectId`. La rotta ha gia' questo idioma con `taskId`.
              deviceId: r.subjectType === "device" ? r.subjectId : undefined,
              name: r.subjectType === "device"
                ? nomeDispositivo.get(r.subjectId) ?? r.subjectId
                : nomeSoggetto.get(`${r.subjectType}:${r.subjectId}`) ?? r.subjectId,
              sharedAt: r.grantedAt,
            })),
        });
      }
      if (method === "POST") {
        const body = await readJSON(req) as {
          taskId?: string; resourceType?: string; resourceId?: string;
          deviceId?: string; subjectType?: string; subjectId?: string;
        } | null;
        const tipo = body?.resourceType ?? "task";
        const risorsa = body?.resourceId ?? body?.taskId;
        if (!isResourceType(tipo)) return json({ error: "unknown_resource_type" }, 400);

        // `deviceId` resta accettato come alias legacy per una release: il
        // client vecchio continua a funzionare mentre quello nuovo passa a
        // `subjectType`/`subjectId`. La rotta ha già esattamente questo idioma
        // con `taskId` → `resourceId`.
        const sogTipo = body?.subjectType ?? (body?.deviceId ? "device" : undefined);
        const sogId = body?.subjectId ?? body?.deviceId;
        if (!risorsa || !sogId || !sogTipo) return json({ error: "subject_required" }, 400);
        if (!isSubjectKind(sogTipo)) return json({ error: "unknown_subject_kind" }, 400);

        // Condividere con chi vede GIÀ tutto non vuol dire niente, e lasciarlo
        // fare darebbe l'idea che quella riga stia limitando qualcosa. La
        // domanda però non è più «che ruolo ha questo dispositivo?» ma «questo
        // soggetto è confinato?», che è la stessa cosa detta nel modello nuovo.
        //
        // La stessa funzione con cui `GET /api/auth/subjects` FILTRA la
        // rubrica: erano due implementazioni della stessa domanda, e su un caso
        // non concordavano — la persona tolta da ogni gruppo spariva dal menu e
        // questa POST sullo stesso id rispondeva `200`.
        const rifiuto = subjectRejection(db as never, sogTipo, sogId);
        if (rifiuto) return json({ error: rifiuto.codice }, rifiuto.status);

        putGrant(db as never, { kind: sogTipo, id: sogId }, tipo, risorsa, { grantedAt: now });
        // Senza questo, condividere qualcosa non si vedeva dall'altra parte
        // finche' l'ospite non premeva Ricarica: i dati c'erano e nessuno
        // glielo diceva. Mirato, non in broadcast — vedi `sendToDevice`.
        for (const d of dispositiviDelSoggetto(db, sogTipo, sogId)) {
          ctx.sendToDevice?.(d, { type: "auth:shares-changed" });
        }
        return json({ ok: true });
      }
      if (method === "DELETE") {
        const tipo = url.searchParams.get("resourceType") ?? "task";
        const risorsa = url.searchParams.get("resourceId") ?? url.searchParams.get("taskId") ?? "";
        const sogTipoRaw = url.searchParams.get("subjectType") ?? (url.searchParams.get("deviceId") ? "device" : "");
        const sogId = url.searchParams.get("subjectId") ?? url.searchParams.get("deviceId") ?? "";
        if (!isResourceType(tipo)) return json({ error: "unknown_resource_type" }, 400);
        if (!isSubjectKind(sogTipoRaw)) return json({ error: "unknown_subject_kind" }, 400);
        // I dispositivi si prendono PRIMA di togliere la riga: dopo, se il
        // soggetto è un'organizzazione, non ci sarebbe più modo di sapere a chi
        // dirlo. Il frame va mandato comunque — proprio perché la concessione
        // non esiste più, nessun broadcast filtrato per entità arriverebbe.
        const daAvvisare = dispositiviDelSoggetto(db, sogTipoRaw, sogId);
        dropGrant(db as never, { kind: sogTipoRaw, id: sogId }, tipo, risorsa);
        for (const d of daAvvisare) ctx.sendToDevice?.(d, { type: "auth:shares-changed" });
        return json({ ok: true });
      }
    }

    // ── Uscire da questo dispositivo: revoca sé stesso e si toglie il cookie.
    if (method === "POST" && pathname === "/api/auth/logout") {
      const token = readSessionCookie(req.headers.get("cookie"));
      if (token) {
        db.query("UPDATE devices SET revoked_at = ? WHERE token_hash = ?").run(now, hashToken(token));
        // Uscire è una revoca come le altre, e finora era l'unica che lasciava
        // in piedi la push: il telefono «uscito» continuava a ricevere.
        const io = ctx.requestIdentity?.(req)?.deviceId ?? null;
        if (io) dimenticaPush(db, io);
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "Set-Cookie": buildClearedSessionCookie({ secure }),
        },
      });
    }

    return null;
  };
}
