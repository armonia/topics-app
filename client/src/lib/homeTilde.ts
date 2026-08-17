/**
 * `/Users/zorahrel/Projects/topics-app` → `~/Projects/topics-app`.
 *
 * Nel tooltip di un filtro il percorso è la riga che distingue due progetti
 * chiamati uguale, ma i primi 16 caratteri sono gli stessi per tutti e
 * mangiano lo spazio che serve alla parte che cambia.
 *
 * La home non si può leggere dal browser: arriva dal percorso di un progetto
 * qualsiasi, oppure si passa esplicitamente. Se non si sa, il percorso resta
 * intero — meglio lungo che sbagliato.
 */

/** Ricavata una volta dai path che passano di qui: `/Users/<tizio>` su macOS,
 *  `/home/<tizio>` su Linux. Non indovina altro: un `/opt/qualcosa` resta com'è. */
const HOME = /^(\/(?:Users|home)\/[^/]+)(?=\/|$)/;

export function homeTilde(path: string): string {
  if (!path) return path;
  const m = HOME.exec(path);
  if (!m) return path;
  // Esattamente la home, senza niente dentro: `~`, non `~/`.
  return path.length === m[1].length ? '~' : '~' + path.slice(m[1].length);
}
