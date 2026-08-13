/**
 * IL GESTO CHE CHIUDE NON FA ANCHE L'ALTRA COSA.
 *
 * Segnalato dal telefono: «se ho un overlay e clicco fuori per chiuderlo, mi
 * conta l'azione sugli elementi sottostanti, ma se ho il coso avanti dovrei
 * prima chiudere il coso perché magari non si vede manco dove sto cliccando».
 *
 * Il difetto era strutturale, non di un call-site: `useDismissable` chiude sul
 * `pointerdown` (in cattura, perché deve vincere la corsa contro chi ferma la
 * propagazione). Il `click` arriva DOPO, quando il pannello è già smontato, e
 * trova sotto il puntatore l'elemento della pagina — che quindi si aziona. Un
 * dito solo, due effetti: chiudi il menu e in più cambi tab, apri un topic,
 * archivi una riga. Su un telefono il pannello copre quasi tutto lo schermo,
 * quindi la cosa che hai azionato non l'avevi nemmeno vista.
 *
 * La regola, una sola per tutte le superfici che si chiudono da sole: **il
 * primo click dopo una chiusura per pressione esterna viene mangiato**. Non si
 * spegne il `pointerdown` — il fuoco e il posizionamento del cursore in un
 * campo di testo passano di lì, e toglierli renderebbe il gesto peggiore di
 * come l'abbiamo trovato: si spegne solo l'attivazione.
 *
 * Il tempo di guardia esiste perché un click potrebbe non arrivare mai (il dito
 * scivola e diventa uno scorrimento, il puntatore esce dalla finestra): senza,
 * il guardiano resterebbe armato e mangerebbe il click BUONO di un minuto dopo.
 */

/** Oltre questo, il click che aspettavamo non arriva più: si disarma. */
const GUARDIA_MS = 700;

/** Il minimo di `document` che serve qui — così la regola si prova senza un DOM. */
export interface PressHost {
  addEventListener(type: string, listener: (e: SwallowableEvent) => void, options?: { capture?: boolean }): void;
  removeEventListener(type: string, listener: (e: SwallowableEvent) => void, options?: { capture?: boolean }): void;
}

/** Il minimo di `MouseEvent` che serve qui. */
export interface SwallowableEvent {
  stopPropagation(): void;
  preventDefault(): void;
}

export interface SwallowDeps {
  host: PressHost;
  /** Ritorna il modo di annullare l'attesa. Iniettabile per i test. */
  schedule: (fn: () => void, ms: number) => () => void;
}

function defaultDeps(): SwallowDeps {
  return {
    host: document,
    schedule: (fn, ms) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
  };
}

/**
 * Il guardiano in carica. Sta a livello di MODULO e non nell'effetto che lo
 * arma, ed è l'unico modo perché funzioni: chi lo arma è un popover che in quel
 * preciso istante si sta chiudendo, quindi la sua pulizia parte PRIMA del click
 * che stiamo aspettando. Legato al componente, il guardiano si smonterebbe da
 * solo un attimo prima di servire.
 *
 * Uno solo: per il touch arrivano sia `touchstart` sia `pointerdown`, cioè due
 * armamenti per lo stesso dito, e due listener significano due `preventDefault`
 * (innocuo) ma anche un listener che resta appeso (non innocuo).
 */
let inCarica: (() => void) | null = null;

/**
 * Arma il guardiano: il prossimo `click` (in CATTURA, quindi prima di chiunque
 * lo aspetti) viene fermato e il guardiano si disarma da solo.
 *
 * Ritorna il disarmo esplicito — usato dal riarmo e dai test.
 */
export function swallowNextClick(deps: SwallowDeps = defaultDeps()): () => void {
  inCarica?.();
  const { host, schedule } = deps;
  let disarmato = false;
  let annullaAttesa: (() => void) | null = null;

  const disarma = () => {
    if (disarmato) return;
    disarmato = true;
    host.removeEventListener('click', mangia, { capture: true });
    annullaAttesa?.();
    annullaAttesa = null;
    if (inCarica === disarma) inCarica = null;
  };

  function mangia(e: SwallowableEvent) {
    e.stopPropagation();
    e.preventDefault();
    disarma();
  }

  host.addEventListener('click', mangia, { capture: true });
  annullaAttesa = schedule(disarma, GUARDIA_MS);
  inCarica = disarma;
  return disarma;
}
