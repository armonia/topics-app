/**
 * La pagina non deve restare scalata dopo che hai toccato un campo.
 *
 * Secondo difetto della segnalazione del 12/08: «mi va la pagina scalata». È lo
 * zoom automatico di iOS al focus — scatta quando il campo che riceve il focus
 * ha un font sotto i 16px, e NON torna indietro da solo: resti dentro una shell
 * ingrandita, con la chrome del pane fuori schermo.
 *
 * Dove il campo è nostro (il campo di cattura del co-browse) il difetto si
 * spegne alla radice, mettendogli 16px. Ma nel ramo <iframe> il campo è del
 * SITO, e il CSS del sito non è nostro e non si tocca: lì l'unica leva è
 * accorgersi che la scala è cambiata e riportarla a 1.
 *
 * Come si riporta: il `content` del meta viewport è l'unico comando che Safari
 * accetta per la scala. Alzare `maximum-scale` e riabbassarlo a 1 costringe il
 * motore a ri-agganciare la scala corrente al nuovo tetto — cioè a tornare a 1.
 * Va fatto in due frame: se si riscrive lo stesso valore che c'è già, non
 * cambia niente e Safari non ricalcola.
 */

/** Sotto questa differenza la scala è «uno»: i motori danno 1.0000001 e simili. */
const SCALE_EPSILON = 0.01;
/** Tetto momentaneo, alto abbastanza da essere un valore DIVERSO da quello vero. */
const RELEASED_MAX_SCALE = '10.0';
const PINNED_MAX_SCALE = '1.0';

/**
 * Riscrive `maximum-scale` dentro il `content` di un meta viewport, lasciando
 * intatto tutto il resto (`viewport-fit=cover`, `interactive-widget`… : sono
 * direttive che se cadono cambiano il layout dell'app, non solo lo zoom).
 */
export function withMaximumScale(content: string, value: string): string {
  const parts = content.split(',').map((p) => p.trim()).filter(Boolean);
  let found = false;
  const next = parts.map((p) => {
    if (!/^maximum-scale\s*=/.test(p)) return p;
    found = true;
    return `maximum-scale=${value}`;
  });
  if (!found) next.push(`maximum-scale=${value}`);
  return next.join(', ');
}

function metaViewport(): HTMLMetaElement | null {
  return document.querySelector('meta[name="viewport"]');
}

/**
 * Riporta la scala a 1. Ritorna `false` se non c'è un meta viewport su cui
 * agire — il chiamante non ha nulla da tentare in quel caso.
 */
export function resetViewportScale(): boolean {
  const meta = metaViewport();
  if (!meta) return false;
  const pinned = withMaximumScale(meta.content, PINNED_MAX_SCALE);
  meta.content = withMaximumScale(meta.content, RELEASED_MAX_SCALE);
  // Il ritorno al tetto di 1 deve arrivare in un frame DIVERSO, altrimenti il
  // motore vede una sola scrittura e non ha niente da ri-agganciare.
  requestAnimationFrame(() => {
    const m = metaViewport();
    if (m) m.content = pinned;
  });
  return true;
}

/**
 * Sorveglia la scala finché la superficie che l'ha chiesto è montata.
 *
 * Contata a riferimenti: due pane browser aperte insieme installano una sola
 * guardia, e l'ultima che si smonta la toglie. Senza il conteggio la prima
 * chiusura spegnerebbe la sorveglianza dell'altra.
 */
let guardRefs = 0;
let detach: (() => void) | null = null;

export function installViewportZoomGuard(): () => void {
  guardRefs++;
  if (guardRefs === 1) {
    const vv = window.visualViewport;
    if (vv) {
      // `resize` è l'evento che porta il cambio di scala; arriva anche quando
      // sale la tastiera (l'altezza cambia, la scala no) e lì non facciamo
      // nulla: si guarda SOLO la scala.
      const onChange = () => {
        if (vv.scale > 1 + SCALE_EPSILON) resetViewportScale();
      };
      vv.addEventListener('resize', onChange);
      detach = () => vv.removeEventListener('resize', onChange);
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    guardRefs = Math.max(0, guardRefs - 1);
    if (guardRefs === 0) {
      detach?.();
      detach = null;
    }
  };
}
