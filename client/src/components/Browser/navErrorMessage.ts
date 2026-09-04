/**
 * Da un errore di navigazione di WebKit a una frase che dice cosa è successo.
 *
 * Il pannello nativo riceve i did-fail di WKWebView (`browser_take_nav_errors`,
 * lato Rust) e finora mostrava tale e quale il `localizedDescription` di Cocoa.
 * Per la classe di gran lunga più frequente qui dentro — una scheda che riapre
 * su una porta di `localhost` — quella stringa è «Could not connect to the
 * server.»: non dice QUALE server, non dice che il problema è che su quella
 * porta non c'è nessuno in ascolto, e non lascia capire che «Riprova» non può
 * funzionare finché qualcuno non riaccende quel processo. Sintomo riportato:
 * «si avvia il browser con localhost che dice Could not connect to the server,
 * e se faccio riprova manco va, né si capisce qual è il vero problema».
 *
 * Perché capita così spesso: le schede del browser sono persistite con la loro
 * URL (`task-browser-tabs:*` in `ui_state`), e moltissime puntano all'ANTEPRIMA
 * di un task — un server effimero su una porta alta che muore con la sessione
 * dell'agente. La URL sopravvive al server, quindi riaprire quel task riapre una
 * scheda verso una porta spenta. Il `hint` esiste per dire proprio questo.
 *
 * Modulo puro e senza React apposta: la mappa dei codici è la cosa da tenere
 * sotto test, non il riquadro che la disegna.
 */

export interface RawNavError {
  /** URL fallita (NSErrorFailingURLStringKey). Può essere vuota. */
  url: string;
  /** `localizedDescription` di Cocoa. */
  description: string;
  /** Codice NSURLErrorDomain / WebKitErrorDomain. */
  code: number;
}

import type { Translate } from '../../../../shared/queue-reason-text';

export interface NavErrorText {
  /** La riga principale della strip. */
  message: string;
  /** Seconda riga, quando c'è dell'altro da sapere. */
  hint?: string;
}

/** Host + porta come li scriverebbe un umano: `localhost:3210`, `example.com`. */
function hostLabel(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (!u.hostname) return null;
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return null;
  }
}

/** Vero se la URL punta a questa macchina. */
export function isLoopbackUrl(raw: string): boolean {
  try {
    const h = new URL(raw).hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1' || h === '[::1]' || h.endsWith('.localhost');
  } catch {
    return false;
  }
}

// NSURLErrorDomain. Solo quelli che meritano una frase diversa dal default:
// aggiungerne uno per completismo, con lo stesso testo del fallback, sarebbe
// solo rumore.
const CANNOT_CONNECT = -1004;
const CONNECTION_LOST = -1005;
const CANNOT_FIND_HOST = -1003;
const TIMED_OUT = -1001;
const NOT_CONNECTED = -1009;
const FILE_NOT_FOUND = -1100;
const ATS_BLOCKED = -1022;
/** Famiglia TLS: handshake fallito, certificato scaduto / non fidato / non ancora valido. */
const TLS_CODES = new Set([-1200, -1201, -1202, -1203, -1204, -1205, -1206]);
/**
 * Non è di Cocoa: è il codice con cui il guscio dice «quella navigazione l'ho
 * rifiutata io» (`NAV_ERR_SCHEME_REFUSED` in desktop-tauri/src-tauri/src/lib.rs).
 * Sta fuori dagli intervalli di NSURLErrorDomain (-998…-1200) e di
 * WebKitErrorDomain (100…204), quindi non può essere scambiato per nessuno.
 */
const SCHEME_REFUSED = -7001;

/**
 * L'errore grezzo → il testo da mostrare.
 *
 * `description` resta il fallback: un codice che non conosciamo è meglio
 * riportarlo con le parole di WebKit che nasconderlo dietro un generico.
 */
export function navErrorMessage(e: RawNavError, tr: Translate): NavErrorText {
  const where = hostLabel(e.url);
  const loopback = isLoopbackUrl(e.url);
  // WebKit's own words when we do not recognise the code: reporting them is
  // better than hiding an unknown failure behind a generic sentence. They
  // arrive in the browser engine's language and stay as they are, which is
  // what a quoted diagnostic does.
  const fallback = e.description || tr('browser.navError.unknown', { code: e.code });

  // Il rifiuto che prima non si vedeva. Non è un fallimento della rete: la
  // navigazione non è mai partita, quindi WKWebView non ha nulla da riportare e
  // la pane restava com'era — vuota, se appena nata. È il «è tutto bianco».
  if (e.code === SCHEME_REFUSED) {
    const localFile = /^file:/i.test(e.url);
    return {
      message: tr(localFile ? 'browser.navError.localFile' : 'browser.navError.notAPage'),
      hint: localFile
        ? tr('browser.navError.localFile.hint')
        : tr('browser.navError.notAPage.hint', { url: e.url }),
    };
  }

  if (e.code === CANNOT_CONNECT || e.code === CONNECTION_LOST) {
    if (loopback && where) {
      return {
        message: tr('browser.navError.loopbackSilent', { where }),
        hint: tr('browser.navError.loopbackSilent.hint'),
      };
    }
    return { message: where ? tr('browser.navError.refused', { where }) : fallback };
  }

  if (e.code === CANNOT_FIND_HOST) {
    return { message: where ? tr('browser.navError.hostNotFound', { where }) : fallback };
  }

  if (e.code === TIMED_OUT) {
    return { message: where ? tr('browser.navError.timedOut', { where }) : fallback };
  }

  if (e.code === NOT_CONNECTED) {
    return { message: tr('browser.navError.offline') };
  }

  if (TLS_CODES.has(e.code)) {
    return {
      message: where ? tr('browser.navError.tls', { where }) : fallback,
      hint: fallback,
    };
  }

  if (e.code === ATS_BLOCKED) {
    return {
      message: where ? tr('browser.navError.ats', { where }) : fallback,
      hint: tr('browser.navError.ats.hint'),
    };
  }

  if (e.code === FILE_NOT_FOUND) {
    return { message: tr('browser.navError.fileNotFound', { what: e.url || fallback }) };
  }

  return { message: fallback };
}

/** `16:03` — l'ora del controllo, che è l'unica cosa che cambia fra un tentativo e l'altro. */
function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * La scheda NON è stata caricata perché su quella porta non c'è nessuno: lo
 * abbiamo chiesto al server (`/api/browsers/port-listening`) prima di provare.
 *
 * L'ora del controllo non è un dettaglio: senza, premere «Riprova» su una porta
 * morta non cambia niente sullo schermo e sembra che il bottone sia rotto.
 * Cambiando, dice «ho guardato di nuovo adesso, ancora niente».
 */
/** Cosa c'è da dire di una porta locale spenta, senza l'ora. */
export function loopbackDownText(url: string, tr: Translate): NavErrorText {
  return navErrorMessage({ url, description: '', code: CANNOT_CONNECT }, tr);
}

export function deadLoopbackNotice(url: string, checkedAt: Date, tr: Translate): NavErrorText {
  const base = loopbackDownText(url, tr);
  return {
    message: base.message,
    hint: `${tr('browser.navError.checkedAt', { clock: hhmm(checkedAt) })} ${base.hint ?? ''}`.trim(),
  };
}
