/**
 * Shared custom drag-image helper for the tiling surfaces.
 *
 * L'immagine trascinata è la COSA STESSA: il browser fotografa l'elemento
 * sorgente, che è già sullo schermo con la sua icona e i suoi segnali. Una
 * pillola ricostruita a mano — quella di prima, blu con il solo nome in bianco
 * — è una didascalia al posto della cosa, e per tutta la durata del gesto è
 * l'unica anteprima che si vede.
 *
 * Resta un ripiego per quando la sorgente non è fotografabile (fuori dal
 * viewport: WKWebView restituisce un'immagine VUOTA e macOS ripiega sull'icona
 * generica di documento). I nodi vivi del ripiego sono tracciati in un `Set`
 * così l'ospite che si smonta a metà drag può drenarli — è il `registry`.
 *
 * NOTE: PaneTabBar deliberately does NOT use this. Its tab chip must render
 * ON-screen at the cursor (WKWebView/Tauri returns an EMPTY image for anything
 * outside the visual viewport) and is styled as app chrome (elevated surface +
 * border + accent dot), left-anchored rather than centered. See its dragstart.
 */
import type React from 'react';

export interface DragGhostOptions {
  /** Text (may include a leading emoji) shown in the pill. */
  text: string;
  /** `sm` = compact (row reorder); `md` = roomier w/ flex gap (topic tile). */
  size?: 'sm' | 'md';
}

/**
 * Create the drag-image pill, register it as the event's `setDragImage`, and
 * schedule its removal next frame. The live node is added to `registry` and
 * removed again on cleanup so a host's unmount safety-net can drain it.
 */
export function spawnDragGhost(
  e: React.DragEvent,
  { text, size = 'sm' }: DragGhostOptions,
  registry: Set<HTMLElement>,
): void {
  if (!e.dataTransfer) return;

  // PRIMA STRADA: la cosa stessa.
  //
  // L'elemento sorgente è già dipinto sullo schermo con la sua icona, il suo
  // badge e il suo stato — cioè con tutto ciò che serve a riconoscerlo. Il
  // browser sa fotografarlo, e il risultato è la riga vera che segue il
  // cursore invece di una didascalia su fondo blu. L'ancoraggio è il punto in
  // cui l'hai presa, così non salta sotto il dito.
  //
  // Vincolo di WKWebView: l'elemento dev'essere DENTRO il viewport, o la
  // fotografia esce vuota e macOS ripiega sull'icona generica di documento.
  // Qui lo è per costruzione (ci hai appena premuto sopra), ma la guardia
  // resta esplicita perché è la ragione per cui il ripiego qui sotto esiste.
  const el = e.currentTarget as HTMLElement | null;
  const r = el?.getBoundingClientRect();
  const dentro = !!r && r.width > 0 && r.height > 0 &&
    r.bottom > 0 && r.right > 0 &&
    r.top < window.innerHeight && r.left < window.innerWidth;
  if (el && r && dentro) {
    e.dataTransfer.setDragImage(el, e.clientX - r.left, e.clientY - r.top);
    return;
  }

  // RIPIEGO: la pillola. Serve quando la sorgente non è fotografabile (fuori
  // dal viewport, o un elemento senza box). Meglio una didascalia che l'icona
  // di documento generica di macOS.
  const md = size === 'md';
  const ghost = document.createElement('div');
  ghost.style.cssText = `
    position:fixed;left:-9999px;top:-9999px;
    ${md ? 'display:flex;align-items:center;gap:6px;' : ''}
    padding:${md ? '6px 14px' : '4px 12px'};border-radius:${md ? 8 : 6}px;
    background:var(--bg-elevated);color:var(--text);
    border:1px solid var(--border);
    font:500 ${md ? 13 : 12}px/1 Inter,system-ui,sans-serif;
    box-shadow:0 ${md ? '4px 12px' : '2px 8px'} rgba(0,0,0,0.15);
    white-space:nowrap;pointer-events:none;
  `;
  ghost.textContent = text;
  document.body.appendChild(ghost);
  registry.add(ghost);
  e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, ghost.offsetHeight / 2);
  requestAnimationFrame(() => {
    ghost.remove();
    registry.delete(ghost);
  });
}
