// SPA navigation fallback — the single, testable predicate deciding whether a
// request that fell through ALL api/asset/static routing should be served the
// app shell (public/index.html) instead of a 404.
//
// Client-side routes like `/task/<uuid>` (path-based board deep-links) have no
// file on disk; a full-page load (refresh / pasted link) must still boot the app
// so openTaskLink can read the path. But we must NOT mask real 404s: an unknown
// `/api/*` route or a missing asset (`/assets/foo.js`) has to stay a 404.
//
// This is called in server.ts AFTER every api/asset/static branch, so by the
// time we get here the request matched nothing on disk. The guard therefore only
// needs to recognize a NAVIGATION: a GET whose client wants HTML and whose path
// has no file extension (its last segment carries no '.'), oppure che sta su un
// prefisso di rotta client noto (`CLIENT_ROUTE_PREFIXES` qui sotto, dove la
// chiave PUÒ contenere un punto). `/api` and `/ws` are excluded defensively —
// an unmatched API call is a real 404, never the shell.

export interface SpaFallbackRequest {
  method: string;
  pathname: string;
  /** The request's `Accept` header (or null/empty if absent). */
  accept: string | null;
}

/**
 * I prefissi delle rotte CLIENT che conosciamo per nome — i permalink alle tab
 * (`shared/tab-link.ts`) e i due alias storici che il drawer della board e la
 * push di fine turno riflettono nella history.
 *
 * PERCHÉ un'allowlist e non solo la regola generica qui sotto: la chiave di un
 * permalink può contenere un PUNTO. `/tab/project/<path>` e
 * `/tab/file/<path>/<file>` portano path veri (`/Users/x/my.app`,
 * `App.tsx`), e la regola "l'ultimo segmento ha un'estensione ⇒ è un asset"
 * risponderebbe 404 a una navigazione perfettamente valida — in silenzio, con
 * il rosso che poi accusa il client. La grammatica si difende già da sola
 * (base64url non produce mai un punto: `encodeTabSegment`), ma un link scritto
 * a mano, copiato da un log o generato da una versione più vecchia non passa
 * di lì. Due difese indipendenti sullo stesso guasto, e nessuna delle due da
 * sola è un single point of failure.
 *
 * Le guardie che restano SOPRA: method/`/api`/`/ws`/Accept. Un POST su
 * `/tab/...`, un `/api/...` sconosciuto o un client non-HTML devono continuare
 * a ricevere il loro 404 vero — l'allowlist allarga cosa è una NAVIGAZIONE,
 * non cosa è pubblico.
 */
const CLIENT_ROUTE_PREFIXES = ["/task/", "/topic/", "/tab/"] as const;

// Does this `Accept` leave room for HTML? True when it names `text/html` and
// when it accepts ANY type. False when it asks for something else and for
// nothing that could be a page, and false when there is no header at all: an
// absent `Accept` is not a browser navigation, and the shell is a page.
function acceptsHtmlOrAnything(accept: string | null): boolean {
  const a = (accept || "").trim().toLowerCase();
  if (a === "") return false;
  return a.includes("text/html") || a.includes("*/*") || a.includes("text/*");
}

export function shouldServeSpaFallback({ method, pathname, accept }: SpaFallbackRequest): boolean {
  // GET **o HEAD**: per RFC 9110 §9.3.2 la risposta a HEAD è quella di GET senza
  // il corpo, quindi un link checker che chiede «esiste /task/<uuid>?» deve
  // leggere lo stesso 200 di una navigazione vera. Prima qui HEAD cadeva nel
  // ramo "non-GET" insieme a POST e riceveva un 404 che contraddiceva il GET
  // sullo stesso path. Il corpo lo toglie Bun.serve da sé.
  if (method !== "GET" && method !== "HEAD") return false;
  if (pathname.startsWith("/api/") || pathname.startsWith("/ws")) return false;
  // Rotta client nota per nome → shell, anche se la chiave contiene un punto.
  //
  // `Accept` is NOT a condition here, and that is the difference from the
  // generic branch below. A permalink is an ADDRESS OF THE APP, and what opens
  // it is often not a browser's rendering engine but something in front of it
  // sending `Accept: *` + `/*`: the OS link handler, an embedded webview, a
  // chat client's preview, a curl pasted into a report. With the Accept guard
  // in the way those clients read `404 Not Found` in `text/plain` on a
  // perfectly valid link, so the app's own address answered "does not exist"
  // depending on WHO knocked. A client that explicitly asks for something else
  // (`application/json` and nothing more) still gets its real 404.
  if (CLIENT_ROUTE_PREFIXES.some((p) => pathname.startsWith(p))) return acceptsHtmlOrAnything(accept);
  if (!(accept || "").includes("text/html")) return false;
  // Last path segment carries a file extension → it's an asset request that
  // already 404'd upstream; leave it 404 rather than serving HTML.
  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  return !lastSegment.includes(".");
}
