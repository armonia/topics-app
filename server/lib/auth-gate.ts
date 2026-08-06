/**
 * auth-gate — la UNICA decisione di autorizzazione su `/api`, `/ws` e le radici
 * che servono file (`/preview`, `/media`, `/uploads`) del server :3333.
 *
 * Modello (change `lan-open-same-origin`, 2026-08-06). Ci sono due assi, e il
 * server ne decide UNO SOLO:
 *
 *   TRASPORTO — *chi può raggiungere la porta*. Delegato alla rete. Nessun token,
 *     nessuna proprietà dell'indirizzo del peer: un telefono sulla LAN è un client
 *     come gli altri. Prima esisteva un pairing token per i peer non-loopback; è
 *     stato rimosso perché il link che lo trasportava non lo produceva nessuna UI,
 *     e sarà sostituito da un'autenticazione centralizzata che autentica la
 *     CONNESSIONE. Il punto d'innesto lato client è `installNetShim`.
 *
 *   ORIGINE (CSRF) — *quale pagina sta guidando il browser*. Questo resta, e non
 *     lo sostituisce nessuna autenticazione di rete: un sito ostile aperto in una
 *     scheda qualunque raggiunge questo server DALLA MACCHINA dell'utente, e con
 *     quello guiderebbe i terminali, scriverebbe file, lancerebbe script.
 *
 * La regola, in ordine:
 *   1. `authOff`                      → allow  (botola di recupero)
 *   2. non mutante e non WS           → allow  (le GET le protegge il CORS, sotto)
 *   3. `Origin` assente               → allow  (non è un browser: CLI, MCP, hook, sendBeacon)
 *   4. same-site(origin, host)        → allow
 *   5. origin ∈ allowedOrigins        → allow
 *   6. altrimenti                     → 403
 *
 * Il confronto same-site è sull'HOSTNAME canonicalizzato, non sull'autorità, e
 * `localhost`/`127.*`/`::1`/`*.localhost` collassano in una classe sola. Serve a
 * due proxy reali che riscrivono un lato e non l'altro: quello del guscio Tauri
 * (splice L4: `Origin: tauri://localhost` con `Host: 127.0.0.1:13333`) e quello di
 * Vite in dev (`changeOrigin: true` riscrive Host e lascia Origin). È anche già la
 * semantica di prima, che era cieca a porta e schema — cambia solo che il termine
 * di paragone non è più un elenco di nomi locali ma il nome del server stesso, così
 * il telefono passa su qualunque indirizzo senza allowlist di IP che marcisce.
 *
 * PERCHÉ LE GET NON PASSANO DI QUI, e perché è portante: un `<img>`/`<script>`
 * cross-origin non manda `Origin`, quindi estendere il check non li fermerebbe; e
 * una `fetch` cross-origin non può LEGGERE la risposta perché `corsAllowOrigin`
 * (server.ts) non emette mai `Access-Control-Allow-Origin` per un'origine
 * forestiera. Quell'assenza è ciò che protegge le letture. Allargare il CORS «per
 * far funzionare la PWA» aprirebbe in lettura tutta `/api` senza che niente diventi
 * rosso: per questo `tests/e2e/lan-same-origin.spec.ts` la pinna.
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
}

export type AuthResult = { allow: true } | { allow: false; status: number; reason: string };

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

  // Solo le richieste che CAMBIANO qualcosa (o aprono un socket) possono essere
  // forgiate in modo utile: una lettura cross-origin resta illeggibile perché il
  // CORS non concede mai l'origine forestiera.
  if (!MUTATING.has(i.method) && !isWebSocketPath(i.pathname)) return { allow: true };

  // Nessun `Origin` ⇒ non è un browser (CLI, tool MCP, hook HTTP, sendBeacon di
  // teardown). Il CSRF è un attacco da browser: chi può omettere l'header è già
  // dentro la macchina o dentro la rete, e in entrambi i casi non è questo il
  // confine che lo ferma.
  if (!i.origin) return { allow: true };

  if (isSameSite(i.origin, i.host)) return { allow: true };
  if (i.allowedOrigins?.includes(i.origin)) return { allow: true };

  return { allow: false, status: 403, reason: "cross-site origin blocked" };
}
