/**
 * useHoverReveal — la regola di `lib/hoverReveal` letta dal componente.
 *
 * Nove file scrivevano a mano `opacity-0 group-hover:opacity-100`, e otto su
 * nove lasciavano col dito un comando irraggiungibile con sotto un bersaglio
 * invisibile ancora cliccabile. Qui la coppia giusta arriva già fatta:
 *
 *     const reveal = useHoverReveal('node');                    // sparisce col dito
 *     const reveal = useHoverReveal('hdr', { touch: 'shown' }); // col dito si vede
 *     <div className={`ml-auto flex … ${reveal}`}>
 *
 * `touch: 'hidden'` (il default) è legittimo SOLO se quel comando ha un altro
 * percorso col dito — di norma il menu di riga (`useLongPress` +
 * `openContextMenuAt`). Il perché di ogni pezzo sta in `lib/hoverReveal.ts`.
 */
import { useMobile } from './useMobile';
import { hoverRevealClass, type HoverRevealGroup, type HoverRevealOptions } from '../lib/hoverReveal';

export function useHoverReveal(
  group: HoverRevealGroup = 'self',
  options: HoverRevealOptions = {},
): string {
  const { hasHover } = useMobile();
  return hoverRevealClass(hasHover, group, options);
}

export { hoverRevealClass, HOVER_REVEAL_HIDDEN, type HoverRevealGroup } from '../lib/hoverReveal';
