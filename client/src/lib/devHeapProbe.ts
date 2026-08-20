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
 *   (ricaricare la finestra, poi lasciarla ferma quindici minuti)
 *   curl -sk https://localhost:3333/api/ui-state/dev-heap-probe-result
 *
 * Ogni campione porta anche un CENSIMENTO DEL DOM (`dom`): quanti `<svg>` sono
 * vivi e sotto quale `data-testid` stanno. I proprietari registrati dicono chi
 * tiene la heap JS; il censimento dice chi tiene i layer del compositore, che
 * la heap JS non vede. Vedi `domCensus`.
 */

import { collectFeatureWeights } from './featureWeight';

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


/** Il censimento del DOM: quanti `<svg>` ci sono, e sotto CHI stanno. */
export interface DomCensus {
  /** `document.querySelectorAll('svg').length`, il numero della barra. */
  svg: number;
  /** Nodi totali: serve a distinguere "crescono gli svg" da "cresce tutto". */
  nodes: number;
  /**
   * Quanti `<svg>` per proprietario, decrescente. Il proprietario e' il
   * `data-testid` piu' vicino risalendo, o il nome della classe del padre
   * quando non c'e' nessun testid: il totale dice CHE cresce, questo dice CHI.
   */
  perOwner: Record<string, number>;
}

/** Quanti proprietari tenere: la coda lunga e' rumore, la testa e' la diagnosi. */
const TOP_OWNERS = 12;

/**
 * Conta gli `<svg>` vivi nel documento e li raggruppa per proprietario.
 *
 * PERCHE' IL CONTEGGIO E NON IL PESO. Ogni `<svg>` promosso si porta dietro un
 * layer CoreAnimation con backing IOSurface, e quel backing NON sta nella heap
 * JS: e' invisibile a `heap` e a `vmmap`, si vede solo da `footprint`. Quindi la
 * grandezza da sorvegliare non e' un numero di byte che non possiamo leggere da
 * qui, e' il CONTEGGIO dei nodi, che possiamo leggere esattamente.
 *
 * A schermo fermo questo numero deve essere PIATTO. Se sale, qualcuno monta
 * icone e non le smonta, e `perOwner` dice chi.
 */
export function domCensus(doc: Document | undefined = globalThis.document): DomCensus {
  if (!doc) return { svg: 0, nodes: 0, perOwner: {} };
  const svgs = doc.querySelectorAll('svg');
  const perOwner = new Map<string, number>();
  for (const el of svgs) {
    const owner = el.closest('[data-testid]')?.getAttribute('data-testid');
    // Senza testid il nome della classe del padre e' la traccia meno peggio:
    // non identifica il componente, ma raggruppa le occorrenze dello stesso.
    const key = owner ?? `class:${el.parentElement?.className || '?'}`.slice(0, 80);
    perOwner.set(key, (perOwner.get(key) ?? 0) + 1);
  }
  const top = [...perOwner.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_OWNERS);
  return {
    svg: svgs.length,
    nodes: doc.getElementsByTagName('*').length,
    perOwner: Object.fromEntries(top),
  };
}

/**
 * Misura tutti i proprietari registrati. Esportata per i test e per la console.
 *
 * IL REGISTRO NON E' PIU' QUI. Questa sonda aveva il suo elenco di proprietari,
 * e `lib/featureWeight.ts` ne ha uno per l'inventario mostrato all'utente: due
 * elenchi della stessa cosa divergono al primo che ne aggiorna uno solo, e il
 * modo in cui divergono e' silenzioso (una voce che manca sembra una voce a
 * zero). Adesso ce n'e' uno, e questa sonda ne e' un LETTORE.
 *
 * Cosa cambia per chi la usava: niente nella forma del risultato. Le voci sono
 * le stesse `{entries, items, bytes, detail}` di prima, piu' quelle che
 * l'inventario ha aggiunto — che e' il punto: la diagnosi vede tutto cio' che
 * vede l'utente, e non un sottoinsieme deciso mesi fa.
 */
export function collectHeapReport(): Record<string, HeapReport & { error?: string }> {
  const out: Record<string, HeapReport & { error?: string }> = {};
  for (const v of collectFeatureWeights()) {
    out[v.id] = v.errore
      // `entries: -1` era gia' la convenzione di questa sonda per «non
      // misurato»: si conserva, perche' i risultati vecchi si confrontano con
      // i nuovi e cambiarla farebbe leggere un errore come un conteggio.
      ? { entries: -1, error: v.errore }
      : { entries: v.peso.entries, items: v.peso.items, bytes: v.peso.bytes, detail: v.peso.detail };
  }
  return out;
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

/**
 * Ogni quanto campionare, e per quante volte.
 *
 * Trentuno campioni a mezzo minuto fanno QUINDICI MINUTI, che e' la finestra
 * chiesta dalla barra: il primo campione e' il T0 e l'ultimo il T15, dallo
 * stesso comando e sulla stessa finestra tenuta ferma. Con dieci campioni la
 * misura durava cinque minuti, e a cinque al minuto un delta di venticinque
 * nodi si confonde col rumore di un paio di render.
 */
const SAMPLE_EVERY_MS = 30_000;
const SAMPLES = 31;

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
    const series: { at: string; dom: DomCensus; owners: Record<string, HeapReport> }[] = [];
    let n = 0;
    const tick = (): void => {
      series.push({ at: new Date().toISOString(), dom: domCensus(), owners: collectHeapReport() });
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
