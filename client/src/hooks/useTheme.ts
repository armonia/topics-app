import { useEffect, useCallback } from 'react';
import type { ThemeMode, WSMessage } from '../types';
import { useServerState } from './useServerState';
import { isTauri } from '../lib/shell';
import { tauriInvoke } from '../lib/shell/tauri';
import { mediaQuery, mediaQueryMatches } from '../lib/mediaQuery';

/** The one query that decides what 'system' means. */
const DARK_QUERY = '(prefers-color-scheme: dark)';

/** I motivi di fallimento di `set_theme` già segnalati, per non ripetere lo
 *  stesso avviso a ogni cambio di tema. Modulo-scope: il guscio è uno per
 *  documento, non per componente. */
const setThemeWarned = new Set<string>();

function getEffectiveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') {
    return mediaQueryMatches(DARK_QUERY) ? 'dark' : 'light';
  }
  return mode;
}

/**
 * Riallinea `<meta name="theme-color">` — la tinta che Android/Chrome danno
 * alla barra di sistema attorno alla PWA — al tema RISOLTO.
 *
 * Prima lo scriveva solo `public/boot.js`, UNA volta prima del primo paint:
 * cambiare tema dalle impostazioni, o passare a scuro di sistema con l'app già
 * aperta, lasciava la fascia di sistema al tema VECCHIO fino a un ricaricamento.
 *
 * Il token è `--chrome-bg`, NON `--bg`: questa è la tinta della fascia di
 * SISTEMA attorno alla PWA, cioè il bordo dell'app — e il bordo dell'app è
 * chrome, come la sidebar e come la striscia della safe-area. Con `--bg` la
 * fascia usciva più CHIARA della colonna che le sta attaccata.
 *
 * Il valore si LEGGE dal token invece di essere ricopiato a mano: gli hex di
 * `--bg` erano scritti in quattro posti (index.html, boot.js, manifest.json,
 * index.css) e restavano allineati solo per disciplina. Qui la fonte è una.
 * Sulla shell desktop non si tocca: lì `--bg` è translucido (vibrancy) e la
 * barra di sistema non esiste.
 */
function syncThemeColorMeta(): void {
  if (document.documentElement.classList.contains('electron-mac')) return;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const value = getComputedStyle(document.documentElement).getPropertyValue('--chrome-bg').trim();
  // Un token con alpha (`hsl(… / .5)`) non è un colore valido per theme-color:
  // meglio lasciare quello che c'è che scriverne uno che il browser scarta.
  if (!value || value.includes('/')) return;
  meta.setAttribute('content', value);
}

export function useTheme(onMessage?: (handler: (msg: WSMessage) => void) => () => void) {
  const [themeMode, setThemeMode] = useServerState<ThemeMode>('theme', 'system', {
    localStorageKey: 'theme',
    debounceMs: 300,
    onMessage,
  });
  // (Qui c'era anche uno stato `effectiveTheme`, tenuto in sincrono a mano e
  // restituito dall'hook. Nessuno lo leggeva — zero call-site in tutto il
  // client — quindi era una seconda copia della verità che poteva solo divergere
  // da quella vera, che è la classe `.dark` sul documentElement. Toglierlo si
  // porta via anche il `setState` dentro l'effetto, e con esso la sua deroga
  // lint.)

  useEffect(() => {
    const effective = getEffectiveTheme(themeMode);
    document.documentElement.classList.toggle('dark', effective === 'dark');
    syncThemeColorMeta();
    // Tauri native chrome: set the NSWindow appearance so the traffic lights and
    // the per-region vibrancy material re-tint to match light/dark (set_theme in
    // src-tauri/src/lib.rs). No-op off macOS / on web.
    //
    // Si passa `themeMode`, LA MODALITÀ, non `effective`. Passare il tema
    // risolto chiudeva un anello: la WKWebView eredita l'effectiveAppearance
    // dalla finestra, quindi appena il Rust pinna Aqua/DarkAqua la riga qui
    // sopra — `matchMedia('(prefers-color-scheme: dark)')` — smette di leggere
    // l'OS e legge il valore che ci siamo scritti da soli. Con «Sistema» il
    // risultato era che il tema non seguiva mai il Mac: restava dov'era, e
    // «funzionava» solo dopo essere passati da «Scuro» — cioè dopo aver messo
    // noi il valore che poi rileggevamo. Con la modalità, "system" diventa in
    // Rust `setAppearance: nil` e la finestra torna a ereditare.
    //
    // Niente `await` e nessuna ri-risoluzione dopo: `set_theme` non ritorna
    // niente e dispaccia sul main thread, quindi la command torna PRIMA che
    // `setAppearance:` sia stato eseguito — un `getEffectiveTheme` messo dopo
    // leggerebbe ancora il valore vecchio. A rimettere le cose a posto è il
    // listener sotto: quando l'appearance flippa davvero, la media query emette
    // `change` e classe e meta si riallineano lì.
    if (isTauri) {
      // L'ERRORE NON SI INGHIOTTE. Era `.catch(() => {})`, e questa è l'UNICA
      // via con cui il tema arriva al guscio nativo: se la command non c'è
      // (binario più vecchio del client — accade a ogni ship che non ricostruisce
      // l'app), o se il bridge risponde male, la finestra resta pinnata al tema
      // di prima e dal lato web non se ne accorge nessuno. È esattamente il caso
      // in cui «Sistema» sembra non funzionare: il client ha fatto il suo, il
      // guscio no, e non c'era una riga da nessuna parte a dirlo.
      // Una volta sola per motivo: questo effetto gira a ogni cambio di tema, e
      // un guscio vecchio fallirebbe sempre — un avviso per clic sarebbe rumore.
      void tauriInvoke('set_theme', { theme: themeMode }).catch((err: unknown) => {
        const key = String(err);
        if (setThemeWarned.has(key)) return;
        setThemeWarned.add(key);
        console.warn('[theme] il guscio nativo non ha accettato il tema; la finestra resta come era:', err);
      });
    }
  }, [themeMode]);

  // Listen for system theme changes
  useEffect(() => {
    if (themeMode !== 'system') return;

    const mq = mediaQuery(DARK_QUERY);
    if (!mq) return;
    // È QUESTO il pezzo che fa funzionare «Sistema» sotto la shell desktop.
    // La WKWebView eredita l'effectiveAppearance dalla finestra: appena il Rust
    // toglie l'override (`setAppearance: nil`) e la finestra torna a ereditare
    // da NSApp, la media query emette `change` e da qui riallineiamo classe e
    // meta. Nessuna attesa, nessun polling: l'evento arriva quando il valore è
    // davvero cambiato.
    const handler = () => {
      const effective = getEffectiveTheme('system');
      document.documentElement.classList.toggle('dark', effective === 'dark');
      syncThemeColorMeta();
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [themeMode]);

  const toggleTheme = useCallback(() => {
    setThemeMode(prev => {
      if (prev === 'light') return 'dark';
      if (prev === 'dark') return 'system';
      return 'light';
    });
  }, [setThemeMode]);

  const setTheme = useCallback((mode: ThemeMode) => {
    setThemeMode(mode);
  }, [setThemeMode]);

  return { themeMode, toggleTheme, setTheme };
}
