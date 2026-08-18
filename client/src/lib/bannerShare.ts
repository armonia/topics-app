/**
 * IL MARKDOWN DEL BANNER, e la domanda che il bottone deve porsi prima di
 * copiarlo: questo indirizzo lo raggiunge qualcuno che non è me?
 *
 * Il banner (`/api/profile/banner.svg`) lo serve il processo locale. Copiare
 * `![Topics](http://localhost:13333/…)` dentro un README su GitHub produce
 * un'immagine rotta per chiunque — e anche per chi l'ha copiato, appena apre
 * quel README da un altro computer. Il difetto si scopre solo DOPO aver
 * incollato, che è il momento peggiore.
 *
 * Non si risolve inventando un dominio: finché il banner esce da una macchina
 * personale, nessuna stringa lo rende raggiungibile. Si risolve dicendolo.
 */

/** L'origine è raggiungibile da fuori? */
function pubblica(origin: string): boolean {
  let host: string;
  try { host = new URL(origin).hostname; } catch { return false; }
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  // `.local` è mDNS: vive dentro una rete e non esce.
  if (host.endsWith('.local')) return false;
  // Loopback, e i tre blocchi privati di RFC 1918.
  if (/^127\./.test(host) || host === '::1' || host === '0.0.0.0') return false;
  if (/^10\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  // Un host senza punti non è un nome di dominio: è una macchina in rete.
  return host.includes('.');
}

export interface BannerShare {
  /** Il markdown da incollare. C'è sempre: chi ha un tunnel lo adatta. */
  testo: string;
  /** L'indirizzo lo raggiunge qualcun altro. */
  condivisibile: boolean;
  /** Perché non lo è, da mostrare accanto al gesto. `null` quando lo è. */
  avviso: string | null;
}

export function bannerMarkdown(origin: string, nome: string | null): BannerShare {
  const query = nome ? `?name=${encodeURIComponent(nome)}` : '';
  const url = `${origin}/api/profile/banner.svg${query}`;
  const ok = pubblica(origin);
  return {
    testo: `![Topics](${url})`,
    condivisibile: ok,
    avviso: ok
      ? null
      // La frase dice il fatto e la via d'uscita, non solo il divieto: chi ha
      // un tunnel o un reverse proxy sostituisce l'indirizzo e il markdown
      // funziona com'è.
      : 'Questo indirizzo lo raggiunge solo questo computer: su GitHub l\'immagine resterebbe rotta. Sostituisci l\'indirizzo con quello pubblico da cui servi Topics.',
  };
}
