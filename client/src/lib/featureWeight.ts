/**
 * L'INVENTARIO DEL PESO PER FUNZIONALITA': cosa dentro Topics tiene la memoria.
 *
 * LA DOMANDA CHE RISPONDE, e perche' non e' quella del tooltip per-tab. La barra
 * dice quanto pesa Topics in tutto; `paneUsage.ts` dice quanto pesa una SCHEDA
 * che possiede un processo. Resta scoperta la domanda che uno si fa davanti a
 * «1,8 GB»: **cosa dentro Topics lo tiene**. Ci sono cose che pesano senza avere
 * ne' una tab ne' un processo — i task della kanban caricati, le anteprime dei
 * topic, la coda dei turni, la cronologia dei siti.
 *
 * IL FATTO MISURATO CHE DECIDE LA FORMA. Il 2026-08-20, sull'app viva: lo stato
 * JS dichiarato dai proprietari registrati era **0,2 MB**, il processo renderer
 * ne teneva **440**. Cioe' lo stato JS di una funzionalita' NON E' dove sta il
 * suo peso. Un inventario che sommasse `JSON.stringify().length` e lo
 * presentasse come «quanto pesa la kanban» mostrerebbe 0,1 MB su 440: un numero
 * vero e irrilevante, con l'aria di essere la risposta.
 *
 * DA QUI LE DUE NATURE, che non si sommano mai:
 *
 *  · MISURATO — MB veri, da un processo reale (sessioni terminale, pane browser,
 *    lato server). Stesse unita' della status bar.
 *  · TRATTENUTO — CONTEGGI esatti di stato che vive nel renderer condiviso, dove
 *    nessuna lettura di sistema puo' separare il costo di due funzionalita'.
 *
 * Non esiste un totale che le comprenda entrambe, e non e' una svista: non
 * esiste l'unita' in cui quella somma avrebbe senso. Convertire un conteggio in
 * MB per poterlo sommare sarebbe inventare il numero — lo stesso divieto che
 * RES-ATTR-05 applica gia' alle pane senza processo proprio.
 *
 * PERCHE' I CONTEGGI VALGONO COMUNQUE. Sono ESATTI, non stimati, e rispondono
 * alla domanda che rende cara una funzionalita': «questa cosa cresce e nessuno
 * la pota?». Un numero di byte indovinato non la risponde; «4.312 messaggi in
 * memoria su 3 chat» si'.
 *
 * COSTO A RIPOSO: zero. Le funzioni dei proprietari girano SOLO quando qualcuno
 * guarda (hover, o dropdown aperto). Stessa regola di RES-ATTR-04, per cui il
 * costo della misura non deve crescere col numero di cose misurate.
 */

/** Come si legge il peso di questa voce. Un'unione chiusa, non un booleano: il
 *  tipo stesso deve impedire di sommare MB e conteggi. */
export type NaturaPeso = 'misurato' | 'trattenuto';

/** Cosa una funzionalita' dichiara di tenere. */
export interface PesoDichiarato {
  /** Voci di primo livello: chat aperte, task caricati, tab, sessioni. */
  entries: number;
  /** Elementi dentro quelle voci: messaggi, righe, turni in coda. */
  items?: number;
  /** SOLO per `misurato`: MB che vengono da un processo reale.
   *  Su una voce `trattenuto` viene ignorato — vedi `pesoDaVoce`. */
  memoryMB?: number;
  /** SOLO per `misurato`: quanti processi. */
  processCount?: number;
  /** Stima in byte dello stato JS. Approssimata per costruzione: serve
   *  all'ordinamento fra voci trattenute, MAI mostrata come una misura. */
  bytes?: number;
  /** Dettaglio libero, per la diagnosi (la voce piu' grossa, la piu' vecchia). */
  detail?: Record<string, unknown>;
}

/** Una voce dell'inventario, dopo la raccolta. */
export interface VocePeso {
  /** Chiave stabile del proprietario. Identifica, non si mostra. */
  id: string;
  /** Come la chiama chi usa l'app. Non il nome del modulo che la implementa:
   *  «Le tue schede», non `pane.store`. */
  label: string;
  natura: NaturaPeso;
  peso: PesoDichiarato;
  /** Il proprietario e' esploso: NON MISURATO, che non e' zero. */
  errore?: string;
}

interface Proprietario {
  label: string;
  natura: NaturaPeso;
  report: () => PesoDichiarato;
}

const proprietari = new Map<string, Proprietario>();

/**
 * Dichiara di possedere stato che vale la pena contare.
 *
 * Da chiamare in un effetto, con la de-registrazione nella cleanup. Il costo a
 * riposo e' una voce in una Map: `report` viene invocata solo dalla raccolta.
 *
 * Registrare due volte lo stesso `id` SOSTITUISCE, e non e' un caso limite: in
 * React StrictMode ogni effetto gira due volte, e una Map che accumulasse
 * duplicati conterebbe la stessa funzionalita' due volte in sviluppo e una in
 * produzione — cioe' un inventario che dice numeri diversi a seconda di dove
 * gira, che e' peggio di non averlo.
 */
export function registerFeatureWeight(
  id: string,
  label: string,
  natura: NaturaPeso,
  report: () => PesoDichiarato,
): () => void {
  proprietari.set(id, { label, natura, report });
  return () => {
    // Solo se e' ancora LA NOSTRA: fra la registrazione e questa cleanup un
    // altro montaggio puo' aver sostituito la voce (StrictMode, o due istanze
    // dello stesso componente), e cancellarla toglierebbe dall'inventario una
    // funzionalita' viva.
    if (proprietari.get(id)?.report === report) proprietari.delete(id);
  };
}

/** Quanto una voce «pesa», per l'ORDINAMENTO soltanto.
 *
 *  Non e' un numero da mostrare e non ha un'unita': serve a decidere quale riga
 *  va per prima. Le due nature si ordinano ciascuna dentro la propria, quindi
 *  questi valori non si confrontano mai fra nature diverse. */
function pesoDaVoce(v: VocePeso): number {
  if (v.errore) return -1;
  if (v.natura === 'misurato') return v.peso.memoryMB ?? 0;
  // Trattenuto: i byte stimati quando ci sono, altrimenti gli elementi, che
  // e' comunque un conteggio esatto.
  return v.peso.bytes ?? v.peso.items ?? v.peso.entries;
}

/** Una voce e' vuota quando non tiene niente: non compare. Un elenco di
 *  funzionalita' a zero e' rumore che si impara a ignorare, e nasconde le due
 *  righe che contano. */
export function voceVuota(v: VocePeso): boolean {
  if (v.errore) return false; // un errore NON e' vuoto: e' «non lo sappiamo»
  const p = v.peso;
  return (p.entries || 0) === 0
    && (p.items || 0) === 0
    && (p.memoryMB || 0) === 0
    && (p.processCount || 0) === 0;
}

/**
 * Raccoglie l'inventario da tutti i proprietari registrati.
 *
 * Un proprietario che esplode non azzera gli altri: il valore di questo elenco
 * sta nel CONFRONTO fra le voci, e una voce mancante lo falsa piu' di una voce
 * dichiarata non misurata.
 *
 * Ordine: per natura (prima il misurato, che sono MB veri), poi per peso
 * decrescente, poi per `id` — cosi' due letture consecutive senza cambiamenti
 * danno lo stesso ordine invece di rimescolare una lista sotto il mouse.
 */
export function collectFeatureWeights(): VocePeso[] {
  const out: VocePeso[] = [];
  for (const [id, p] of proprietari) {
    try {
      out.push({ id, label: p.label, natura: p.natura, peso: p.report() });
    } catch (e) {
      out.push({
        id, label: p.label, natura: p.natura,
        peso: { entries: 0 },
        errore: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return ordinaVoci(out);
}

/** L'ordinamento, estratto perche' i test lo possano guidare senza registrare
 *  proprietari veri. */
export function ordinaVoci(voci: VocePeso[]): VocePeso[] {
  return [...voci].sort((a, b) => {
    if (a.natura !== b.natura) return a.natura === 'misurato' ? -1 : 1;
    const d = pesoDaVoce(b) - pesoDaVoce(a);
    if (d !== 0) return d;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** L'inventario da mostrare: le voci vuote non ci sono. */
export function inventarioVisibile(): VocePeso[] {
  return collectFeatureWeights().filter(v => !voceVuota(v));
}

/**
 * Stima in byte di uno stato serializzabile.
 *
 * E' una PROXY, non una misura: sottostima gli oggetti (niente overhead di
 * header, puntatori, forme nascoste) e sovrastima le stringhe condivise, che in
 * heap esistono una volta sola. Serve a ordinare le voci fra loro, non a dire
 * quanto pesa qualcosa — ed e' il motivo per cui `bytes` non viene mai mostrato
 * come un numero di memoria.
 */
export function roughBytes(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    // Cicli: meglio zero che far fallire la misura di tutti gli altri.
    return 0;
  }
}

/** Test seam: svuota il registro. */
export function _resetFeatureWeights(): void {
  proprietari.clear();
}

/** Test seam: quanti proprietari sono registrati adesso. */
export function _countFeatureWeightOwners(): number {
  return proprietari.size;
}
