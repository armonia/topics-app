import { liveBrowserViews } from '../lib/shell/nativeBrowserRoster';

/**
 * "C'è qualcuno che sta guardando questa finestra?"
 *
 * `document.hidden` NON è quella domanda. Con l'app semplicemente DIETRO a
 * un'altra — la finestra ancora sullo schermo, solo non a fuoco — `hidden` è
 * falso, e WebKit continua a servire rAF, timer e observer a piena cadenza per
 * un'immagine che nessuno legge. Nel profilo `sample` del 2026-07-28 quel
 * lavoro c'era tutto: 22% del main thread occupato con l'app in secondo piano,
 * di cui il 12% dentro `updateRendering`.
 *
 * È lo stesso predicato che `useAnimationPause` usa per parcheggiare le
 * animazioni CSS, e sta qui perché i due devono restare in passo: se le
 * animazioni si fermano e i poll no, si è solo spostato il costo.
 */

/** Il predicato, sincrono. Usabile anche fuori da React. */
export function isWindowAwake(): boolean {
  if (typeof document === 'undefined') return true;
  if (document.hidden) return false;
  // Fail OPEN se l'API non c'è (embedder vecchi, doppioni nei test): un poll che
  // smette di girare in silenzio è peggio di uno che gira di troppo.
  if (typeof document.hasFocus !== 'function') return true;
  if (document.hasFocus()) return true;
  // `hasFocus()` FALSO non vuol dire "nessuno guarda" quando esistono WKWebView
  // FIGLIE: un click dentro una pane browser nativa rende key la figlia, e il
  // documento ospite legge false ESATTAMENTE mentre l'utente sta usando l'app.
  // Il caso è già documentato in `hooks/useTauriBrowser.ts` (~riga 93), dove per
  // questo i poll restano gated su `visibilityState` e non sul fuoco.
  //
  // È anche la spiegazione del "terminale che lagga": la cadenza di scrittura di
  // xterm scende a 4 Hz quando l'app risulta in secondo piano, e con sei
  // progetti che ospitano pane browser bastava un click nella pagina per
  // buttarci dentro TUTTI i terminali visibili.
  //
  // Quindi: se questa pagina possiede webview figlie vive, il fuoco del
  // documento non è un segnale, e si fallisce aperto — coerente con la riga
  // sopra. Senza figlie (web, o desktop senza pane browser) resta il gate
  // stretto di prima, che è quello che spegne i cicli con l'app in background.
  return liveBrowserViews().size > 0;
}

// Qui c'era anche uno store `useSyncExternalStore` (`useWindowAwake`) che
// ri-renderizzava il chiamante al cambio di fuoco, con un set di listener
// globali refcontato. L'unico chiamante era `usePaneWatched`, che a sua volta
// non ne ha mai avuto nessuno: erano listener registrati per zero componenti.
// Chi deve REAGIRE al fuoco ascolta gli eventi dove serve (`signals.ts` lo fa
// dentro il suo effetto, ed è l'unico caso); chi deve solo decidere se un ciclo
// gira chiama il predicato sincrono qui sopra DENTRO il timer — spegnere un
// `setInterval` non richiede un render.
