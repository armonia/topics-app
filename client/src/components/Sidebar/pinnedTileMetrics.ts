/**
 * Le MISURE di una tessera fissata: altezza, contenitore misurato, rientro
 * delle azioni.
 *
 * Stanno fuori da `PinnedTile.tsx` per la stessa ragione delle altre uscite
 * recenti: un file che esporta un componente E altro spegne il fast refresh di
 * Vite per quel file — ogni modifica alla tessera diventava un ricarico pieno
 * invece di uno scambio a caldo. Ma soprattutto queste misure sono lette da
 * CHI DISEGNA IL VUOTO (il fantasma del drop, l'anteprima della riga nuova, il
 * trigger «+»), non solo dalla tessera: qui sono al loro posto, e nessuno deve
 * importare un componente per sapere quanto è alta una riga.
 */

/**
 * L'altezza di una tessera, in classe Tailwind. Dichiarata QUI e importata dal
 * posto vuoto del drop: due numeri scritti a mano si allineano finché qualcuno
 * non ne cambia uno, e l'anteprima che salta di quattro pixel rispetto alla
 * tessera che sta annunciando è proprio il difetto che l'anteprima esiste per
 * non avere.
 */
export const PINNED_TILE_H = 'h-8 max-md:h-11';

/**
 * Il contenitore che la tessera MISURA per decidere se è una riga o un
 * quadrato. Va su chi le dà la larghezza — la cella della griglia — perché un
 * elemento non può interrogare se stesso: `justify-content` del bottone deve
 * poter cambiare con la soglia, e ci riesce solo se il contenitore è il suo
 * genitore. Sta qui accanto all'altezza, ed è esportato, perché le celle sono
 * TRE (quella vera, il fantasma del drop, l'anteprima della riga nuova) e una
 * dimenticata darebbe una tessera che non si adatta più — muta, senza errore.
 */
export const PINNED_TILE_CONTAINER = '@container/tile';

/** Il rientro del «+» dal bordo destro, e — perché il bottone è centrato in
 *  verticale — anche lo spazio sopra e sotto di lui. I tre coincidono solo a
 *  una condizione: `PINNED_TILE_H` = altezza del trigger + 2 × questo. Il
 *  trigger «pill» di `PaneAddMenu` è 24px (`w-6 h-6`), quindi 24 + 8 = 32 =
 *  `h-8`. Cambiare uno dei due senza l'altro rompe l'uguaglianza in silenzio:
 *  stanno scritti vicini per questo.
 *
 *  SOTTO I 768px la tessera è `h-11` (44) — misurata col dito era 378×32, e i 32
 *  sono il lato corto, cioè quello che conta per un pollice. L'uguaglianza vale
 *  anche lì SOLO se l'inset segue: 44 = 24 + 2 × 10. È il motivo per cui questo
 *  non è più un numero secco ma una coppia, e per cui va letto con
 *  `pinnedTileActionInset(isMobile)` invece che direttamente: due costanti
 *  scollegate sarebbero tornate a divergere alla prima modifica. */
export const PINNED_TILE_ACTION_INSET = 4;
export const PINNED_TILE_ACTION_INSET_MOBILE = 10;
/** L'inset giusto per la larghezza corrente. Vedi il commento qui sopra. */
export function pinnedTileActionInset(isMobile: boolean): number {
  return isMobile ? PINNED_TILE_ACTION_INSET_MOBILE : PINNED_TILE_ACTION_INSET;
}
