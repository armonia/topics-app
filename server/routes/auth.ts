import type { AppContext, RouteHandler } from "../types";
import {
  hashToken, mintSessionToken, mintPairingCode,
  buildSessionCookie, buildClearedSessionCookie,
  readSessionCookie, PAIRING_CODE_TTL_MS,
  type DeviceRecord,
} from "../lib/device-auth";
import { isLoopbackAddress } from "../lib/auth-gate";

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
        return json({ paired: true, as: "loopback", name: "Questo computer" });
      }
      const token = readSessionCookie(req.headers.get("cookie"));
      if (!token) return json({ paired: false, as: null, name: null });
      const row = db.query("SELECT * FROM devices WHERE token_hash = ?").get(hashToken(token)) as Record<string, unknown> | undefined;
      if (!row) return json({ paired: false, as: null, name: null });
      const d = rowToDevice(row);
      if (d.revokedAt !== null) return json({ paired: false, as: null, name: null, code: "device_revoked" });
      return json({ paired: true, as: "device", name: d.name, deviceId: d.id });
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
      const body = await readJSON(req) as { requestId?: string } | null;
      const entry = pending.get(body?.requestId ?? "");
      if (!entry) return json({ error: "richiesta scaduta o inesistente" }, 404);

      if (pathname.endsWith("/deny")) {
        entry.state = "denied";
        ctx.broadcast?.({ type: "auth:pair-resolved", requestId: entry.id, approved: false });
        return json({ ok: true });
      }

      const token = mintSessionToken();
      const deviceId = crypto.randomUUID();
      db.query(
        "INSERT INTO devices (id, name, token_hash, created_at, last_seen_at, first_ip, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)",
      ).run(deviceId, entry.name, hashToken(token), now, now, entry.ip);
      entry.state = "approved";
      entry.token = token;
      ctx.broadcast?.({ type: "auth:pair-resolved", requestId: entry.id, approved: true, deviceId });
      return json({ ok: true, deviceId });
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
          id: d.id, name: d.name, createdAt: d.createdAt,
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
      ctx.broadcast?.({ type: "auth:device-revoked", deviceId: id });
      return json({ ok: true });
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
