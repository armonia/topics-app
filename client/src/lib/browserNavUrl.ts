/**
 * Resolve a URL before handing it to a browser pane.
 *
 * Background — the white-screen bug: when a Claude session opens a freshly
 * started dev server (e.g. `open_browser_pane("http://localhost:3000")`), the
 * server broadcasts `browser:navigate`. The standalone layout used to rewrite
 * ANY localhost/127.0.0.1 URL to `window.location.hostname` AND force
 * `window.location.protocol` (https in the desktop app). On the Electron
 * desktop — where the WebContentsView runs on the SAME machine as the server —
 * that turned a reachable `http://localhost:3000` into an unreachable
 * `https://127.0.0.1:3000`, so Chromium showed `chrome-error://…` (a blank
 * white page). That is exactly the "apre il browser e si apre bianco" report.
 *
 * The rewrite only makes sense for a REMOTE web client (Tailscale / LAN): there
 * the client's browser genuinely cannot reach the server's localhost, so local
 * URLs are repointed at the host the client actually used. In every local case
 * (Electron desktop, or a web client served from localhost) the original URL is
 * directly reachable and must be left untouched — including its scheme.
 */
export function resolveBrowserNavigateUrl(raw: string): string {
  if (typeof window === 'undefined') return raw;

  // Un file locale non arriva come `file://` — arriva come `/api/media?path=…`,
  // da risolvere sulla NOSTRA origine (server/browser-local-file-url.ts). Qui e
  // non nel server perché la stessa app si serve su porte diverse a seconda di
  // chi guarda: il proxy in chiaro del guscio desktop, il server in TLS, l'host
  // che vede un telefono in LAN. Un assoluto deciso là è giusto per uno solo.
  if (raw.startsWith('/api/media?path=')) {
    try {
      return new URL(raw, window.location.origin).toString();
    } catch {
      return raw;
    }
  }

  const here = window.location.hostname;
  // Local web client (same machine as the server): localhost reachable too.
  if (!here || here === 'localhost' || here === '127.0.0.1') return raw;

  // Remote web client: repoint local URLs at the reachable host so the
  // iframe/stream can load them. Mirrors the long-standing remote behaviour.
  try {
    const parsed = new URL(raw);
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      parsed.hostname = here;
      parsed.protocol = window.location.protocol;
      return parsed.toString();
    }
  } catch {
    /* not a parseable URL — leave as-is */
  }
  return raw;
}

/**
 * Best-effort URL/search normalisation for the address bar.
 *
 * Full URLs (any `scheme://…`) and `about:` pass through untouched; a bare host
 * (`github.com`) gets `https://`; anything else (spaces, or no dot) becomes a
 * Google search. Shared by the address-bar submit (`BrowserToolbar`) and the
 * native hook's `navigate()` so the two agree.
 *
 * The bug this closes: the toolbar's submit used to force `http://` onto ANY
 * scheme-less text, which (a) shadowed the search fallback — typing "come fare
 * la pasta" navigated to `http://come fare la pasta` (a broken load) instead of
 * searching — and (b) downgraded bare hosts to `http://` where a browser
 * defaults to `https://`.
 */
/**
 * L'indirizzo su cui NAVIGARE, dato quello che hai scritto nella barra.
 *
 * Il verso opposto di `displayUrl`, e la coppia va tenuta insieme: la barra
 * mostra `file:///Users/…/contratto.pdf`, quindi premere Invio su quella riga
 * deve riportare allo stesso documento invece di sbattere contro il divieto
 * su `file://`. Il file lo serviamo, come per l'agente — con la differenza che
 * qui a chiederlo sei tu, e infatti il percorso non ha bisogno di essere
 * "sicuro": ha bisogno di essere raggiungibile. Se il server non può servirlo
 * risponde 403 e il 403 si LEGGE, che è il punto di tutta questa storia.
 */
export function toNavigableUrl(input: string): string {
  const s = input.trim();
  const path = s.startsWith('file://')
    ? decodeURIComponent(s.slice('file://'.length).replace(/^localhost/, ''))
    : s.startsWith('/') ? s : null;
  if (path === null || !path.startsWith('/')) return normalizeUrl(s);
  const ref = `/api/media?path=${encodeURIComponent(path)}`;
  if (typeof window === 'undefined') return ref;
  try {
    return new URL(ref, window.location.origin).toString();
  } catch {
    return ref;
  }
}

/**
 * L'indirizzo da MOSTRARE, che non è sempre quello su cui si naviga.
 *
 * Un file locale viaggia come `…/api/media?path=%2FUsers%2F…` perché è così che
 * lo si serve senza aprire `file://` a chi non è fidato. Ma quello è il
 * TRASPORTO: nella barra ci va il documento, `file:///Users/…/contratto.pdf`,
 * come mostra Chrome quando apre un PDF locale (l'indirizzo è il file, il
 * viewer interno non compare). Far leggere l'idraulica all'utente è un dettaglio
 * di implementazione che esce dallo schermo.
 *
 * Vale per l'assoluto e per il relativo: la stessa pane vede l'uno o l'altro a
 * seconda di chi l'ha navigata.
 */
export function displayUrl(raw: string): string {
  const i = raw.indexOf('/api/media?path=');
  if (i === -1) return raw;
  // Solo se `/api/media` è la ROTTA, non un pezzo di query di un altro sito:
  // `https://tizio.it/x?u=/api/media?path=…` non è roba nostra.
  if (i > 0 && !/^https?:\/\/[^/]+$/.test(raw.slice(0, i))) return raw;
  const path = raw.slice(i + '/api/media?path='.length).split('&')[0];
  try {
    const decoded = decodeURIComponent(path);
    return decoded.startsWith('/') ? `file://${decoded}` : raw;
  } catch {
    return raw;
  }
}

export function normalizeUrl(input: string): string {
  const s = input.trim();
  if (!s) return 'about:blank';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith('about:')) return s;
  // looks like a domain (has a dot, no spaces) → https://
  if (/^[^\s]+\.[^\s]+$/.test(s) && !s.includes(' ')) return `https://${s}`;
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}
