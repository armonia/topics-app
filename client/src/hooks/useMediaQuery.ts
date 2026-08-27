import { useEffect, useState } from 'react';
import { mediaQuery } from '../lib/mediaQuery';

/**
 * Una media query come VALORE React, per le decisioni che cambiano l'ALBERO e
 * non solo la classe.
 *
 * `useMobile` risponde «che dispositivo è»; questo risponde «questa regola CSS
 * vale adesso», ed è ciò che serve quando la larghezza decide se un pezzo di
 * UI esiste. Una classe `xl:hidden` non basta in quel caso: l'elemento resta
 * montato — con il suo stato, i suoi effetti e le sue sottoscrizioni — e sparisce
 * solo alla vista.
 *
 * Lo stato iniziale si legge in `useState(() => …)`, cioè PRIMA della pittura:
 * partire da `false` e correggere in effetto darebbe un frame con il layout
 * sbagliato (e, per un albero condizionale, un mount+unmount inutile).
 *
 * `addListener` è il ramo per i WebKit < 14, dove `addEventListener` sulla
 * MediaQueryList non esiste: senza, il listener non si aggancia affatto invece
 * di degradare.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => mediaQuery(query)?.matches ?? false);

  useEffect(() => {
    const mq = mediaQuery(query);
    if (!mq) return;
    const onChange = () => setMatches(mq.matches);
    onChange();
    if (mq.addEventListener) {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, [query]);

  return matches;
}
