/**
 * `t()` già legato alla lingua scelta, per i componenti.
 *
 * Legge le impostazioni dal loro archivio locale e ascolta i cambi di lingua
 * fatti da un'altra finestra: cambiare lingua deve valere subito e ovunque, non
 * al prossimo ricarico — è la cosa che rende un selettore di lingua credibile.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { loadSettings } from '../lib/settings';
import { t as translate, resolveLocale, ensureLocaleLoaded, loadedLocales, subscribeCatalogues, FALLBACK_LOCALE, type Locale } from '../lib/i18n';

function currentLocale(): Locale {
  try {
    return resolveLocale(loadSettings().language, typeof navigator !== 'undefined' ? navigator.language : undefined);
  } catch {
    return resolveLocale(undefined, undefined);
  }
}

export function useLocale(): Locale {
  const [locale, setLocale] = useState<Locale>(currentLocale);
  useEffect(() => {
    // Senza un posto a cui iscriversi non ci si iscrive, e non è un caso
    // teorico: i banchi unitari dei componenti montano React senza DOM, e
    // `currentLocale()` sopra è già scritto per reggerlo (ripiega su italiano).
    // Prima questa riga esplodeva, e la lingua trasformava OGNI componente che
    // la usa in un componente non testabile senza una finta finestra.
    //
    // Si guarda il METODO e non l'oggetto perché i due casi sono distinti e li
    // ho pagati entrambi: `window` assente (banco senza DOM) e `window` finto
    // ma spoglio, installato da un ALTRO file di test dello stesso processo.
    // Il secondo passa un controllo su `typeof window` e poi esplode lo stesso.
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    // `storage` scatta solo per le ALTRE finestre; per la propria c'è l'evento
    // interno che `settings.ts` già emette quando si salva.
    const sync = () => setLocale(currentLocale());
    window.addEventListener('storage', sync);
    window.addEventListener('app-settings-changed', sync as EventListener);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener('app-settings-changed', sync as EventListener);
    };
  }, []);
  return locale;
}

export function useT(): (key: string, vars?: Record<string, string | number>) => string {
  const wanted = useLocale();
  // La lingua CHIESTA e quella ATTIVA sono due cose diverse da quando il
  // catalogo inglese sta in un chunk suo (vedi `lib/i18n-en.ts`): fra la scelta
  // e l'arrivo del dizionario passa una rete, e finche' non arriva l'unica cosa
  // che l'app sa disegnare e' l'italiano — lo stesso stato in cui era gia' per
  // una chiave che l'inglese non ha.
  const loaded = useSyncExternalStore(subscribeCatalogues, loadedLocales, loadedLocales);
  const active: Locale = loaded.includes(wanted) ? wanted : FALLBACK_LOCALE;
  useEffect(() => { void ensureLocaleLoaded(wanted); }, [wanted]);
  return useCallback(
    (key: string, vars?: Record<string, string | number>) => translate(key, active, vars),
    [active],
  );
}
