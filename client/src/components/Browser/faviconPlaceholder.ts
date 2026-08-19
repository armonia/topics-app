/**
 * Cosa disegnare al posto della favicon quando la favicon non c'è.
 *
 * Un browser vero non lascia mai un buco a sinistra dell'indirizzo: se il sito
 * non dichiara un'icona, ne mette una sua. Il quadrato vuoto è peggio di
 * un'icona generica per due motivi diversi: non dice niente, e occupa (o non
 * occupa) spazio a seconda del sito, quindi la barra dell'indirizzo salta di
 * qualche pixel ogni volta che si naviga.
 *
 * Qui si decide solo COSA mostrare, non come: una funzione pura, quindi
 * testabile senza montare niente.
 *
 *  - un indirizzo con un host reale prende il MONOGRAMMA di quell'host, su una
 *    pastiglia in tinta derivata dall'host stesso. Deterministica di proposito:
 *    lo stesso sito ha sempre lo stesso colore, in ogni pane e fra un riavvio e
 *    l'altro, cosi' l'occhio impara a riconoscerlo come riconosce una favicon;
 *  - un indirizzo SENZA host (`about:blank`, un file locale, una stringa che
 *    non è una URL) prende il globo: non c'è un dominio di cui essere iniziale.
 */

export interface FaviconPlaceholder {
  /** `globe` = nessun host di cui fare l'iniziale. */
  kind: 'globe' | 'monogram';
  /** La lettera da disegnare. Stringa vuota quando `kind` è `globe`. */
  letter: string;
  /** Tinta HSL 0..359, derivata dall'host. Stabile fra sessioni. */
  hue: number;
  /** L'host normalizzato (senza `www.`), o stringa vuota. Usato nel title. */
  host: string;
}

/**
 * Hash FNV-1a a 32 bit: stabile, senza dipendenze, e soprattutto SPECIFICATO.
 * `String.prototype.hashCode` non esiste e una somma di codepoint darebbe lo
 * stesso colore a `google.com` e `elgoog.com`.
 */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** L'host su cui basare iniziale e tinta, o `''` se l'indirizzo non ne ha uno. */
export function faviconHost(rawUrl: string): string {
  const s = (rawUrl || '').trim();
  if (!s) return '';
  // `about:`, `data:`, `blob:`, `file:` non hanno un host di cui parlare: anche
  // quando `new URL` li accetta, l'hostname che ne esce è vuoto o inventato.
  if (/^(about|data|blob|javascript|chrome|chrome-error):/i.test(s)) return '';
  let host = '';
  try {
    host = new URL(s).hostname;
  } catch {
    // Una riga scritta a mano nella barra ("github.com/topics") non è ancora
    // una URL: ci si prova col protocollo che il normalizer metterebbe.
    try {
      host = new URL(`https://${s}`).hostname;
    } catch {
      return '';
    }
  }
  if (!host) return '';
  return host.replace(/^www\./i, '').toLowerCase();
}

export function faviconPlaceholder(rawUrl: string): FaviconPlaceholder {
  const host = faviconHost(rawUrl);
  if (!host) return { kind: 'globe', letter: '', hue: 0, host: '' };
  // L'iniziale la si prende dal primo carattere ALFANUMERICO: un host che
  // comincia per `1.` o per `-` darebbe altrimenti un monogramma che non si
  // legge come un'iniziale. Se non ce n'è nessuno (un indirizzo IP nudo) si
  // torna al globo: `1` non è l'iniziale di niente.
  const initial = host.match(/[a-z0-9]/i)?.[0] ?? '';
  if (!initial || /^\d+(\.\d+)*$/.test(host)) return { kind: 'globe', letter: '', hue: 0, host };
  return { kind: 'monogram', letter: initial.toUpperCase(), hue: hash32(host) % 360, host };
}

/**
 * Il colore della pastiglia, come stringa CSS.
 *
 * Luminosità fissa e bassa saturazione perché la lettera sopra è sempre bianca:
 * un HSL a caso produrrebbe un giallo su cui il bianco sparisce. Con L=42% il
 * contrasto col bianco resta sopra 4,5:1 su TUTTA la ruota, che è il punto di
 * fissarla invece di sceglierla per tinta.
 */
export function faviconPlaceholderColor(hue: number): string {
  return `hsl(${hue} 48% 42%)`;
}
