import { useEffect } from 'react';
import { isTauri } from '../lib/shell';
import { tauriInvoke } from '../lib/shell/tauri';
import {
  PAGE_EPOCH,
  decideOrphans,
  forgetBrowserView,
  liveBrowserViews,
  readRoster,
} from '../lib/shell/nativeBrowserRoster';

/**
 * Ritardo prima della prima passata. Non è una scaramanzia: al boot le pane si
 * montano in modo asincrono, e una webview che una pane sta per riprendere in
 * carico verrebbe chiusa e riaperta (pagina ricaricata, nessun danno ma un
 * lampo inutile). Due secondi bastano perché ogni pane visibile abbia scritto
 * la sua voce con l'epoca corrente.
 */
const FIRST_SWEEP_MS = 2000;

/**
 * Ogni quanto ripassare. Serve per gli orfani che nascono DOPO il boot — una
 * chiusura persa perché il timer di grazia non è mai scattato (la pagina è
 * andata via prima), o un `browser_close` fallito.
 */
const SWEEP_EVERY_MS = 30_000;

/**
 * Chiude le WKWebView native che nessuno possiede più.
 *
 * Va montato UNA volta, in `App`. Vedi `lib/shell/nativeBrowserRoster.ts` per
 * il perché esistono orfani e per la regola (epoca del caricamento di pagina).
 *
 * Fuori da Tauri non fa assolutamente nulla: nel browser web le pane non hanno
 * webview native e il roster resta vuoto.
 */
export function useNativeBrowserReaper(): void {
  useEffect(() => {
    if (!isTauri) return;

    let stopped = false;

    const sweep = async (): Promise<void> => {
      if (stopped) return;
      const orphans = decideOrphans(readRoster(), PAGE_EPOCH, liveBrowserViews());
      if (orphans.length === 0) return;
      // `browser_close` su un id senza webview è un no-op documentato
      // (`browser_close_inner`: `if let Some(wv) = …`), quindi una voce stantìa
      // nel roster costa una IPC e niente di più.
      for (const id of orphans) {
        try {
          await tauriInvoke('browser_close', { id });
        } catch {
          /* la webview era già sparita: l'esito che volevamo comunque */
        }
        forgetBrowserView(id);
      }
      console.info(`[browser-reaper] chiuse ${orphans.length} webview orfane`);
    };

    const first = setTimeout(() => { void sweep(); }, FIRST_SWEEP_MS);
    const iv = setInterval(() => {
      // Con la finestra nascosta non c'è fretta: la passata successiva la trova
      // comunque, e non svegliamo il renderer per niente.
      if (document.visibilityState === 'visible') void sweep();
    }, SWEEP_EVERY_MS);

    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(iv);
    };
  }, []);
}
