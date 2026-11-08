/**
 * Il contratto delle preferenze push per dispositivo — dichiarato UNA volta.
 *
 * `whenOpen` viaggia in tre punti diversi (la colonna `when_open`, il body di
 * `POST /api/push/devices/prefs`, il payload della push che arriva al service
 * worker) e in tutti e tre deve essere lo stesso insieme di valori. Due copie
 * del tipo, una per lato, sono il modo normale in cui un terzo valore compare
 * da una parte sola e nessuno se ne accorge finché non tace una notifica.
 */

/** Cosa fa un dispositivo QUANDO L'APP È APERTA E VISIBILE.
 *  · `native` — il banner lo mostra il service worker (notifica di sistema) e
 *    la pagina tace.
 *  · `in-app` — a finestra visibile il banner lo disegna la pagina e il sistema
 *    tace; ad app chiusa la notifica di sistema arriva comunque, perché è
 *    l'unica voce rimasta.
 *  In tutti e due i casi la voce è UNA. Cambia solo quale. */
export type PushWhenOpen = "native" | "in-app";

/** Il default: ad app aperta, al massimo la notifica nativa. */
export const DEFAULT_WHEN_OPEN: PushWhenOpen = "native";

/** Legge un `when_open` che arriva da fuori (riga di DB legacy, body HTTP).
 *  `null` = valore non riconosciuto, e il chiamante decide se è un 400 o un
 *  fallback: la funzione non sceglie per lui. */
export function parseWhenOpen(value: unknown): PushWhenOpen | null {
  return value === "native" || value === "in-app" ? value : null;
}
