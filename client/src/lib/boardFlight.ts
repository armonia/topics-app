/**
 * boardFlight.ts — la card che CAMBIA COLONNA ci arriva viaggiando, e le vicine
 * le fanno spazio.
 *
 * COSA SUCCEDEVA PRIMA. Un task che cambiava stato spariva da una colonna e
 * riappariva in un'altra nello stesso fotogramma. Restava il lampo colorato
 * (`lib/columnFlash`), che dice DOVE guardare ma non racconta niente: se stavi
 * leggendo la colonna di partenza, la card semplicemente non c'era piu'. Il
 * movimento e' l'unica cosa che lega le due posizioni: quella card LI' e'
 * quella card QUI.
 *
 * PERCHE' FLIP. Le card non hanno una posizione da animare: stanno in una
 * colonna in flusso normale, e il loro posto lo decide l'ordine dei nodi dentro
 * la colonna in cui si trovano. Non c'e' nessuna proprieta' CSS che cambi
 * valore, quindi non c'e' niente da interpolare. Si misura dov'erano (First),
 * dove sono finite (Last), le si rimette dov'erano con una `transform` (Invert)
 * e si lascia che l'animazione le riporti a zero (Play). E' la stessa tecnica
 * di `Sidebar/useCellFlip`, con una differenza che cambia tutto: li' la cella
 * resta nello stesso contenitore, qui la card cambia PADRE (colonna) e il
 * padre vecchio taglia (`overflow-y: auto` implica un taglio anche in
 * orizzontale). Per questo il viaggio fra colonne lo fa una COPIA `fixed` sul
 * body, mentre lo spostamento dentro una colonna lo fa il nodo vero.
 *
 * LE MISURE NON SONO QUELLE DELLA FINESTRA, e non e' un dettaglio.
 * `getBoundingClientRect` dice dove la card sta rispetto al VIEWPORT: scorrere
 * la colonna di 40px cambia quel numero senza che niente si sia spostato. Il
 * confronto qui e' fra due render distanti secondi (arriva l'aggiornamento di
 * un agente), e in mezzo chi guarda scorre. Quindi ogni card si registra con la
 * sua posizione DENTRO il contenuto della colonna (`x`/`y` gia' corretti per lo
 * scorrimento), e la posizione sullo schermo si ricostruisce al momento di
 * animare, con la geometria delle colonne di ADESSO. E' lo stesso errore che
 * l'anno scorso faceva "sminchiare i pinnati" nella sidebar durante lo scroll,
 * e la stessa cura.
 *
 * QUI NON C'E' DOM. Questo modulo prende numeri e torna una lista di movimenti;
 * chi misura e chi anima e' `components/Board/useBoardMotion.ts`.
 */

/** La geometria ATTUALE di una colonna: dove sta e a che punto e' scorsa. */
export interface ColumnBox {
  left: number;
  top: number;
  scrollLeft: number;
  scrollTop: number;
}

/** Dove sta una card DENTRO il contenuto della sua colonna, e quanto e' larga. */
export interface CardSpot {
  status: string;
  x: number;
  y: number;
  w: number;
}

export interface BoardMove {
  id: string;
  /** `flight` = ha cambiato colonna (viaggia una copia). `shift` = si e' spostata dentro la sua. */
  kind: 'flight' | 'shift';
  /** La traslazione da APPLICARE all'inizio: dove la card si vedeva prima, meno dove si vede adesso. */
  dx: number;
  dy: number;
  /** Il rapporto fra la larghezza di prima e quella di adesso (le colonne non sono tutte larghe uguale). */
  scale: number;
}

/** Sotto questa soglia non e' un movimento, e' un arrotondamento sub-pixel. */
const MIN_MOVE_PX = 1.5;

/**
 * Quanti VIAGGI al massimo insieme. Un agente che consegna tre task in un
 * secondo, o un filtro che si spegne, possono muovere mezza board: cinque copie
 * che attraversano lo schermo tutte insieme non sono un racconto, sono
 * confusione. Oltre il tetto restano il lampo e la posizione nuova, che sono
 * gia' l'informazione.
 */
const MAX_FLIGHTS = 3;

/**
 * Quanti SPOSTAMENTI interni al massimo. Sono economici (una `transform` sul
 * nodo vero) ma non gratis, e oltre il centinaio si sta animando una lista che
 * e' stata rifatta, non una lista in cui e' successo qualcosa.
 */
const MAX_SHIFTS = 40;

/**
 * Oltre questa distanza la card non stava sullo schermo prima o non ci sta
 * adesso: il viaggio sarebbe un fantasma che entra da fuori campo.
 */
const MAX_TRAVEL_PX = 2600;

/** Dove una card si vede sullo schermo, date la sua posizione in colonna e la colonna. */
function schermo(spot: CardSpot, col: ColumnBox): { left: number; top: number } {
  return { left: col.left + spot.x - col.scrollLeft, top: col.top + spot.y - col.scrollTop };
}

/**
 * I movimenti da giocare fra due istantanee della board.
 *
 * `before` e' l'istantanea del commit precedente, `after` quella appena
 * misurata, `columns` la geometria delle colonne ADESSO (serve a ricostruire
 * dove le card si vedevano prima, al netto dello scorrimento).
 *
 * `skip` sono le card da lasciare stare per questo giro: ci finisce quella
 * appena TRASCINATA, che al dito e' gia' arrivata dove doveva e che rivedere
 * partire da dov'era sarebbe un passo indietro.
 */
export function planBoardMoves(args: {
  before: ReadonlyMap<string, CardSpot>;
  after: ReadonlyMap<string, CardSpot>;
  columns: ReadonlyMap<string, ColumnBox>;
  skip?: ReadonlySet<string>;
}): BoardMove[] {
  const { before, after, columns, skip } = args;
  const voli: BoardMove[] = [];
  const scivolate: BoardMove[] = [];

  for (const [id, ora] of after) {
    if (skip?.has(id)) continue;
    const prima = before.get(id);
    if (!prima) continue; // una card NATA non arriva da nessuna parte
    const colPrima = columns.get(prima.status);
    const colOra = columns.get(ora.status);
    if (!colPrima || !colOra) continue;

    const da = schermo(prima, colPrima);
    const a = schermo(ora, colOra);
    const dx = da.left - a.left;
    const dy = da.top - a.top;
    if (Math.abs(dx) < MIN_MOVE_PX && Math.abs(dy) < MIN_MOVE_PX) continue;
    if (Math.abs(dx) > MAX_TRAVEL_PX || Math.abs(dy) > MAX_TRAVEL_PX) continue;

    if (prima.status !== ora.status) {
      // Le colonne non sono larghe uguale (Review e' piu' larga delle altre):
      // una card che ci entra CRESCE, e il viaggio deve mostrare anche quello,
      // altrimenti alla fine si vede un salto di larghezza. Il fattore e'
      // limitato: oltre, non e' piu' la stessa card che si adatta.
      const rapporto = ora.w > 0 ? prima.w / ora.w : 1;
      const scale = Math.abs(prima.w - ora.w) < 2 ? 1 : Math.min(1.4, Math.max(0.7, rapporto));
      voli.push({ id, kind: 'flight', dx, dy, scale });
    } else {
      // Larghezza cambiata a colonna ferma = la colonna si e' ridimensionata
      // (il drawer si e' aperto, la finestra e' cambiata). Li' non si e'
      // spostato niente: si e' ridisegnato tutto, e una traslazione mentirebbe.
      if (Math.abs(prima.w - ora.w) >= 1) continue;
      scivolate.push({ id, kind: 'shift', dx, dy, scale: 1 });
    }
  }

  // I viaggi per primi: sono l'evento, e chi anima li vuole in cima anche
  // quando il tetto taglia il resto.
  return [...voli.slice(0, MAX_FLIGHTS), ...scivolate.slice(0, MAX_SHIFTS)];
}
