/**
 * Sonda di memoria del renderer: CHI tiene la heap, misurato invece che dedotto.
 *
 * PERCHE' ESISTE. Il 2026-07-29 il processo WebContent della finestra principale
 * teneva **1844 MB** — il 58% dei 3,2 GB dell'intera app — con la curva PIATTA
 * (misurata su cinque minuti: 3,18 / 3,25 / 3,22 / 3,15 / 3,16 / 3,15 GB). Non
 * una crescita in corso, quindi: memoria gia' presa e mai restituita. E quel
 * processo non e' una pane browser, e' la UI React.
 *
 * Da fuori, `footprint` dice quanto ma non dice CHI. WebKit non espone
 * `performance.memory` e non c'e' un CDP a cui chiedere uno heap snapshot senza
 * aprire il Web Inspector a mano. Restava indovinare — e oggi indovinare e' gia'
 * costato due fix sbagliati: un tetto sulle pane che ha fatto crescere la memoria
 * dodici volte, e un reaper che rendeva caro ogni ⌘R.
 *
 * COME. Non prova a pesare la heap: chiede a chi possiede lo stato di
 * DICHIARARSI. Ogni proprietario registra una funzione che riporta le proprie
 * dimensioni, la sonda le somma e scrive il risultato. Le stime sono
 * approssimate per costruzione (in JS non esiste `sizeof`), ma i CONTEGGI sono
 * esatti — ed e' il conteggio che dice se qualcosa cresce senza potatura, che e'
 * la domanda vera.
 *
 * SICUREZZA. Non parte mai da sola: legge `dev-heap-probe` dallo ui-state e gira
 * solo se `{"armed": true}`. Stessa forma di `devLayoutProbe`, one-shot.
 *
 * Uso:
 *   curl -sk -X PUT https://localhost:3333/api/ui-state/dev-heap-probe \
 *        -H 'content-type: application/json' -d '{"armed":true}'
 *   (ricaricare la finestra)
 *   curl -sk https://localhost:3333/api/ui-state/dev-heap-probe-result
 */

const FLAG_KEY = 'dev-heap-probe';
const RESULT_KEY = 'dev-heap-probe-result';

/** Cosa un proprietario di stato dichiara di tenere. */
export interface HeapReport {
  /** Quante voci di primo livello (sessioni, terminali, voci di cache). */
  entries: number;
  /** Quanti elementi in totale dentro quelle voci (messaggi, righe, byte). */
  items?: number;
  /** Stima in byte. Approssimata: serve l'ordine di grandezza, non il valore. */
  bytes?: number;
  /** Qualsiasi dettaglio utile a capire (la voce piu' grossa, la piu' vecchia). */
  detail?: Record<string, unknown>;
}

const owners = new Map<string, () => HeapReport>();

/**
 * Dichiara di possedere stato che vale la pena misurare.
 *
 * Da chiamare in un effetto, con la de-registrazione nella cleanup. Il costo a
 * riposo e' una voce in una Map: la funzione viene invocata SOLO quando la sonda
 * e' armata, quindi non c'e' niente da pagare in produzione.
 */
export function registerHeapOwner(name: string, report: () => HeapReport): () => void {
  owners.set(name, report);
  return () => {
    owners.delete(name);
  };
}

/** Misura tutti i proprietari registrati. Esportata per i test e per la console. */
export function collectHeapReport(): Record<string, HeapReport & { error?: string }> {
  const out: Record<string, HeapReport & { error?: string }> = {};
  for (const [name, fn] of owners) {
    try {
      out[name] = fn();
    } catch (e) {
      // Un proprietario che esplode non deve azzerare la misura degli altri:
      // il valore di questa sonda sta nel confronto fra le voci.
      out[name] = { entries: -1, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return out;
}

/**
 * Stima in byte di un oggetto serializzabile.
 *
 * `JSON.stringify().length` e' una PROXY, non una misura: sottostima gli oggetti
 * (niente overhead di header, puntatori, forme nascoste — in WebKit un oggetto
 * piccolo costa decine di byte a prescindere dal contenuto) e sovrastima le
 * stringhe condivise, che in heap esistono una volta sola. Serve a rispondere
 * "e' un megabyte o un gigabyte", non a fare la contabilita'.
 *
 * Ritorna 0 se l'oggetto non e' serializzabile (cicli): meglio zero che far
 * fallire tutta la misura.
 */
export function roughBytes(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

async function readFlag(): Promise<boolean> {
  try {
    const r = await fetch(`/api/ui-state/${FLAG_KEY}`);
    if (!r.ok) return false;
    const body = (await r.json()) as { value?: { armed?: boolean } };
    return body?.value?.armed === true;
  } catch {
    return false;
  }
}

async function write(key: string, value: unknown): Promise<void> {
  try {
    await fetch(`/api/ui-state/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
  } catch {
    /* la sonda non deve mai far rumore se il server non risponde */
  }
}

/** Ogni quanto campionare, e per quante volte. */
const SAMPLE_EVERY_MS = 30_000;
const SAMPLES = 10;

/**
 * Avvia la sonda se armata. Ritorna una funzione di stop idempotente.
 *
 * Campiona nel TEMPO e non una volta sola: una fotografia dice quanto c'e'
 * adesso, una serie dice se cresce — e "cresce senza potatura" e' la diagnosi
 * che serve. Dieci campioni a mezzo minuto coprono cinque minuti d'uso.
 */
export function initDevHeapProbe(): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  void readFlag().then((armed) => {
    if (!armed || stopped) return;
    void write(FLAG_KEY, { armed: false }); // one-shot: mai due giri di fila
    const series: { at: string; owners: Record<string, HeapReport> }[] = [];
    let n = 0;
    const tick = (): void => {
      series.push({ at: new Date().toISOString(), owners: collectHeapReport() });
      n += 1;
      void write(RESULT_KEY, { samples: n, series });
      if (n >= SAMPLES && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    tick();
    timer = setInterval(tick, SAMPLE_EVERY_MS);
  });

  return () => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
