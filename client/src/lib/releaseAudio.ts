/**
 * Rilascia davvero un elemento audio.
 *
 * `pause()` NON basta, ed è il bug che questa funzione esiste per chiudere. Un
 * `HTMLMediaElement` con una sorgente caricata resta agganciato al proprio
 * renderer audio anche in pausa: in WebKit quello è un
 * `RemoteAudioDestinationProxy render thread` vivo dentro il processo
 * WebContent, che gira a cadenza fissa (~344 quantum al secondo) a prescindere
 * dal fatto che stia suonando qualcosa. Ogni frase pronunciata creava un
 * `new Audio(...)` e si limitava a mettere in pausa il precedente, quindi ogni
 * sintesi vocale lasciava dietro un thread.
 *
 * Misurato sull'app viva il 2026-07-29: CINQUE render thread audio in un solo
 * processo, che da solo bruciava il 54% di una CPU, più il processo GPU al 37%
 * al suo seguito. L'app era ferma e nessuno stava ascoltando niente.
 *
 * La sequenza che libera per davvero è pause → togli la sorgente → `load()`: è
 * `load()` a smontare il media player. Solo dopo ha senso revocare il blob,
 * altrimenti si revoca un URL che l'elemento sta ancora tenendo.
 */
export function releaseAudio(el: HTMLAudioElement | null): void {
  if (!el) return;
  try {
    const src = el.src;
    el.pause();
    el.onended = null;
    el.onerror = null;
    el.removeAttribute('src');
    // Obbligatorio: senza `load()` l'elemento resta associato al renderer.
    el.load();
    if (src && src.startsWith('blob:')) URL.revokeObjectURL(src);
  } catch {
    /* un rilascio non deve mai far fallire il chiamante */
  }
}
