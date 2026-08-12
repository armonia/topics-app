import { DND_TYPES } from './dndTypes';

/**
 * IL GESTO CHE SPARIVA DENTRO UNA PANE.
 *
 * Una pane browser framabile rende un `<iframe>` vero. Durante un drag HTML5 il
 * browser consegna gli eventi al documento DELL'IFRAME: il `dragover` della
 * pane sotto non parte mai, l'anteprima di fusione non si dipinge e il rilascio
 * cade nel vuoto. Da qui la cosa che si vede: trascino un browser sopra un
 * terminale e i due si raggruppano, trascino un browser sopra un ALTRO BROWSER
 * e non succede niente — cioè proprio il gesto da cui uno si aspetta di creare
 * un gruppo di tab, e la ragione per cui il gruppo sembra non esistere.
 *
 * La cura è quella classica e minima: mentre una TAB è in volo, gli iframe
 * diventano trasparenti ai puntatori (`index.css`, regola su
 * `[data-pane-drag] iframe`). L'hit test torna così al div del gruppo, che è
 * già un bersaglio di drop funzionante — è lo stesso identico percorso che
 * rende vivo il drop sopra un terminale.
 *
 * Perché un attributo sul documento e non uno stato React: mid-drag il
 * `dragover` scatta a ~60fps e ogni ri-render dell'albero delle pane si paga
 * sul frame del gesto. Qui si tocca UN attributo, e la regola CSS fa il resto
 * senza far ri-renderizzare niente.
 *
 * NB — la webview NATIVA del guscio Tauri non è un iframe: composita sopra il
 * DOM e nessuna regola CSS la scavalca. Lì il gesto resta da coprire a parte
 * (la strada battuta è quella dei menu: congelare la pane in un fermo immagine
 * per la durata dell'overlay, vedi `lib/shell/browserOcclusion`).
 */
export const PANE_DRAG_ATTR = 'data-pane-drag';

/** True quando questi `types` sono il trascinamento di una TAB (non un file
 *  dal Finder, non una riga della sidebar: quelli non atterrano MAI dentro il
 *  corpo di una pane, quindi non c'è motivo di bucare gli iframe per loro).
 *
 *  Esportata perché è LA decisione di questo modulo — quali gesti bucano gli
 *  iframe e quali no — e una decisione si prova senza montare un documento. */
export function isPaneTabDrag(types: readonly string[] | undefined): boolean {
  if (!types) return false;
  return types.includes(DND_TYPES.PANE_TAB) && types.includes(DND_TYPES.PANE_TAB_GROUP);
}

function accendi(): void {
  document.documentElement.setAttribute(PANE_DRAG_ATTR, '');
}

function spegni(): void {
  document.documentElement.removeAttribute(PANE_DRAG_ATTR);
}

/**
 * Aggancia il segnale al documento. Idempotente: chiamarla due volte non
 * registra due volte gli ascoltatori.
 *
 * Lo spegnimento ha tre porte perché `dragend`/`drop` non sono garantiti: nella
 * WKWebView si perdono quando il rilascio cade sopra una vista nativa, e un
 * flag rimasto acceso lascerebbe gli iframe insensibili al mouse — cioè un
 * browser che non si può più cliccare. Il `pointermove` senza bottone premuto è
 * la prova che il gesto è finito comunque (durante un drag HTML5 gli eventi di
 * puntatore sono soppressi), ed è la stessa cintura che usano già PanelGrid e
 * GroupLayout per le loro strisce di drop.
 */
let agganciato = false;
export function installPaneDragFlag(): void {
  if (agganciato) return;
  agganciato = true;
  // Fase di BOLLA, non di cattura: in cattura il listener del documento gira
  // PRIMA del gestore della tab, cioè prima che la `setData` abbia scritto i
  // tipi — e il drag non risulterebbe MAI quello di una tab. (Misurato: zero
  // accensioni.) React aggancia i suoi gestori alla radice, che sta sotto il
  // documento, quindi in bolla i dati ci sono già.
  document.addEventListener('dragstart', (e) => {
    if (isPaneTabDrag(e.dataTransfer?.types)) accendi();
  });
  document.addEventListener('dragend', spegni, true);
  document.addEventListener('drop', spegni, true);
  window.addEventListener('blur', spegni);
  window.addEventListener('pointerup', spegni, true);
  window.addEventListener('pointermove', (e) => {
    if ((e.buttons & 1) === 0) spegni();
  }, true);
}
