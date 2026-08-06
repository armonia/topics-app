/**
 * device-auth — identità per DISPOSITIVO. La parte pura: nessun DB, nessuna
 * richiesta, tutto testabile senza avviare un server.
 *
 * Il modello, e perché è questo:
 *
 * UN DISPOSITIVO, NON UN UTENTE. Il proprietario è uno. Serve distinguere QUALE
 * dispositivo e poterlo revocare, non registrare persone: niente password,
 * niente account, nessun servizio esterno.
 *
 * APPROVA IL MAC, NON INDOVINA IL TELEFONO. Il dispositivo nuovo MOSTRA un
 * codice; la macchina che ha già la sessione lo conferma. Il verso non è
 * estetico: uno schema in cui il telefono INSERISCE un PIN va difeso dal
 * brute-force con un rate limiter, e in questo server non ne esiste nessuno
 * (zero `429` in tutto il repo). Invertendo il verso quel pezzo non serve — il
 * codice non è un segreto da indovinare, è un'etichetta da CONFRONTARE, e chi
 * approva è già dentro.
 *
 * IL TOKEN VIVE NEL COOKIE, L'HASH NEL DB. Il browser attacca un cookie da solo
 * a tutte le ~94 fetch `/api` e a tutti e 4 i WebSocket; un header avrebbe
 * richiesto tre percorsi separati (fetch, WS in query, SSE) e la riattivazione
 * dello shim di rete, che oggi sul telefono non si installa proprio. Nel DB
 * resta solo lo SHA-256: un backup, o una lettura del file server ancora da
 * sandboxare, consegna dati ma non accessi.
 */
import { createHash, randomBytes, timingSafeEqual } from "crypto";

/** Nome del cookie di sessione. */
export const SESSION_COOKIE = "topics_device";

/** Quanto vive una sessione senza essere usata. Lunga di proposito: un telefono
 *  che si riappaia ogni settimana insegna solo a cliccare «Autorizza» senza
 *  leggere, che è il contrario di ciò che serve. */
export const SESSION_TTL_MS = 400 * 24 * 60 * 60 * 1000;

/** Un codice di appaiamento scaduto non si approva: la finestra è corta perché
 *  è il tempo che serve a girare lo sguardo dal telefono al Mac. */
export const PAIRING_CODE_TTL_MS = 3 * 60 * 1000;

/**
 * Alfabeto del codice mostrato a schermo. Niente `0/O`, `1/I/L`, `5/S`, `8/B`:
 * il codice esiste per essere CONFRONTATO da un umano fra due schermi, e una
 * coppia ambigua trasforma un confronto in un dubbio. 26 simboli, 6 posizioni.
 */
const CODE_ALPHABET = "ACDEFGHJKMNPQRTUVWXY234679";

export interface DeviceRecord {
  id: string;
  name: string;
  /** `owner` vede tutto (i tuoi dispositivi); `guest` vede SOLO cio' che gli e'
   *  stato condiviso. Sta sul dispositivo e non su una tabella di persone:
   *  l'ospite E' il dispositivo, e due modelli d'identita' da tenere in sincrono
   *  sono due verita' che prima o poi divergono. */
  role: 'owner' | 'guest';
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number | null;
  firstIp: string | null;
  revokedAt: number | null;
}

/** Come si è presentata la richiesta: è l'asse del TRASPORTO. */
export type Transport = "loopback" | "remote";

export interface IdentityInput {
  transport: Transport;
  /** Token di sessione presentato dal cookie, se c'è. */
  sessionToken: string | null;
  /** Il dispositivo che quel token identifica, già cercato dal chiamante. */
  device: DeviceRecord | null;
  /** Token del daemon presentato via `Authorization: Bearer`, se c'è. */
  bearerToken: string | null;
  /** Il token del daemon atteso. */
  expectedDaemonToken: string | null;
  /** Adesso, iniettato per rendere la scadenza testabile. */
  now: number;
}

export type IdentityResult =
  | { ok: true; as: "loopback" | "device" | "daemon"; deviceName: string | null; role: 'owner' | 'guest'; deviceId: string | null }
  | { ok: false; status: number; reason: string; code: string };

/** SHA-256 esadecimale. L'unica forma in cui un token tocca il disco. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 32 byte di entropia in esadecimale. Non indovinabile, e non è un segreto
 *  condiviso: ogni dispositivo ha il suo, e revocarne uno non tocca gli altri. */
export function mintSessionToken(): string {
  return randomBytes(32).toString("hex");
}

/** Il codice che il dispositivo nuovo MOSTRA e la macchina fidata CONFRONTA.
 *  Formattato a gruppi di tre perché sei caratteri di fila si leggono male. */
export function mintPairingCode(): string {
  const bytes = randomBytes(6);
  let out = "";
  for (let i = 0; i < 6; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `${out.slice(0, 3)}-${out.slice(3)}`;
}

/** Confronto a tempo costante fra due stringhe di lunghezza attesa uguale. */
export function tokensMatch(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Legge il token di sessione da un header `Cookie`. Nessuna libreria: il formato
 * è `k=v; k=v`, e una dipendenza per questo sarebbe superficie in più su un
 * percorso che gira a ogni richiesta.
 */
export function readSessionCookie(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const v = part.slice(eq + 1).trim();
    return v.length > 0 ? v : null;
  }
  return null;
}

/**
 * Il cookie da emettere all'approvazione.
 *
 * `HttpOnly` — nessun JS lo legge, quindi un XSS non se lo porta via.
 * `SameSite=Lax` — non viaggia su una richiesta cross-site, che è la seconda
 *   linea dietro il check d'origine.
 * `Secure` — solo su HTTPS. Il server serve TLS; su `NO_TLS` va omesso o il
 *   cookie non verrebbe mai memorizzato.
 * `Path=/` — serve anche a `/preview`, `/media`, `/uploads` e `/ws`, non solo a
 *   `/api`: sono tutte superfici gated, e un cookie ristretto le lascerebbe fuori.
 */
export function buildSessionCookie(token: string, opts: { secure: boolean; maxAgeMs?: number }): string {
  const maxAge = Math.floor((opts.maxAgeMs ?? SESSION_TTL_MS) / 1000);
  const bits = [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAge}`,
  ];
  if (opts.secure) bits.push("Secure");
  return bits.join("; ");
}

/** Il cookie che cancella la sessione: stesso nome, stesso path, età zero. */
export function buildClearedSessionCookie(opts: { secure: boolean }): string {
  return buildSessionCookie("", { ...opts, maxAgeMs: 0 });
}

/**
 * La decisione sull'IDENTITÀ. Ordine, e ogni riga ha una ragione:
 *
 *   1. LOOPBACK è fidato. Non è pigrizia: il guscio Tauri raggiunge :3333 dal suo
 *      proxy locale, la CLI, i tool MCP e gli hook girano sulla macchina. Chi è
 *      già dentro la macchina non ha bisogno di bussare, e pretenderlo
 *      chiuderebbe fuori il proprietario alla prima disavventura — è anche la
 *      rete di sicurezza contro il lockout.
 *   2. Una SESSIONE valida e non revocata identifica un dispositivo.
 *   3. Il TOKEN DEL DAEMON resta per gli agenti che parlano da fuori loopback.
 *   4. Altrimenti 401 con `code: "device_not_paired"`, che è ciò su cui il client
 *      apre la schermata di appaiamento. Un 401 senza codice sarebbe di nuovo un
 *      vicolo cieco silenzioso, che è il difetto per cui il pairing precedente
 *      non è mai servito a nessuno.
 */
export function evaluateIdentity(i: IdentityInput): IdentityResult {
  // Loopback e' il proprietario per definizione: e' la macchina su cui gira il
  // server, e non c'e' un ruolo piu' alto da assegnarle.
  if (i.transport === "loopback") return { ok: true, as: "loopback", deviceName: null, role: 'owner', deviceId: null };

  if (i.sessionToken && i.device) {
    if (i.device.revokedAt !== null) {
      return { ok: false, status: 401, reason: "device revoked", code: "device_revoked" };
    }
    const age = i.now - (i.device.lastSeenAt ?? i.device.createdAt);
    if (age > SESSION_TTL_MS) {
      return { ok: false, status: 401, reason: "session expired", code: "session_expired" };
    }
    return { ok: true, as: "device", deviceName: i.device.name, role: i.device.role, deviceId: i.device.id };
  }

  if (i.bearerToken && tokensMatch(i.bearerToken, i.expectedDaemonToken)) {
    return { ok: true, as: "daemon", deviceName: null, role: 'owner', deviceId: null };
  }

  return { ok: false, status: 401, reason: "device not paired", code: "device_not_paired" };
}

/**
 * I percorsi raggiungibili SENZA identità, perché sono il modo di ottenerla.
 * Tenuto qui accanto alla decisione così «cosa è esente» e «come si decide» non
 * possono divergere: un'esenzione dimenticata altrove sarebbe un buco, una di
 * troppo un vicolo cieco in cui non ci si può appaiare.
 *
 * Restano soggetti al check d'ORIGINE: esente dall'identità non vuol dire che un
 * sito web possa avviare un appaiamento dalla scheda accanto.
 */
/**
 * La superficie che un OSPITE può toccare. Tutto il resto è negato dal gate.
 *
 * È un'allowlist e non una lista di divieti, e la differenza non è di stile: un
 * elenco di cose vietate sopra un default permissivo è la forma in cui i buchi si
 * nascondono — se ne dimentica una e nessuno se ne accorge. Misurato mentre
 * costruivo questo: col filtro messo solo nel router dei task, un ospite leggeva
 * `/api/topics` per intero. Il router giusto non era uno: era il gate.
 *
 * Cosa NON c'è dentro, di proposito: i progetti, i terminali, i file, il browser,
 * le impostazioni, il dispatch. Un ospite non è un utente con meno voci di menu,
 * è qualcuno che può vedere alcune schede di lavoro e nient'altro.
 */
export function isGuestAllowedPath(pathname: string): boolean {
  return (
    pathname === "/api/all-boards/tasks" ||
    pathname.startsWith("/api/tasks/") ||
    pathname === "/api/auth/session" ||
    pathname === "/api/auth/logout" ||
    // Le anteprime dei task condivisi. Il gate le lascia passare solo dopo aver
    // verificato che QUEL file sia l'anteprima di un task condiviso con QUESTO
    // ospite: l'allowlist apre il percorso, non il contenuto.
    pathname.startsWith("/media/") ||
    // Gli aggiornamenti dal vivo: senza, la scheda condivisa è una fotografia.
    pathname === "/ws"
  );
}

export function isIdentityExemptPath(pathname: string): boolean {
  return (
    pathname === "/api/auth/pair/request" ||
    // Il dispositivo in attesa DEVE poter chiedere «e' stato approvato?» prima di
    // avere una sessione: e' la risposta a questa domanda che gliela consegna.
    pathname === "/api/auth/pair/status" ||
    pathname === "/api/auth/session"
  );
}
