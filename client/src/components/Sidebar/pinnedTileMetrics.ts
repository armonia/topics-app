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

/**
 * L'altezza di una tessera, in classe Tailwind. Dichiarata QUI e importata dal
 * posto vuoto del drop: due numeri scritti a mano si allineano finché qualcuno
 * non ne cambia uno, e l'anteprima che salta di quattro pixel rispetto alla
 * tessera che sta annunciando è proprio il difetto che l'anteprima esiste per
 * non avere.
 *
 * 36 e non più 32. Il 07/08 il «+» era passato da 24 a `ROW_ACTION_BOX` (28) —
 * un comando di riga ha UNA misura in tutta la sidebar — e per non far crescere
 * la tessera si era schiacciato il rientro da 4 a 2: 28 dentro 32, due pixel di
 * respiro per parte, appoggiati su un nome che continuava sotto. Il difetto
 * riferito («il tastino è troppo stretto sulle tessere singole») non era una
 * larghezza sbagliata — il bottone è 28 in tutti i casi — era il rapporto con
 * quello che gli sta sotto. Qui si sceglie il verso giusto: il comando resta
 * alla misura condivisa e la tessera gli fa spazio, invece del contrario.
 */
export const PINNED_TILE_H = 'h-9 max-md:h-11';

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
 * Il rientro del «+» dal bordo destro, e — perché il bottone è centrato in
 * verticale — anche lo spazio sopra e sotto di lui. I tre coincidono solo a
 * una condizione: `PINNED_TILE_H` = altezza del trigger + 2 × questo. Il
 * trigger «pill» di `PaneAddMenu` vale `ROW_ACTION_BOX`, cioè 28px sopra i
 * 768px e 36 sotto: 28 + 2 × 4 = 36 = `h-9`, e 36 + 2 × 4 = 44 = `h-11`.
 * Cambiare uno dei due senza l'altro rompe l'uguaglianza in silenzio: stanno
 * scritti vicini per questo, e `pinnedTileMetrics.test.ts` li rilegge.
 *
 * ERA DUE COSTANTI — 2 sul desktop, 4 col dito — perché la tessera era ferma a
 * 32 e il rientro doveva assorbire la differenza fra i due box. Portata la
 * tessera a 36 il conto torna con lo STESSO rientro su entrambe le larghezze,
 * quindi la costante è una: due numeri accoppiati da un'invariante che risulta
 * essere la stessa cifra non sono due numeri, sono uno scritto due volte.
 */
export const PINNED_TILE_ACTION_INSET = 4;

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
  /** Sopra i 768px: `h-9` / `md:w-7` di `ROW_ACTION_BOX`. */
  wide: { tile: 36, action: 28 },
  /** Sotto i 768px: `max-md:h-11` / `w-9` di `ROW_ACTION_BOX`. */
  compact: { tile: 44, action: 36 },
} as const;
