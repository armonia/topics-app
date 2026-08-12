/**
 * auth-gate — la UNICA decisione di autorizzazione su `/api`, `/ws` e le radici
 * che servono file (`/preview`, `/media`, `/uploads`) del server :3333.
 *
 * DUE assi, e vanno superati ENTRAMBI:
 *
 *   ORIGINE (CSRF) — *quale pagina sta guidando il browser*. Un sito ostile
 *     aperto in una scheda qualunque raggiunge questo server DALLA MACCHINA
 *     dell'utente. Vale per chiunque, sessione valida compresa: un cookie buono
 *     guidato da una pagina forestiera E' il CSRF, non la sua smentita.
 *
 *   IDENTITA' — *chi sta bussando*. Risolto dal chiamante (serve il DB) e passato
 *     qui già deciso, così questo modulo resta puro. Vedi `lib/device-auth.ts`.
 *
 * L'ordine conta, ed è la ragione per cui questo file è stato riscritto. Fino a
 * `device-auth` la regola usciva ad `allow` per ogni metodo non mutante PRIMA di
 * ogni altro controllo: innestare l'identità dopo avrebbe lasciato **tutte le GET
 * aperte a `curl`** dalla rete, `/preview` compreso — che è esattamente la falla
 * misurata il 2026-08-06 (un `GET /preview/<path assoluto>` da una seconda rete
 * presente sulla macchina rispondeva `200`). La corsia veloce delle letture ora
 * vive solo dentro l'asse d'ORIGINE, dove è corretta; l'identità le vede tutte.
 *
 * La regola:
 *   1. `authOff`                                   → allow (botola di recupero)
 *   2. mutante o WS, con Origin forestiera         → 403
 *   3. identità risolta e negativa                 → 401 col suo `code`
 *   4. altrimenti                                  → allow
 *
 * Il confronto same-site è sull'HOSTNAME canonicalizzato, non sull'autorità, e
 * `localhost`/`127.*`/`::1`/`*.localhost` collassano in una classe sola. Serve a
 * due proxy reali che riscrivono un lato e non l'altro: quello del guscio Tauri
 * (splice L4: `Origin: tauri://localhost` con `Host: 127.0.0.1:13333`) e quello di
 * Vite in dev (`changeOrigin: true` riscrive Host e lascia Origin). Così il
 * telefono passa su qualunque indirizzo senza allowlist di IP che marcisce.
 *
 * PERCHE' LE LETTURE NON PASSANO DAL CHECK D'ORIGINE: un `<img>`/`<script>`
 * cross-origin non manda `Origin`, quindi estenderlo non li fermerebbe; e una
 * `fetch` cross-origin non può LEGGERE la risposta perché `corsAllowOrigin`
 * (server.ts) non emette mai `Access-Control-Allow-Origin` per un'origine
 * forestiera. Quell'assenza è portante e `tests/e2e/lan-same-origin.spec.ts` la
 * pinna. Ma NON è autenticazione — a fermare `curl` è l'asse dell'identità.
 *
 * Puro + input iniettati, così l'intera matrice è testabile senza un server.
 */

export interface AuthInput {
  /** Header `Origin`, se c'è. `null` ⇒ non è un browser (o è una same-origin GET). */
  origin: string | null;
  /** Metodo HTTP (gli upgrade WS arrivano come GET). */
  method: string;
  /** Path della richiesta — serve a riconoscere un upgrade WS (`/ws`, `/ws/…`). */
  pathname: string;
  /** Header `Host` della richiesta. `null` ⇒ nessuna origine può essere same-site. */
  host: string | null;
  /** Kill-switch `TOPICS_AUTH_OFF`. */
  authOff: boolean;
  /** Origini extra ammesse oltre alla same-site, es. l'host di un tunnel. */
  allowedOrigins?: string[];
  /**
   * L'esito dell'asse IDENTITA', già risolto dal chiamante (richiede il DB, e
   * questo modulo resta puro). Assente ⇒ nessuna identità richiesta, cioè il
   * comportamento precedente a `device-auth`.
   */
  identity?: { ok: true } | { ok: false; status: number; reason: string; code: string };
}

export type AuthResult =
  | { allow: true }
  /** `code` distingue un rifiuto d'ORIGINE da uno d'IDENTITA': il client apre la
   *  schermata di appaiamento solo sul secondo, e un 401 senza codice sarebbe di
   *  nuovo un vicolo cieco muto — il difetto per cui il pairing precedente non è
   *  mai servito a nessuno. */
  | { allow: false; status: number; reason: string; code?: string };

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Classe d'equivalenza in cui collassano tutti i nomi che indicano questa macchina. */
const LOCAL_CLASS = "#local";

/**
 * True per un path di upgrade WebSocket. Il socket PRIMARIO è il `/ws` nudo (senza
 * slash finale — `useWebSocket.ts` apre `${base}/ws`); i socket di terminale e
 * browser stanno sotto `/ws/…`. Il gate e il check d'origine DEVONO concordare su
 * questo o un endpoint scivola fuori: chiavare solo su `/ws/` (con lo slash) aveva
 * lasciato scoperto proprio il `/ws` nudo, cioè il socket che porta ui-state e la
 * chat dal vivo. Un predicato solo, così i due non possono divergere.
 */
export function isWebSocketPath(pathname: string): boolean {
  return pathname === "/ws" || pathname.startsWith("/ws/");
}

/**
 * I path su cui si decide: l'API, gli upgrade WS (`/ws` + `/ws/…`) e le radici che
 * servono file — `/preview/…` (letture per path assoluto), `/media/…` (screenshot
 * degli agenti, download del browser, anteprime dei task) e `/uploads/…` (allegati
 * caricati dall'utente). Tutto il resto (bundle SPA, health check) è pubblico.
 * Sta qui accanto a `evaluateAuth` così «su cosa si decide» e «come si decide» non
 * possono divergere, e sono testabili entrambi senza avviare il server.
 */
export function isOriginGatedPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/") ||
    isWebSocketPath(pathname) ||
    pathname.startsWith("/preview/") ||
    pathname.startsWith("/media/") ||
    pathname.startsWith("/uploads/")
  );
}

/**
 * Loopback nelle due famiglie (inclusa la forma v4-mapped-v6 che Bun può
 * restituire). Non è più parte della decisione su `/api`: il suo unico chiamante è
 * il ramo `/__daemon/*` in `server.ts`, che è loopback-only per davvero.
 */
export function isLoopbackAddress(ip: string | null): boolean {
  if (!ip) return false;
  const a = ip.toLowerCase();
  return (
    a === "::1" ||
    a === "localhost" ||
    /^127\./.test(a) ||
    /^::ffff:127\./.test(a)
  );
}

/**
 * Riduce un hostname — o un `Host:` completo di porta — alla forma su cui si
 * confronta: minuscolo, senza porta, senza le parentesi dell'IPv6, e con ogni nome
 * che indica questa macchina collassato in `#local`.
 *
 * Le parentesi vanno tolte a mano: `new URL("https://[::1]:3333").hostname`
 * restituisce `"[::1]"`, parentesi incluse.
 */
export function canonHost(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let h = raw.trim().toLowerCase();
  if (!h) return null;

  if (h.startsWith("[")) {
    // IPv6 fra parentesi, con o senza porta: `[::1]` / `[::1]:3333`.
    const end = h.indexOf("]");
    if (end === -1) return null;
    h = h.slice(1, end);
  } else {
    // Un solo `:` è una porta; più di uno è un IPv6 nudo, che non va tagliato.
    const first = h.indexOf(":");
    if (first !== -1 && h.indexOf(":", first + 1) === -1) h = h.slice(0, first);
  }
  if (!h) return null;

  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "::1" ||
    h === "0:0:0:0:0:0:0:1" ||
    /^127\./.test(h) ||
    /^::ffff:127\./.test(h)
  ) {
    return LOCAL_CLASS;
  }
  return h;
}

/**
 * L'hostname canonicalizzato di un'origine, o `null` se non è un'origine
 * analizzabile. Il letterale `Origin: null` — che arriva da `about:blank`, da un
 * iframe sandboxed o da un documento `data:` — finisce qui e NON è same-site:
 * un'origine opaca non è la nostra.
 */
export function originHost(origin: string): string | null {
  try {
    return canonHost(new URL(origin).hostname);
  } catch {
    return null;
  }
}

/** True se l'origine e l'host della richiesta sono lo stesso sito. */
export function isSameSite(origin: string | null, host: string | null): boolean {
  if (!origin) return false;
  const o = originHost(origin);
  if (o === null) return false;
  const h = canonHost(host);
  return h !== null && o === h;
}

/**
 * Origini extra ammesse oltre alla same-site — per esempio l'hostname di un
 * tunnel. Da `TOPICS_ALLOWED_ORIGINS` (separate da virgola), letta a OGNI
 * valutazione: la vecchia cache al primo uso era una trappola, perché cambiare la
 * variabile a caldo non aveva effetto e il valore restava quello del boot. Vuota di
 * default.
 */
export function resolveAllowedOrigins(): string[] {
  return (process.env.TOPICS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * La decisione unica. Restituisce lo status da mandare in caso di rifiuto, così il
 * chiamante non lo ri-deriva.
 */
export function evaluateAuth(i: AuthInput): AuthResult {
  if (i.authOff) return { allow: true };

  // ── Asse ORIGINE (CSRF) ────────────────────────────────────────────────────
  // Vale per CHIUNQUE, sessione valida compresa: un cookie buono guidato da una
  // pagina forestiera E' il CSRF, non la sua smentita. Solo le richieste che
  // CAMBIANO qualcosa (o aprono un socket) possono essere forgiate in modo utile
  // — una lettura cross-origin resta illeggibile perché il CORS non concede mai
  // l'origine forestiera.
  if (MUTATING.has(i.method) || isWebSocketPath(i.pathname)) {
    // Nessun `Origin` ⇒ non è un browser (CLI, tool MCP, hook HTTP, sendBeacon
    // di teardown). Il CSRF è un attacco da browser.
    if (i.origin && !isSameSite(i.origin, i.host) && !(i.allowedOrigins?.includes(i.origin) ?? false)) {
      return { allow: false, status: 403, reason: "cross-site origin blocked" };
    }
  }

  // ── Asse IDENTITA' ─────────────────────────────────────────────────────────
  // Il chiamante l'ha già risolta (serve il DB) e ce la passa. Se manca, si
  // ricade sul comportamento precedente a `device-auth`: nessuna identità
  // richiesta. Serve perché il gate resti puro e perché i test che non parlano
  // di identità continuino a descrivere il solo asse d'origine.
  if (i.identity && !i.identity.ok) {
    return { allow: false, status: i.identity.status, reason: i.identity.reason, code: i.identity.code };
  }

  return { allow: true };
}

/*
 * NON esiste più un `evaluateOrigin` a parte, e la sua assenza è la regola.
 *
 * Era la copia dell'asse d'ORIGINE qui sopra, esportata «perché la matrice CSRF
 * si prova senza tirare dentro dispositivi e sessioni». Ma quella prova la fa
 * già `evaluateAuth` con `identity` omesso — è per questo che il campo è
 * opzionale — ed è così che `auth-gate.test.ts` asserisce l'intera matrice
 * d'origine. Nessuno la chiamava: né il gate (`server.ts:1706` → `evaluateAuth`,
 * unico punto di decisione per `/api`, `/ws`, `/preview`, `/media`, `/uploads`,
 * e lo stesso gestore serve anche l'ascoltatore del tunnel), né i test.
 *
 * Restava quindi una SECONDA copia della stessa regola CSRF in un file il cui
 * commento di testa dichiara «la UNICA decisione»: due copie non si sommano, si
 * scollano — e in questo repo un gate con due assi schiacciati in una riga sola
 * ha già prodotto un buco misurato. Chi cerca la decisione d'origine la trova
 * dentro `evaluateAuth`, dove è l'unica.
 */
