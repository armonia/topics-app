/**
 * Quali WKWebView native sono MONTATE adesso.
 *
 * PERCHE' E' RIDOTTO A QUESTO. Prima qui viveva anche un roster persistito in
 * `localStorage`, con l'epoca del caricamento di pagina, e un "reaper" che al
 * boot chiudeva le webview rimaste da una pagina precedente. L'idea era chiudere
 * gli orfani del ⌘R. Era sbagliata in entrambe le metà, e le due cose insieme
 * facevano un danno preciso:
 *
 *  1. Chiudere una webview NON libera niente. In `wry-0.55.1`,
 *     `impl Drop for InnerWebView` chiama `self.webview.retain()` — incrementa
 *     il conteggio dei riferimenti mentre distrugge (workaround deliberato per
 *     un use-after-free, tauri-apps/wry#1733). Il processo WebContent resta vivo
 *     per sempre, quindi il reaper non recuperava un byte.
 *  2. `browser_open` e' IDEMPOTENTE su un label esistente — il commento in
 *     `lib.rs` dice testualmente "Create (or, if it already exists, reuse)".
 *     Dopo un ⌘R le pane si rimontano con lo stesso contextId e RIUSANO la
 *     webview di prima: senza nessuno che le chiuda in mezzo, un reload non
 *     costa un solo processo nuovo.
 *
 * Il reaper si infilava esattamente in quel mezzo: due secondi dopo il boot
 * vedeva l'epoca vecchia, chiudeva, e le pane rimontandosi ne creavano di nuove
 * — con i processi vecchi rimasti in giro per il punto 1. Risultato: ogni ⌘R
 * aggiungeva processi permanenti, e ricaricare due o tre volte mandava l'app in
 * sovraccarico. Prima che lo scrivessi, ricaricare era gratis.
 *
 * Resta solo il registro delle webview VIVE, che non e' persistito e serve a
 * `state/windowAwake.ts`: se questa pagina possiede webview figlie, allora
 * `document.hasFocus()` non e' un segnale affidabile (un click nella pagina
 * rende key la figlia), e i cicli dell'app non vanno spenti.
 */

/** Le pane browser MONTATE adesso. Non persistito: muore col caricamento. */
const liveViews = new Set<string>();

export function markBrowserViewLive(id: string): void {
  liveViews.add(id);
}
export function markBrowserViewDead(id: string): void {
  liveViews.delete(id);
}
export function liveBrowserViews(): ReadonlySet<string> {
  return liveViews;
}
