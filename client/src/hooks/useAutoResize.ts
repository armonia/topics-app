import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * Una textarea che cresce col testo, fino a un tetto.
 *
 * Il gesto è sempre lo stesso: azzerare l'altezza e rimisurare. Senza il primo
 * passo `scrollHeight` non scende mai — resta il massimo storico — e la casella
 * cresce cancellando testo invece di rimpicciolirsi.
 *
 * `useLayoutEffect` e non `useEffect`: la misura va scritta prima che il
 * browser dipinga, altrimenti a ogni carattere che manda a capo si vede un
 * fotogramma con l'altezza vecchia.
 *
 * Il tetto serve perché sopra una certa altezza la casella smette di essere un
 * campo e diventa un pannello: oltre, scorre.
 */
export function useAutoResize(value: string, maxPx = 160) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const resize = useCallback(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = 'auto';
    // `scrollHeight` è contenuto + padding, e NON comprende i bordi. L'altezza
    // che scriviamo invece viene letta come border-box, perché il reset di
    // Tailwind mette `box-sizing: border-box` su tutto: assegnarla nuda
    // lascerebbe la casella due pixel più bassa del suo contenuto, e a ogni
    // misura comparirebbe una barra per quei due pixel. La differenza fra
    // altezza esterna e interna, misurata ora che l'altezza è `auto`, è
    // esattamente quanto manca.
    const bordi = ta.offsetHeight - ta.clientHeight;
    const voluta = ta.scrollHeight + bordi;
    ta.style.height = Math.min(voluta, maxPx) + 'px';
    // Sotto il tetto non deve esserci barra: l'altezza contiene già tutto.
    ta.style.overflowY = voluta > maxPx ? 'auto' : 'hidden';
  }, [maxPx]);

  useLayoutEffect(() => { resize(); }, [value, resize]);

  return { ref, resize };
}
