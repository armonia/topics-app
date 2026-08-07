/**
 * Il RAGGRUPPAMENTO PER PROGETTO della riga «Board», e quanti ce ne stanno.
 *
 * Attilio, 07/08: «sul tastino del board, nella sidebar, mettere anche un
 * raggruppamento per quelli che ci entrano effettivamente nello spazio, dei
 * task per progetto, utilizzando ovviamente l'icona del progetto».
 *
 * «Quelli che ci entrano» è la parte che va MISURATA, non indovinata: la
 * sidebar si ridimensiona col trascinamento del bordo, e un numero fisso di
 * pastiglie o sborda o lascia mezza riga vuota. Le due funzioni qui sotto sono
 * pure — una raccoglie, l'altra taglia — così la decisione si può provare senza
 * montare niente, che è l'unico modo di verificare una regola di ritaglio.
 */
import type { BoardProjectRef } from '../../lib/board';
import type { BoardTask, TaskStatus } from '../../lib/board';
import { resolveProjectRefs } from '../../lib/boardProjectsStore';

export interface BoardProjectChip {
  projectId: string;
  /** Nome leggibile — dall'indice quando c'è, dall'id ripulito altrimenti. */
  name: string;
  /** Il percorso su disco: senza, `ProjectFavicon` non ha da dove risolvere
   *  l'icona. Vale `''` per un progetto che l'indice non conosce (cartella
   *  sparita, indice non ancora arrivato): la pastiglia esiste lo stesso, col
   *  solo nome, invece di far sparire dei task dal conteggio. */
  path: string;
  /** Quanti task APERTI ha questo progetto. */
  n: number;
}

/**
 * I progetti presenti fra i task aperti, dal più carico al meno carico (a pari
 * numero, in ordine di nome, così l'ordine non balla fra un giro e l'altro).
 *
 * `done` resta fuori, come per il conteggio della riga e per i pallini di
 * stato: la board si annuncia per il lavoro APERTO.
 */
export function boardProjectChips(
  byStatus: Record<TaskStatus, BoardTask[]> | undefined,
  index: BoardProjectRef[] | null,
): BoardProjectChip[] {
  if (!byStatus) return [];
  const counts = new Map<string, number>();
  for (const [status, tasks] of Object.entries(byStatus)) {
    if (status === 'done') continue;
    for (const t of tasks) counts.set(t.projectId, (counts.get(t.projectId) ?? 0) + 1);
  }
  if (counts.size === 0) return [];
  const refs = resolveProjectRefs([...counts.keys()], index);
  return refs
    .map((r) => ({ projectId: r.projectId, name: r.name, path: r.path, n: counts.get(r.projectId) ?? 0 }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}

/**
 * La larghezza di una pastiglia, in px. Una sola misura per tutte, e non è
 * pigrizia: l'icona di un progetto arriva da una richiesta di rete, quindi una
 * pastiglia larga «quanto serve» cambierebbe misura quando l'icona atterra — e
 * il numero di pastiglie visibili cambierebbe con lei, a cose ferme. Il layout
 * non si decide su uno stato asincrono: lo slot è fisso e l'icona ci entra
 * dentro, presente o assente che sia.
 *
 * 52 = icona 12 + 4 di gap + ~24 di nome troncato + 4 + due cifre a 10px. Era
 * 68 quando le pastiglie stavano su una riga tutta loro, sotto il nome; IN
 * LINEA lo spazio è quello che avanza dopo «Board» e i conteggi — misurato su
 * una colonna da 256px sono ~107px — e a 68 ce ne entrava UNA. A 52 ce ne
 * entrano due, che è la differenza fra un raggruppamento e un esempio.
 */
export const CHIP_W = 52;
/** Lo spazio fra due pastiglie (`gap-1.5`, lo stesso passo della riga). */
export const CHIP_GAP = 6;
/** Il «+N» finale: due caratteri a 10px più il suo respiro. */
export const MORE_W = 22;

export interface FittedChips<T> {
  shown: T[];
  /** Quante sono rimaste fuori. `0` ⇒ nessun «+N» da disegnare. */
  hidden: number;
}

/**
 * Quante pastiglie stanno in `width` pixel.
 *
 * Due passaggi, e il secondo è quello che di solito manca: se non ci stanno
 * tutte serve spazio anche per il «+N» che dichiara le mancanti, quindi il
 * conteggio va rifatto con quel posto già tolto. Senza, l'ultima pastiglia e il
 * «+N» si contendono gli stessi pixel e uno dei due esce dal bordo.
 */
export function fitProjectChips<T>(width: number, chips: readonly T[]): FittedChips<T> {
  if (chips.length === 0) return { shown: [], hidden: 0 };
  // Prima della prima misura la larghezza è 0: non si disegna niente e non si
  // annuncia niente. Un «+3» che compare e sparisce al primo layout è peggio
  // del vuoto di un frame.
  if (width <= 0) return { shown: [], hidden: 0 };
  const span = (n: number) => n * CHIP_W + (n - 1) * CHIP_GAP;
  let n = chips.length;
  while (n > 0 && span(n) > width) n--;
  if (n === chips.length) return { shown: [...chips], hidden: 0 };
  while (n > 0 && span(n) + CHIP_GAP + MORE_W > width) n--;
  return { shown: chips.slice(0, n), hidden: chips.length - n };
}
