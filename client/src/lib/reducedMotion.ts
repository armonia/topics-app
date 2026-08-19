/**
 * "Chi ha chiesto meno movimento", chiesto UNA VOLTA SOLA.
 *
 * PERCHE' ESISTE. `window.matchMedia(q)` non e' una lettura: e' una ALLOCAZIONE.
 * Ogni chiamata costruisce un `MediaQueryList` nuovo e lo aggancia al
 * `MediaQueryMatcher` del documento, che se lo tiene. Chiamarla dentro un
 * effetto senza array di dipendenze significa allocarne uno a ogni render, e la
 * sidebar di questa app ri-renderizza di continuo (un frame di stream, una fase
 * che cambia, una notifica).
 *
 * QUANTO COSTAVA. Misurato, non dedotto: sul WebContent principale tenuto fermo,
 * i `MediaQueryList` vivi vanno da 379 a 1.120 in 104 minuti. Sono +741, circa
 * sette al minuto, a schermo fermo. Nessuno li leggeva mai: erano il sottoprodotto
 * di una domanda fatta al posto sbagliato.
 *
 * COME. La query e' una COSTANTE, quindi la risposta puo' vivere quanto il
 * modulo. Si costruisce un solo `MediaQueryList` alla prima domanda e si
 * risponde sempre da quello: `.matches` resta vivo da solo, il browser lo
 * aggiorna quando la preferenza cambia. Una allocazione per sessione invece di
 * una per render.
 */

const QUERY = '(prefers-reduced-motion: reduce)';

/**
 * `undefined` = non ancora chiesto, `null` = ambiente senza `matchMedia`.
 * Due stati diversi: il secondo non va ritentato a ogni chiamata.
 */
let mq: MediaQueryList | null | undefined;

/**
 * Vero se chi usa l'app ha chiesto di ridurre il movimento.
 *
 * Sicura da chiamare in un ciclo caldo: dopo la prima volta e' la lettura di un
 * campo. Fuori dal browser (test in node, SSR) risponde `false`, che e' il ramo
 * "anima pure": chi non ha un sistema operativo non ha una preferenza da
 * rispettare.
 */
export function prefersReducedMotion(): boolean {
  if (mq === undefined) {
    mq =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(QUERY)
        : null;
  }
  return mq?.matches ?? false;
}

/** Solo per i test: dimentica il `MediaQueryList` memorizzato. */
export function resetReducedMotionCache(): void {
  mq = undefined;
}
