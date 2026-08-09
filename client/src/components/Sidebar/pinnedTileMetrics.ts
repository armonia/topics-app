/**
 * Le MISURE di una tessera fissata: altezza, contenitore misurato, slot e
 * rientro del comando in coda.
 *
 * Stanno fuori da `PinnedTile.tsx` per la stessa ragione delle altre uscite
 * recenti: un file che esporta un componente E altro spegne il fast refresh di
 * Vite per quel file — ogni modifica alla tessera diventava un ricarico pieno
 * invece di uno scambio a caldo. Ma soprattutto queste misure sono lette da
 * CHI DISEGNA IL VUOTO (il fantasma del drop, l'anteprima della riga nuova, il
 * trigger «+»), non solo dalla tessera: qui sono al loro posto, e nessuno deve
 * importare un componente per sapere quanto è alta una riga.
 */
import { ROW_ACTIONS_INSET_PX, ROW_H } from '../../lib/selectionStyles';

/**
 * L'altezza di una tessera — che è quella di una RIGA, perché una tessera è una
 * riga: {@link ROW_H}, 44 col dito e 34 col mouse.
 *
 * Era `h-9 max-md:h-11`, cioè 36/44: d'accordo col dito e due pixel più alta
 * col mouse. Due pixel nella stessa colonna, fra card impilate una sull'altra —
 * la misura che «fa sembrare storta una colonna senza che si riesca a dire
 * perché», che è la formula con cui questo repo ha già descritto mezzo pixel di
 * glifo fuori asse.
 *
 * ── Perché era 36, e perché quel motivo non reggeva ─────────────────────────
 * Da un'invariante scritta qui sotto: «altezza = box del comando + 2 × rientro»,
 * 28 + 2×4 = 36. Faceva coincidere il rientro ORIZZONTALE del «+» con l'aria
 * sopra e sotto di lui. Bello, e senza un fratello: NESSUNA altra superficie
 * dell'app lo fa. Una riga della colonna è alta 34 con un comando da 28 a 8px
 * dal bordo — 3 di aria verticale contro 8 di orizzontale — e sono due domande
 * diverse: quanto il comando sta lontano dal BORDO (fatto orizzontale, ha già
 * il suo numero, `ROW_PX`) e quanto respira nella riga (non si sceglie, cade
 * fuori dal centraggio). Il repo lo dichiara già altrove: «il bordo è una
 * domanda orizzontale e ha già il suo numero. Il respiro verticale è un'altra
 * cosa e non si sceglie».
 *
 * Tenendo insieme le due, l'invariante decideva l'ALTEZZA della tessera a
 * partire dal rientro del suo bottone: la coda che muove il cane.
 */
export const PINNED_TILE_H = ROW_H;

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

/**
 * LO SLOT DEL «+», cioè la larghezza che il contenuto della tessera gli lascia
 * quando la tessera è in forma RIGA.
 *
 * Il «+» non è mai stato in fila con il resto: è un fratello in `position:
 * absolute` sopra la tessera, e il nome — `flex-1 truncate` — arrivava fino a
 * 6px dal bordo. Su una tessera larga il bottone atterrava quindi SOPRA il
 * testo, e sotto la vibrancy (dove il suo fondo è un'alpha) il testo ci si
 * leggeva attraverso. Uno slot vero toglie il caso: il nome finisce prima, e
 * il bottone si appoggia su niente.
 *
 * Solo sopra la soglia della container query che decide se la
 * tessera è una riga o un quadrato: sotto, la tessera è larga quanto il
 * bottone e riservargli uno slot vorrebbe dire non lasciare niente al nome.
 *
 * È la LARGHEZZA di `ROW_ACTION_BOX` (`w-9 md:w-7`), che è la misura del
 * trigger — scritta per esteso perché Tailwind legge il sorgente e una
 * composizione a runtime non genererebbe nessuna regola. Che i due numeri
 * coincidano lo difende `pinnedTileMetrics.test.ts`.
 */
export const PINNED_TILE_ACTION_SLOT = 'w-9 md:w-7';

/**
 * Il rientro del «+» dal bordo destro — ed è {@link ROW_ACTIONS_INSET_PX}, cioè
 * lo stesso con cui OGNI comando in coda dell'app si ferma dal bordo della sua
 * card (`.row-actions` in index.css).
 *
 * Era 4, e i 4px non erano un gusto: uscivano dall'invariante «altezza = box +
 * 2 × rientro» che la tessera si era data da sola (vedi {@link PINNED_TILE_H}).
 * Il prezzo si vede facendo il conto su una tessera larga W, ora che i figli
 * hanno il passo condiviso (`ROW_GAP`, 8):
 *
 *   · lo SLOT riservato al bottone ({@link PINNED_TILE_ACTION_SLOT}) sta a
 *     `[W−36, W−8]` — 28 di larghezza, dopo gli 8 di padding destro;
 *   · a rientro 4 il bottone cadeva a `[W−32, W−4]`. Cioè NON sul suo slot:
 *     sbordava di 4px dentro il padding a destra e ne lasciava 4 scoperti a
 *     sinistra. Uno slot esiste per essere occupato da chi lo ha chiesto.
 *   · a rientro 8 il bottone cade a `[W−36, W−8]`: esattamente il suo slot.
 *
 * Quindi il numero canonico non è solo più coerente col resto dell'app, è più
 * corretto QUI — ed è l'aritmetica a dirlo, non l'omologazione.
 *
 * L'aria sopra e sotto non è più un terzo uso di questo numero: la lascia il
 * centraggio, (altezza − box)/2, cioè 3 col mouse e 4 col dito — gli stessi di
 * una riga della colonna, per costruzione, da quando la tessera è alta come lei.
 */
export const PINNED_TILE_ACTION_INSET = ROW_ACTIONS_INSET_PX;

/**
 * I numeri dietro le classi qui sopra, in pixel — l'unica forma in cui
 * l'invariante si può VERIFICARE.
 *
 * Non generano niente e non vanno usati per disegnare: le classi restano la
 * sorgente (Tailwind legge il sorgente). Servono al test, che rilegge le classi
 * e controlla che dicano questi numeri e che il conto torni. Senza, «altezza =
 * box + 2 × rientro» è una frase in un commento, e i commenti non diventano
 * rossi.
 */
export const PINNED_TILE_PX = {
  /** Sopra i 768px: `md:h-[34px]` di `ROW_H` / `md:w-7` di `ROW_ACTION_BOX`. */
  wide: { tile: 34, action: 28 },
  /** Sotto i 768px: `h-11` di `ROW_H` / `w-9` di `ROW_ACTION_BOX`. */
  compact: { tile: 44, action: 36 },
} as const;
