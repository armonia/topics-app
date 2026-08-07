import type { AppContext, RouteHandler } from "../types";
import {
  hashToken, mintSessionToken, mintPairingCode,
  buildSessionCookie, buildClearedSessionCookie,
  readSessionCookie, PAIRING_CODE_TTL_MS,
  type DeviceRecord,
} from "../lib/device-auth";
import { isLoopbackAddress } from "../lib/auth-gate";
import { isResourceType } from "../lib/grants";
import {
  grantedByType, subjectsOf, putGrant, dropGrant, deviceP, type SubjectKind,
} from "../lib/grants-query";

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
  name: string;
  ip: string | null;
  createdAt: number;
  state: "pending" | "approved" | "denied";
  /** Valorizzato solo dopo l'approvazione, e consegnato UNA volta sola. */
  token: string | null;
}

const pending = new Map<string, PendingPairing>();

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
}

/**
 * Tetto alle richieste in attesa. Il verso dell'approvazione toglie il
 * brute-force del CODICE — non c'è niente da indovinare — ma non impedisce a un
 * peer sulla rete di inondare la coda finché il cartello sul Mac diventa
 * illeggibile. Due limiti, per due abusi diversi: quante ne può avere aperte UNO
 * stesso indirizzo, e quante in tutto. Sono numeri bassi di proposito: una
 * persona che appaia un telefono ne apre una.
 */
const MAX_PENDING_PER_IP = 3;
const MAX_PENDING_TOTAL = 20;

function sweep(now: number): void {
  for (const [id, p] of pending) {
    if (now - p.createdAt > PAIRING_CODE_TTL_MS) pending.delete(id);
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

/** Perché questo soggetto NON può ricevere una condivisione, se non può. */
function motivoRifiutoSoggetto(
  db: { query: (sql: string) => { get: (...a: unknown[]) => unknown } },
  kind: SubjectKind,
  id: string,
): { msg: string; status: number } | null {
  if (kind === "device") {
    const d = db.query("SELECT role FROM devices WHERE id = ? AND revoked_at IS NULL").get(id) as { role?: string } | undefined;
    if (!d) return { msg: "dispositivo sconosciuto o revocato", status: 404 };
    if (d.role !== "guest") return { msg: "quel dispositivo vede già tutto: è un tuo dispositivo, non un ospite", status: 400 };
    return null;
  }
  if (kind === "person") {
    try {
      const p = db.query("SELECT revoked_at FROM people WHERE id = ?").get(id) as { revoked_at: number | null } | undefined;
      if (!p) return { msg: "persona sconosciuta", status: 404 };
      if (p.revoked_at !== null) return { msg: "quella persona è stata revocata", status: 400 };
      const owner = db.query("SELECT 1 FROM installation_owners WHERE person_id = ?").get(id);
      if (owner) return { msg: "quella persona vede già tutto: è una proprietaria, non un'ospite", status: 400 };
      return null;
    } catch {
      return { msg: "le persone non sono ancora disponibili su questo database", status: 400 };
    }
  }
  try {
    const o = db.query("SELECT revoked_at FROM orgs WHERE id = ?").get(id) as { revoked_at: number | null } | undefined;
    if (!o) return { msg: "organizzazione sconosciuta", status: 404 };
    if (o.revoked_at !== null) return { msg: "quell'organizzazione è stata revocata", status: 400 };
    return null;
  } catch {
    return { msg: "le organizzazioni non sono ancora disponibili su questo database", status: 400 };
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

  const listDevices = (): DeviceRecord[] =>
    (db.query("SELECT * FROM devices ORDER BY revoked_at IS NOT NULL, last_seen_at DESC, created_at DESC").all() as Record<string, unknown>[])
      .map(rowToDevice);

  return async function authRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {
    if (!pathname.startsWith("/api/auth/")) return null;
    const now = Date.now();
    sweep(now);
    const ip = ctx.requestIp?.(req) ?? null;
    const loopback = isLoopbackAddress(ip);
    const secure = url.protocol === "https:";

    // ── Chi sono? Esente dall'identità: è la domanda che si fa PRIMA di averla.
    if (method === "GET" && pathname === "/api/auth/session") {
      if (loopback) {
        return json({ paired: true, as: "loopback", name: "Questo computer", role: "owner" });
      }
      const token = readSessionCookie(req.headers.get("cookie"));
      if (!token) return json({ paired: false, as: null, name: null });
      const row = db.query("SELECT * FROM devices WHERE token_hash = ?").get(hashToken(token)) as Record<string, unknown> | undefined;
      if (!row) return json({ paired: false, as: null, name: null });
      const d = rowToDevice(row);
      if (d.revokedAt !== null) return json({ paired: false, as: null, name: null, code: "device_revoked" });
      return json({ paired: true, as: "device", name: d.name, deviceId: d.id, role: d.role });
    }

    // ── Il dispositivo nuovo chiede accesso e riceve il codice DA MOSTRARE.
    if (method === "POST" && pathname === "/api/auth/pair/request") {
      // `sweep` è già passato: ciò che resta è vivo, non residuo.
      if (pending.size >= MAX_PENDING_TOTAL) {
        return json({ error: "troppe richieste in attesa, riprova fra poco" }, 429);
      }
      if (ip && [...pending.values()].filter((p) => p.ip === ip).length >= MAX_PENDING_PER_IP) {
        return json({ error: "troppe richieste da questo dispositivo" }, 429);
      }
      const name = deviceNameFromUserAgent(req.headers.get("user-agent"));
      const id = crypto.randomUUID();
      const entry: PendingPairing = {
        id, code: mintPairingCode(), name, ip, createdAt: now, state: "pending", token: null,
      };
      pending.set(id, entry);
      ctx.broadcast?.({ type: "auth:pair-requested", requestId: id, code: entry.code, name, ip });
      return json({ requestId: id, code: entry.code, name, expiresInMs: PAIRING_CODE_TTL_MS });
    }

    // ── Il dispositivo nuovo attende. Alla conferma riceve il cookie, UNA volta.
    // NOTA: esente dall'identita' (`isIdentityExemptPath`) — un dispositivo in
    // attesa non ne ha ancora una, ed e' proprio questa risposta a dargliela.
    if (method === "GET" && pathname === "/api/auth/pair/status") {
      const id = url.searchParams.get("requestId") ?? "";
      const entry = pending.get(id);
      if (!entry) return json({ state: "expired" });
      if (entry.state === "denied") { pending.delete(id); return json({ state: "denied" }); }
      if (entry.state !== "approved" || !entry.token) return json({ state: "pending" });
      // Consegna unica: il token esce dalla memoria appena tocca il filo.
      const token = entry.token;
      pending.delete(id);
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
      const body = await readJSON(req) as { requestId?: string; role?: unknown } | null;
      const entry = pending.get(body?.requestId ?? "");
      if (!entry) return json({ error: "richiesta scaduta o inesistente" }, 404);

      if (pathname.endsWith("/deny")) {
        entry.state = "denied";
        ctx.broadcast?.({ type: "auth:pair-resolved", requestId: entry.id, approved: false });
        return json({ ok: true });
      }

      const token = mintSessionToken();
      const deviceId = crypto.randomUUID();
      // `owner` di default: il caso normale è il tuo secondo telefono, e un
      // default `guest` renderebbe l'appaiamento normale una trappola in cui non
      // si vede niente e non si capisce perché. Il prezzo è che il default è
      // anche il più permissivo — per questo la scelta è esplicita nel cartello
      // e il ruolo si legge nell'elenco, così un errore si vede e si corregge.
      const role = body?.role === "guest" ? "guest" : "owner";
      db.query(
        "INSERT INTO devices (id, name, token_hash, created_at, last_seen_at, first_ip, revoked_at, role) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
      ).run(deviceId, entry.name, hashToken(token), now, now, entry.ip, role);
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
        devices: listDevices().map((d) => ({
          id: d.id, name: d.name, role: d.role, createdAt: d.createdAt,
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
      const body = await readJSON(req) as { name?: unknown } | null;
      const name = typeof body?.name === "string" ? body.name.trim().slice(0, 60) : "";
      if (!name) return json({ error: "nome vuoto" }, 400);
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
      const { task: idTask, topic: idTopic } = grantedByType(db as never, deviceP(subj));
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

      for (const d of listDevices()) {
        if (d.revokedAt !== null || d.role !== "guest") continue;
        if (conPersona.has(d.id)) continue;
        soggetti.push({ subjectType: "device", subjectId: d.id, name: d.name, devices: 1 });
      }

      try {
        // Le persone che NON sono proprietarie: condividere con chi vede già
        // tutto non vuol dire niente.
        const persone = db.query(`
          SELECT p.id, p.display_name,
                 (SELECT COUNT(*) FROM devices d WHERE d.person_id = p.id AND d.revoked_at IS NULL) AS n
            FROM people p
           WHERE p.revoked_at IS NULL
             AND p.id NOT IN (SELECT person_id FROM installation_owners)
           ORDER BY p.display_name`).all() as Array<{ id: string; display_name: string; n: number }>;
        for (const p of persone) {
          soggetti.push({ subjectType: "person", subjectId: p.id, name: p.display_name, devices: Number(p.n) });
        }

        const orgs = db.query(`
          SELECT o.id, o.name,
                 (SELECT COUNT(*) FROM org_members om WHERE om.org_id = o.id
                    AND om.revoked_at IS NULL AND om.local_blocked_at IS NULL) AS n
            FROM orgs o WHERE o.revoked_at IS NULL ORDER BY o.name`).all() as Array<{ id: string; name: string; n: number }>;
        for (const o of orgs) {
          // Un'organizzazione da UNA persona non si nomina: il singolo è
          // un'organizzazione di uno perché il codice abbia una strada sola,
          // non perché il prodotto abbia due vocabolari.
          if (Number(o.n) <= 1) continue;
          soggetti.push({ subjectType: "org", subjectId: o.id, name: o.name, devices: Number(o.n) });
        }
      } catch {
        // Schema più vecchio della 084: restano i soli dispositivi ospiti.
      }

      return json({ subjects: soggetti });
    }

    if (pathname === "/api/auth/shares") {
      // Generico sul TIPO di risorsa: `task` e `topic` oggi, e domani ciò che
      // avrà una riga vera. Una rotta per tipo sarebbe la stessa divergenza che
      // il modello unico serve a evitare.
      if (method === "GET") {
        const tipo = url.searchParams.get("resourceType") ?? "task";
        const id = url.searchParams.get("resourceId") ?? url.searchParams.get("taskId") ?? "";
        if (!isResourceType(tipo)) return json({ error: "tipo di risorsa sconosciuto" }, 400);
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
              // La PROVENIENZA risponde a «perché costui vede questa cosa?».
              via: r.viaType ? { type: r.viaType, id: r.viaId } : null,
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
        if (!isResourceType(tipo)) return json({ error: "tipo di risorsa sconosciuto" }, 400);

        // `deviceId` resta accettato come alias legacy per una release: il
        // client vecchio continua a funzionare mentre quello nuovo passa a
        // `subjectType`/`subjectId`. La rotta ha già esattamente questo idioma
        // con `taskId` → `resourceId`.
        const sogTipo = body?.subjectType ?? (body?.deviceId ? "device" : undefined);
        const sogId = body?.subjectId ?? body?.deviceId;
        if (!risorsa || !sogId || !sogTipo) return json({ error: "resourceId e subjectId richiesti" }, 400);
        if (!isSubjectKind(sogTipo)) return json({ error: "tipo di soggetto sconosciuto" }, 400);

        // Condividere con chi vede GIÀ tutto non vuol dire niente, e lasciarlo
        // fare darebbe l'idea che quella riga stia limitando qualcosa. La
        // domanda però non è più «che ruolo ha questo dispositivo?» ma «questo
        // soggetto è confinato?», che è la stessa cosa detta nel modello nuovo.
        const rifiuto = motivoRifiutoSoggetto(db, sogTipo, sogId);
        if (rifiuto) return json({ error: rifiuto.msg }, rifiuto.status);

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
        if (!isResourceType(tipo)) return json({ error: "tipo di risorsa sconosciuto" }, 400);
        if (!isSubjectKind(sogTipoRaw)) return json({ error: "tipo di soggetto sconosciuto" }, 400);
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
      if (token) db.query("UPDATE devices SET revoked_at = ? WHERE token_hash = ?").run(now, hashToken(token));
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
