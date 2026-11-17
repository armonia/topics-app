import { useLayoutEffect, useState, type RefObject } from 'react';

/** Margine che resta fra il fondo del pannello e il composer. */
const GAP_PX = 24;
/** Sotto questa altezza un pannello non si legge più: meglio che sbordi un poco. */
const FLOOR_PX = 200;

/**
 * Quanto spazio verticale la pane di chat lascia a un blocco che vive nella
 * lista: dal bordo alto, sotto la barra di chrome, al composer.
 *
 * Un pannello con più contenuto di così deve scorrere DENTRO di sé: lo scroll
 * della chat lo porterebbe sì in vista, ma con il composer sopra il fondo e la
 * dissolvenza in cima le opzioni e il pulsante finivano tagliati. Il valore
 * non dipende dal contenuto, quindi non cambia quando arriva il resto del turno.
 *
 * `null` = non siamo dentro una pane di chat (la scheda di un task): chi
 * chiama usa il suo tetto di ripiego.
 */
export function usePaneRoom(ref: RefObject<HTMLElement | null>): number | null {
  const [room, setRoom] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const pane = el?.closest<HTMLElement>('[data-chat-topic-id]');
    if (!el || !pane) return;
    const composer = pane.querySelector<HTMLElement>('[data-testid="chat-input-area"]');
    const measure = () => {
      const top = pane.getBoundingClientRect().top;
      const chrome = parseFloat(getComputedStyle(pane).getPropertyValue('--chrome-bar-h')) || 0;
      const bottom = composer ? composer.getBoundingClientRect().top : pane.getBoundingClientRect().bottom;
      const next = Math.max(FLOOR_PX, Math.floor(bottom - top - chrome - GAP_PX));
      setRoom((prev) => (prev === next ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(pane);
    if (composer) ro.observe(composer);
    return () => ro.disconnect();
  }, [ref]);

  return room;
}
