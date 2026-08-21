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


/**
 * Un host RAGGIUNGIBILE su internet non merita di viaggiare in chiaro.
 *
 * E' l'HTTPS-First di Chrome e di Safari: se scrivi `http://` su un sito
 * pubblico, il browser prova comunque prima la versione cifrata. Qui pero' non
 * si puo' copiare quel comportamento e basta, perche' la maggioranza assoluta
 * delle navigazioni di questa pane NON e' internet: sono server locali effimeri,
 * l'anteprima di un task su una porta alta, un dev server appena acceso. Nessuno
 * di quelli parla TLS, e alzarli a https non li rende sicuri: li spegne, e la
 * pane diventa bianca. Meglio nessuna promozione che una promozione che rompe
 * il caso frequente.
 *
 * Quindi si sale SOLO quando l'indirizzo e' plausibilmente pubblico, e si resta
 * fermi su tutto il resto:
 *  - il loopback in ogni sua forma (localhost, 127.0.0.0/8, ::1, 0.0.0.0, e i
 *    sottodomini *.localhost che risolvono comunque su questa macchina);
 *  - gli indirizzi privati di una LAN (10/8, 192.168/16, 172.16-31/12) e il
 *    link-local 169.254/16;
 *  - i nomi mDNS in `.local`, che sono la stessa rete di casa con un altro nome;
 *  - un host senza nemmeno un punto, che non e' un dominio ma la macchina della
 *    scrivania accanto;
 *  - una porta esplicita diversa da 80, che e' la firma di un dev server.
 *
 * Un `:80` scritto a mano invece sparisce insieme allo schema che lo
 * sottintendeva: portarselo dietro darebbe `https://sito.it:80`, cioe' TLS su
 * una porta in chiaro, che e' peggio del punto di partenza.
 */
export function httpsFirstUrl(url: string): string {
  if (!/^http:\/\//i.test(url)) return url;

  let host: string;
  let port: string;
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    // `port` e' vuota anche quando `:80` c'era scritto: e' la porta di default
    // di http, quindi il parser la toglie. Il che e' comodo, perche' l'unico
    // caso da escludere e' proprio la porta NON standard.
    port = u.port;
  } catch {
    return url;
  }

  if (!host || port !== '') return url;
  if (isLocalHostname(host)) return url;
  // Un nome senza punto non e' un dominio registrabile: e' un hostname di rete
  // locale, e non esiste una CA che gli firmi un certificato.
  if (!host.includes('.')) return url;

  const rest = url.slice('http://'.length).replace(/^([^/?#]*?):80(?=$|[/?#])/, '$1');
  return `https://${rest}`;
}

/** Vero per tutto cio' che non esce da questa macchina o da questa rete. */
function isLocalHostname(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '[::1]') return true;
  if (host === '0.0.0.0') return true;
  if (host.endsWith('.local')) return true;
  // 127.0.0.0/8 per intero, non solo 127.0.0.1: il loopback e' un blocco.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  // 172.16.0.0/12, cioe' il secondo ottetto da 16 a 31 e non oltre: 172.32 e'
  // gia' internet pubblico.
  const m = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (m) {
    const second = Number(m[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

/**
 * A reference to something this server holds, resolved against this origin.
 *
 * THE BUG THIS CLOSES. `browser-bridge.ts` deliberately persists a task's local
 * file as a RELATIVE reference, `/api/media?path=%2FUsers%2F...`, so the tab
 * survives a change of host. Nothing here knew that shape: the "looks like a
 * domain" test below sees a dot in `preview.png` and no space, so it produced
 * `https://` + `/api/media?...` = `https:///api/media?...`. WebKit collapses
 * the three slashes and **`api` becomes the hostname**. Measured: the pane
 * hangs on a DNS lookup for a host that does not exist and stays blank, while
 * the same path served properly answers 200.
 *
 * An absolute path is never a domain and never a search: it is this origin.
 */
function sameOriginPath(s: string, origin: string): string | null {
  if (!s.startsWith('/') || s.startsWith('//')) return null;
  // Without an origin (a worker, a test) the path is returned UNCHANGED. A
  // relative URL still navigates; inventing a host does not, and inventing one
  // is the whole defect.
  return origin ? `${origin}${s}` : s;
}

export function normalizeUrl(
  input: string,
  origin = typeof location === 'undefined' ? '' : location.origin,
): string {
  const s = input.trim();
  if (!s) return 'about:blank';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith('about:')) return httpsFirstUrl(s);
  const local = sameOriginPath(s, origin);
  if (local !== null) return local;
  // looks like a domain (has a dot, no spaces) → https://
  if (/^[^\s]+\.[^\s]+$/.test(s) && !s.includes(' ')) return `https://${s}`;
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}
