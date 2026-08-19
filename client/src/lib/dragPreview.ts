/**
 * COSA SI VEDE MENTRE TRASCINO, deciso in UN posto solo.
 *
 * ── La segnalazione ─────────────────────────────────────────────────────────
 * «All'interno di un progetto non si riesce a fare bene il drag and drop fra
 * tabbar splittate: è difficile fare il drop perché non c'è nessuna anteprima.
 * Dovrebbe esserci l'anteprima completa della carta, in tutti quanti i casi in
 * cui andiamo a fare un drag and drop posizionale.»
 *
 * La meccanica del drop era già a posto. Quello che mancava è il riscontro:
 * durante il gesto non si vede né COSA si sta portando né DOVE atterrerà,
 * quindi il rilascio si azzecca a tentativi. La scelta era replicata in undici
 * `onDragStart` diversi, ognuno con la sua idea (chi una pillola, chi la riga
 * fotografata, chi niente): un comportamento deciso in undici posti diverge, e
 * il modo in cui diverge è esattamente questo.
 *
 * ── Il vincolo che governa la soluzione ─────────────────────────────────────
 * `setDragImage` fotografa un nodo del DOM, ma **nella WKWebView del guscio
 * (Tauri/macOS, e Safari) la fotografia di un nodo FUORI dal viewport visivo
 * torna VUOTA**, e il sistema ripiega sull'icona generica di documento: è la
 * segnalazione «la tab sembra un file mentre la trascino». Quindi il trucco
 * classico — costruire la pillola a `left:-9999px` e fotografarla — è proprio
 * quello che non si può fare. Il nodo dev'essere SULLO SCHERMO.
 *
 * ── Come è fatta, allora ────────────────────────────────────────────────────
 * Un nodo vero, vivo, alla posizione del cursore, per tutta la durata del
 * gesto. Serve due volte:
 *
 *   1. è la sorgente di `setDragImage` (è dentro il viewport, quindi la
 *      fotografia riesce anche in WKWebView);
 *   2. **resta lì e segue il puntatore**, con lo STESSO punto di presa passato
 *      a `setDragImage`. Cioè il fantasma disegnato dal sistema e la nostra
 *      scheda si sovrappongono per costruzione: dove il sistema disegna, sotto
 *      c'è la stessa cosa. Non si vede doppio, e se il fantasma di sistema non
 *      c'è affatto (iOS: il drag HTML5 non esiste, il gesto è un long press)
 *      l'anteprima si vede lo stesso.
 *
 * Il punto 2 è anche l'unico modo di PROVARLO: il fantasma del sistema è
 * disegnato dal compositor, non dal documento, quindi nessun test potrà mai
 * vederlo. Un nodo nel DOM sì.
 */

/** Cosa mostra l'anteprima. Il titolo è obbligatorio: chi trascina deve
 *  riconoscere la cosa che ha in mano, e il nome è il minimo per riconoscerla. */
export interface DragPreviewSpec {
  /** Il nome della cosa: titolo del topic, della tab, della card. */
  title: string;
  /** Seconda riga: il percorso, l'URL, la colonna, il progetto. */
  subtitle?: string;
  /** Un glifo davanti al titolo (emoji o carattere singolo). */
  icon?: string;
  /** Etichette corte sotto il titolo: stato, tipo, conteggi. */
  badges?: readonly string[];
  /** Colore del punto d'accento. Default: `var(--primary)`. */
  accent?: string;
}

/** L'attributo che marca il nodo di anteprima. È il contratto con i test e con
 *  chi legge il DOM: uno solo, e non ce n'è mai più di uno alla volta. */
export const DRAG_PREVIEW_ATTR = 'data-drag-preview';

/**
 * L'attributo con cui un BERSAGLIO si dichiara mentre il puntatore ci passa
 * sopra. Metà della segnalazione era l'anteprima, l'altra metà è questa: senza
 * il segno di dove cadrà, il drop resta un tentativo.
 *
 * Il valore dice che tipo di atterraggio è, perché non sono la stessa cosa:
 *  · `into`   il rilascio entra DENTRO il bersaglio (un gruppo, una colonna);
 *  · `before` / `after` si inserisce accanto (riordino posizionale);
 *  · `split`  taglia il bersaglio in due (i bordi di una griglia).
 *
 * Il disegno sta in `index.css` in UNA regola sola, così una superficie nuova
 * si dichiara aggiungendo un attributo e non ricopiando uno stile.
 */
export const DROP_ACTIVE_ATTR = 'data-drop-active';
export type DropIntent = 'into' | 'before' | 'after' | 'split';

/** Il punto di presa, in coordinate della scheda. Vicino all'angolo alto a
 *  sinistra: la scheda pende dal cursore come un foglio tenuto per l'angolo, e
 *  non copre quello che sta sotto al puntatore (cioè il bersaglio). */
const GRAB_X = 22;
const GRAB_Y = 20;

let nodo: HTMLElement | null = null;
let agganciato = false;

function costruisci(spec: DragPreviewSpec): HTMLElement {
  const card = document.createElement('div');
  card.setAttribute(DRAG_PREVIEW_ATTR, '');
  card.setAttribute('aria-hidden', 'true');
  card.style.cssText = `
    position:fixed;left:0;top:0;z-index:2147483000;
    display:flex;align-items:flex-start;gap:9px;
    min-width:150px;max-width:290px;
    padding:9px 13px 9px 11px;border-radius:11px;
    font:500 12.5px/1.35 Inter,system-ui,sans-serif;
    background:var(--bg-elevated,#fff);color:var(--text,#111);
    border:1px solid var(--border,rgba(0,0,0,0.12));
    box-shadow:0 10px 28px rgba(0,0,0,0.26);
    pointer-events:none;user-select:none;
    will-change:transform;
  `;

  const punto = document.createElement('span');
  punto.style.cssText = `flex:0 0 auto;margin-top:4px;width:7px;height:7px;border-radius:9999px;background:${spec.accent || 'var(--primary,#3b82f6)'};`;
  card.appendChild(punto);

  const colonna = document.createElement('div');
  colonna.style.cssText = 'min-width:0;display:flex;flex-direction:column;gap:3px;';

  const titolo = document.createElement('div');
  titolo.textContent = spec.icon ? `${spec.icon} ${spec.title}` : spec.title;
  titolo.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;';
  colonna.appendChild(titolo);

  if (spec.subtitle) {
    const sotto = document.createElement('div');
    sotto.textContent = spec.subtitle;
    sotto.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-weight:400;opacity:0.62;';
    colonna.appendChild(sotto);
  }

  const badges = (spec.badges || []).filter(Boolean);
  if (badges.length) {
    const riga = document.createElement('div');
    riga.style.cssText = 'display:flex;gap:5px;flex-wrap:nowrap;overflow:hidden;';
    for (const b of badges.slice(0, 3)) {
      const chip = document.createElement('span');
      chip.textContent = b;
      chip.style.cssText = `
        padding:1px 6px;border-radius:9999px;font-size:10px;font-weight:600;
        white-space:nowrap;
        background:color-mix(in srgb, ${spec.accent || 'var(--primary,#3b82f6)'} 16%, transparent);
        color:var(--text,#111);opacity:0.85;
      `;
      riga.appendChild(chip);
    }
    colonna.appendChild(riga);
  }

  card.appendChild(colonna);
  return card;
}

function posiziona(x: number, y: number): void {
  if (!nodo) return;
  nodo.style.transform = `translate3d(${Math.round(x - GRAB_X)}px, ${Math.round(y - GRAB_Y)}px, 0)`;
}

/**
 * Aggancia al documento il seguito del puntatore e le porte di spegnimento.
 *
 * Le porte sono cinque per lo stesso motivo per cui lo sono in `paneDragFlag`:
 * `dragend`/`drop` NON sono garantiti (nella WKWebView si perdono quando il
 * rilascio cade sopra una vista nativa), e un'anteprima rimasta accesa sarebbe
 * una scheda incollata sopra l'interfaccia. Il `pointermove` senza bottone
 * premuto è la prova che il gesto è finito comunque: durante un drag HTML5 gli
 * eventi di puntatore sono soppressi, quindi se ne arriva uno il drag non c'è più.
 */
function aggancia(): void {
  if (agganciato) return;
  agganciato = true;
  document.addEventListener('dragover', (e) => posiziona(e.clientX, e.clientY), true);
  document.addEventListener('drag', (e) => {
    // Alcuni motori mandano `drag` con coordinate 0,0 a fine gesto: quelle
    // porterebbero la scheda nell'angolo per un frame. Si ignorano.
    if (e.clientX || e.clientY) posiziona(e.clientX, e.clientY);
  }, true);
  document.addEventListener('dragend', endDragPreview, true);
  document.addEventListener('drop', endDragPreview, true);
  window.addEventListener('blur', endDragPreview);
  window.addEventListener('pointerup', endDragPreview, true);
  window.addEventListener('pointermove', (e) => {
    if ((e.buttons & 1) === 0) endDragPreview();
  }, true);
}

/**
 * Da chiamare nel `dragstart`, dopo la `setData`. Monta la scheda al cursore,
 * la consegna a `setDragImage` e la lascia lì a seguire il puntatore fino alla
 * fine del gesto.
 */
export function startDragPreview(
  e: { clientX: number; clientY: number; dataTransfer: DataTransfer | null },
  spec: DragPreviewSpec,
): void {
  endDragPreview();
  aggancia();
  const card = costruisci(spec);
  document.body.appendChild(card);
  nodo = card;
  posiziona(e.clientX, e.clientY);
  // La fotografia riesce solo se il nodo è già impaginato E dentro il viewport
  // visivo: qui lo è, perché è appena stato messo sotto al cursore.
  e.dataTransfer?.setDragImage(card, GRAB_X, GRAB_Y);
}

/**
 * La stessa anteprima per il gesto col dito, dove il drag HTML5 non esiste
 * (iOS non emette nessuno dei suoi eventi: vedi `useTouchDrag`). Qui non c'è
 * nessun fantasma di sistema, quindi questo nodo è l'UNICA anteprima.
 */
export function startTouchDragPreview(spec: DragPreviewSpec, x: number, y: number): void {
  endDragPreview();
  aggancia();
  const card = costruisci(spec);
  document.body.appendChild(card);
  nodo = card;
  posiziona(x, y);
}

/** Il dito si muove. */
export function moveDragPreview(x: number, y: number): void {
  posiziona(x, y);
}

/** Spegne l'anteprima. Idempotente: le porte di spegnimento sono tante e
 *  scattano anche tutte insieme. */
export function endDragPreview(): void {
  if (!nodo) return;
  nodo.remove();
  nodo = null;
}

/** C'è un'anteprima accesa? Serve ai test e a chi deve decidere se il gesto è
 *  ancora vivo senza guardare il DOM. */
export function dragPreviewActive(): boolean {
  return nodo !== null;
}
