/**
 * Il tasto destro DENTRO una pane browser nativa.
 *
 * Il click non arriva a React e non può arrivarci: la WKWebView figlia è un'altra
 * vista, con un altro processo di contenuto, e composita SOPRA il DOM dell'app.
 * Quindi il gesto lo raccoglie la pagina e il client lo va a prendere, con lo
 * stesso schema già usato due volte da questa pane: il proxy della console
 * (`window.__topicsConsole`, iniettato dal Rust e svuotato dal poll di stato) e
 * il contatore dei click (`window.__topicsFocusBump`). Uno script idempotente
 * scrive in un buffer, il poll lo drena.
 *
 * L'installazione la fa il poll VELOCE (120ms, vedi useTauriBrowser): è la stessa
 * cadenza con cui il menu deve comparire, ed essendo dentro un eval che gira
 * sempre si reinstalla da sé dopo ogni navigazione, che rimpiazza il documento e
 * con lui la guardia. Un menu che arriva 800ms dopo il click destro non è un
 * menu, quindi il poll di stato (800ms) non è il posto giusto.
 *
 * IL PUNTO DEL PEZZO E' L'OCCLUSIONE. Una vista nativa composita sopra il DOM,
 * quindi un menu HTML normale finirebbe SOTTO e sarebbe invisibile. Il menu si
 * disegna con `ContextMenuPortal`, che porta `role="menu"` e `.glass-surface`:
 * sono i due marcatori di `OVERLAY_SELECTOR` (lib/shell/browserOcclusion), e
 * sono ciò che fa congelare la pane in un fermo-immagine e parcheggiare la vista
 * viva. Senza quei marcatori il menu esiste e non si vede.
 */

import type { PaneContextTarget } from './browserDevTypes';

/**
 * Lo script iniettato in pagina, idempotente come `INSTALL_FOCUS_HOOK`.
 *
 * `preventDefault()` in CATTURA è obbligatorio, non un dettaglio: senza, WebKit
 * disegna anche il SUO menu nativo, che essendo una vista di sistema finisce
 * sopra il nostro. Effetto collaterale accettato e voluto: una pagina con un
 * menu contestuale suo non lo mostra più dentro questa pane, esattamente come
 * accade in un browser che ospita la pagina in una vista che si è presa il
 * gesto.
 *
 * `selection` è TAGLIATA a 200 caratteri e non serve a copiare: serve solo a
 * decidere se la voce «Copia» esiste. Il testo vero lo rilegge `readSelection()`
 * al click, perché una selezione può essere lunga quanto la pagina e troncare in
 * silenzio quello che l'utente copia sarebbe una bugia.
 *
 * `seq` cresce a ogni click: due click destri sullo stesso punto sono due menu,
 * e senza un contatore il secondo non si distinguerebbe dal primo.
 */
export const PANE_CONTEXT_HOOK_JS =
  "if(!window.__topicsCtxHook1){window.__topicsCtxHook1=1;window.__topicsCtx=null;window.__topicsCtxSeq=0;" +
  "addEventListener('contextmenu',function(e){try{" +
  "e.preventDefault();" +
  "var n=e.target,el=n&&n.nodeType===1?n:(n&&n.parentElement)||null;" +
  "var a=el&&el.closest?el.closest('a[href]'):null;" +
  "var im=el&&el.closest?el.closest('img'):null;" +
  // Su un <a> SVG `href` non è una stringa ma un SVGAnimatedString: senza questo
  // ramo la voce «Copia link» copiava «[object SVGAnimatedString]».
  "var href=a?(typeof a.href==='string'?a.href:((a.href&&a.href.baseVal)||'')):'';" +
  "var src=im?(im.currentSrc||im.src||''):'';" +
  "var sel='';try{var s=getSelection();sel=s?String(s):''}catch(e2){}" +
  "window.__topicsCtxSeq++;" +
  "window.__topicsCtx={x:Math.round(e.clientX),y:Math.round(e.clientY)," +
  "selection:sel.slice(0,200),linkUrl:href,imageUrl:src,seq:window.__topicsCtxSeq};" +
  "}catch(err){}},true);}";

/** L'espressione che DRENA il buffer, da incastonare nel payload del poll
 *  veloce. Legge e azzera nello stesso giro: una richiesta consegnata due volte
 *  riaprirebbe il menu che l'utente ha appena chiuso. */
export const PANE_CONTEXT_TAKE_EXPR =
  "(function(){var m=window.__topicsCtx||null;if(m)window.__topicsCtx=null;return m})()";

/** Legge una selezione dalla pagina, per la voce «Copia»: il testo INTERO, non i
 *  200 caratteri del buffer. */
export const PANE_SELECTION_JS =
  "(function(){try{var s=getSelection();return s?String(s):''}catch(e){return ''}})()";

/** La richiesta come arriva dalla PAGINA: `x`/`y` sono coordinate del viewport
 *  della pagina, non della finestra dell'app. Le converte `paneToHostPoint`. */
export interface PaneContextRequest {
  x: number;
  y: number;
  /** Primi 200 caratteri della selezione. Serve a DECIDERE, non a copiare. */
  selection: string;
  linkUrl: string;
  imageUrl: string;
  seq: number;
}

/**
 * Valida una richiesta drenata dal poll. Ritorna null per qualunque cosa non sia
 * utilizzabile, così il chiamante ha UN solo caso vuoto: un buffer che non c'è
 * (documento appena sostituito, hook non ancora installato) e uno malformato si
 * trattano allo stesso modo, cioè non aprendo niente.
 */
export function parsePaneContextRequest(value: unknown): PaneContextRequest | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const x = num(v.x);
  const y = num(v.y);
  if (x === null || y === null) return null;
  const str = (s: unknown): string => (typeof s === 'string' ? s : '');
  const seq = num(v.seq);
  return {
    x,
    y,
    selection: str(v.selection),
    linkUrl: str(v.linkUrl),
    imageUrl: str(v.imageUrl),
    // Senza `seq` il menu si apre comunque: la richiesta è buona, è solo un
    // guscio più vecchio. 0 vale come «non lo so», e React ne fa una chiave.
    seq: seq === null ? 0 : seq,
  };
}

/**
 * Dal punto della PAGINA al punto della FINESTRA, che è dove vive il menu.
 *
 * Tre trasformazioni, tutte necessarie:
 *  · l'origine dello slot, perché la vista nativa sta dentro una cella del
 *    layout e `clientX/Y` sono relativi al viewport della pagina;
 *  · lo zoom, perché è `documentElement.style.zoom` (vedi zoomScale): a 200% un
 *    punto a 100px della pagina cade a 200px sullo schermo;
 *  · il letterbox dell'emulazione dispositivo, con la stessa aritmetica di
 *    `applyBounds` in useTauriBrowser: in mobile/tablet la vista è centrata
 *    dentro lo slot, non lo riempie.
 *
 * `slot` null (pane non ancora nel DOM) consegna il punto grezzo: il menu può
 * comparire spostato, ma `ContextMenuPortal` lo riporta dentro la finestra e
 * resta usabile. Meglio di non aprirlo.
 */
export function paneToHostPoint(
  req: PaneContextRequest,
  slot: { x: number; y: number; width: number; height: number } | null,
  opts?: { zoomPercent?: number; deviceDims?: { width: number; height: number } | null },
): PaneContextTarget {
  const zoomPercent = opts?.zoomPercent;
  const scale = typeof zoomPercent === 'number' && zoomPercent > 0 ? zoomPercent / 100 : 1;
  const px = req.x * scale;
  const py = req.y * scale;
  const base = {
    selection: req.selection,
    linkUrl: req.linkUrl,
    imageUrl: req.imageUrl,
    seq: req.seq,
  };
  if (!slot) return { ...base, x: Math.round(px), y: Math.round(py) };
  const dims = opts?.deviceDims ?? null;
  let originX = slot.x;
  let originY = slot.y;
  if (dims) {
    const w = Math.min(dims.width, slot.width);
    const h = Math.min(dims.height, slot.height);
    originX = slot.x + (slot.width - w) / 2;
    originY = slot.y + (slot.height - h) / 2;
  }
  return { ...base, x: Math.round(originX + px), y: Math.round(originY + py) };
}

/** Le voci del menu, in ordine di disegno. */
export type PaneMenuItemKey =
  | 'back'
  | 'forward'
  | 'reload'
  | 'copy'
  | 'copyLink'
  | 'openLink'
  | 'copyImage'
  | 'copyImageAddress'
  | 'inspect';

/**
 * QUALI voci ha senso mostrare su questo bersaglio.
 *
 * Pura perché è la sola cosa di questo pezzo che può sbagliare senza rumore: una
 * voce «Copia link» su un punto qualunque della pagina è un bottone che non fa
 * niente, e una voce «Copia» senza selezione svuota la clipboard invece di
 * riempirla. Le tre di navigazione ci sono sempre (indietro e avanti si
 * DISABILITANO quando la cronologia è finita, non spariscono: una voce che va e
 * viene sposta le altre sotto il cursore).
 */
export function paneContextItems(target: {
  selection: string;
  linkUrl: string;
  imageUrl: string;
}): PaneMenuItemKey[] {
  const items: PaneMenuItemKey[] = ['back', 'forward', 'reload'];
  if (target.selection.trim()) items.push('copy');
  if (target.linkUrl) items.push('copyLink', 'openLink');
  if (target.imageUrl) items.push('copyImage', 'copyImageAddress');
  items.push('inspect');
  return items;
}

/**
 * Lo script che estrae i BYTE di un'immagine, dentro la pagina.
 *
 * Perché dentro e non con un `fetch` dal documento dell'app: l'app sta su
 * un'altra origine, quindi una richiesta all'immagine è cross-origin e la
 * risposta non è leggibile. Dentro la pagina l'origine è la sua, e per le
 * immagini di terzi c'è `crossOrigin='anonymous'`, che funziona quando il server
 * manda CORS e fallisce PULITAMENTE quando non lo manda (il canvas resterebbe
 * contaminato e `toDataURL` lancerebbe).
 *
 * Il risultato non torna da qui: `browser_eval_js` valuta e restituisce
 * SUBITO, mentre il caricamento dell'immagine è asincrono. Come il picker
 * dell'elemento, l'esito si posa in un globale (`window.__topicsImgCopy`) e il
 * client lo va a leggere. `'ERR'` è il fallimento dichiarato, così chi aspetta
 * non deve distinguerlo da un timeout.
 */
export function imageCopyStartJs(src: string): string {
  return (
    `(function(u){window.__topicsImgCopy='';try{var i=new Image();i.crossOrigin='anonymous';` +
    `i.onload=function(){try{var c=document.createElement('canvas');c.width=i.naturalWidth;c.height=i.naturalHeight;` +
    `c.getContext('2d').drawImage(i,0,0);window.__topicsImgCopy=c.toDataURL('image/png')||'ERR'}catch(e){window.__topicsImgCopy='ERR'}};` +
    `i.onerror=function(){window.__topicsImgCopy='ERR'};i.src=u;` +
    `}catch(e){window.__topicsImgCopy='ERR'}})(${JSON.stringify(src)})`
  );
}

/** L'attesa dell'estrazione: legge il globale e lo azzera quando ha finito. */
export const IMAGE_COPY_READ_JS =
  "(function(){var v=window.__topicsImgCopy||'';if(v)window.__topicsImgCopy='';return v})()";
