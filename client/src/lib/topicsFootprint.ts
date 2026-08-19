/**
 * topicsFootprint: un solo calcolatore per l'utilizzo di Topics, memoria E CPU.
 *
 * PROBLEMA CHE RISOLVE:
 * Il codice precedente aveva due percorsi di calcolo separati:
 *  1. PerfSection.tsx sommava shell-footprint + server-RSS (due metriche diverse)
 *  2. SidebarStatusBar.tsx mostrava le due meta' senza sommarle
 * Risultato: numeri diversi su due superfici, e la somma non aveva senso (unita' diverse).
 * La memoria e' poi stata unificata qui, ma la PERCENTUALE era rimasta fuori:
 * due CPU distinte in barra, nessun totale. Adesso i due assi si calcolano
 * nello stesso posto e con la stessa regola.
 *
 * SOLUZIONE:
 * Un solo modulo, una sola regola, tre assi:
 *  - device: la shell e i suoi processi WKWebView (da perf_metrics Tauri, footprint)
 *  - server: il lato server e i sidecar (da fleet, footprint o rss con label)
 *  - scripts: il lavoro lanciato dagli agenti (da fleet.scriptsMB, terzo asse)
 * La somma device+server e' il "totale Topics". Scripts e' escluso dal totale.
 *
 * `null` NON E' ZERO, ed e' la regola che regge tutto il resto: una meta' non
 * misurata non vale zero, vale "non lo so". Se nessuna delle due e' misurata il
 * totale e' `null` e la superficie non scrive niente: uno "0%" li' e' uno zero
 * che sembra una misura, ed e' il caso che di solito manca.
 *
 * SMORZAMENTO:
 * Un agente che lancia `pnpm install` puo' far oscillare il totale di 700 MB in
 * 20 secondi. Si applica un EMA (Exponential Moving Average) con alpha=0.25
 * all'asse server (che e' quello volatile): il device e gli scripts vengono
 * mostrati al valore attuale, il server viene smorzato.
 *
 * SUL TELEFONO:
 * il lato dispositivo e' `null` (nessuna shell nativa, il browser non espone i
 * processi). Il totale resta il solo lato server, che e' un numero vero ma NON
 * e' il totale: `memPartial`/`cpuPartial` sono a `true` proprio li', perche' la
 * superficie lo dichiari invece di spacciare una meta' per il tutto.
 */

/** La metrica di memoria usata dal lato server. */
export type ServerMemMetric = 'footprint' | 'rss' | 'mixed';

/** Le letture grezze delle due meta', come arrivano da `usePerfMetrics` (device)
 *  e da `/api/system/status` (server). Un oggetto e non dieci parametri
 *  posizionali: meta' di questi sono numeri e scambiarne due non da' errore. */
export interface TopicsUsageInput {
  /** Memoria della shell e dei suoi processi, `null` se non misurabile. */
  deviceMB: number | null;
  deviceProcessCount: number;
  /** La lettura del dispositivo copre la sola shell (Windows/Linux). */
  devicePartial: boolean;
  /** CPU del lato dispositivo sulla scala 0-100 della macchina, `null` se non
   *  misurata (una pane appena aperta non ha ancora un delta). */
  deviceCpu: number | null;
  /** Memoria del lato server, `null` se il server non risponde. */
  serverMB: number | null;
  serverProcessCount: number;
  serverMetric: ServerMemMetric;
  /** CPU del lato server, gia' normalizzata sulla stessa scala 0-100. */
  serverCpu: number | null;
  scriptsMB: number;
  scriptsProcessCount: number;
  /** Identita' del campione (es. `status.timestamp`). Serve allo smorzamento:
   *  l'EMA avanza solo su un campione NUOVO, cosi' due superfici che leggono lo
   *  stesso stato mostrano lo stesso numero e un re-render non fa invecchiare la
   *  media. Assente = ogni chiamata e' un campione nuovo. */
  sampleKey?: string;
}

/** Il risultato del calcolatore: le due meta', i totali, e cosa manca. */
export interface TopicsFootprint {
  /** Memoria della shell e dei suoi processi (WKWebView, GPU, XPC).
   *  `phys_footprint` su macOS, stessa metrica di Monitoraggio Attivita'.
   *  `null` su telefono/browser dove non c'e' introspezione nativa. */
  deviceMB: number | null;
  /** Numero di processi nel lato dispositivo. */
  deviceProcessCount: number;
  /** CPU del lato dispositivo, scala 0-100 della macchina. `null` = non misurata. */
  deviceCpu: number | null;
  /** Memoria del lato server (Bun + sidecar pty/ai/webrtc), smorzata con EMA.
   *  Stesso footprint del lato dispositivo dove disponibile. `null` = non misurata. */
  serverMB: number | null;
  /** Numero di processi nel lato server. */
  serverProcessCount: number;
  /** CPU del lato server. `null` = non misurata. */
  serverCpu: number | null;
  /** Metrica usata per il lato server: 'footprint' = stessa del dispositivo,
   *  'rss' = stima alta (conta pagine condivise piu' volte),
   *  'mixed' = copertura parziale. */
  serverMetric: ServerMemMetric;
  /** Memoria del lavoro lanciato dagli agenti (terzo asse, escluso dal totale).
   *  es. npm install, build, test avviati dall'agente. */
  scriptsMB: number;
  scriptsProcessCount: number;
  /** Totale Topics (device + server). `null` quando nessuna delle due meta' e'
   *  misurata: non e' zero, e' "non lo so". */
  totalMB: number | null;
  /** Processi coperti dal totale (dispositivo + server). */
  totalProcessCount: number;
  /** Totale CPU (device + server) sulla stessa scala 0-100. `null` come sopra. */
  totalCpu: number | null;
  /** Il totale di memoria copre una meta' sola (o la sola shell): va detto. */
  memPartial: boolean;
  /** Lo stesso per la percentuale, con la stessa regola. */
  cpuPartial: boolean;
}

/** Stato interno per lo smorzamento EMA. Un modulo singleton: la chiamata e'
 *  sempre dallo stesso hook, quindi non servono istanze multiple. */
let _smoothedServerMB: number | null = null;
/** Il `sampleKey` gia' assorbito dall'EMA, per non contare due volte lo stesso
 *  campione (due superfici aperte insieme, un re-render di React). */
let _lastSampleKey: string | null = null;

/** Alpha per l'EMA del lato server. 0.25 su un ciclo di 5s = costante di tempo
 *  ~20s: abbastanza lenta da assorbire un `pnpm install`, abbastanza veloce da
 *  riflettere un cambio reale entro un minuto. */
const EMA_ALPHA = 0.25;

/** Reimposta lo smorzamento (utile nei test). */
export function _resetTopicsFootprintSmoothing(): void {
  _smoothedServerMB = null;
  _lastSampleKey = null;
}

/** Somma le meta' misurate. `null` solo se non ne e' misurata nessuna: e' la
 *  differenza fra "l'app e' ferma" (0) e "qui non si misura" (niente numero). */
function somma(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

/**
 * Calcola l'utilizzo di Topics unendo le letture della shell (Tauri) e del server.
 */
export function computeTopicsFootprint(input: TopicsUsageInput): TopicsFootprint {
  const {
    deviceMB, deviceProcessCount, devicePartial, deviceCpu,
    serverMB, serverProcessCount, serverMetric, serverCpu,
    scriptsMB, scriptsProcessCount, sampleKey,
  } = input;

  // Smorzamento EMA sul lato server (quello che oscilla). Una lettura mancante
  // non entra nell'EMA: smorzare contro zero farebbe scendere il valore come se
  // il server si fosse alleggerito, mentre e' solo il campione a mancare.
  const campioneNuovo = sampleKey === undefined || sampleKey !== _lastSampleKey;
  if (sampleKey !== undefined) _lastSampleKey = sampleKey;
  if (serverMB !== null && campioneNuovo) {
    _smoothedServerMB = _smoothedServerMB === null
      ? serverMB
      : Math.round(EMA_ALPHA * serverMB + (1 - EMA_ALPHA) * _smoothedServerMB);
  }
  // `?? serverMB`: se il campione era gia' stato assorbito ma l'EMA non ha
  // ancora un valore (il primo campione era una lettura mancante), si mostra il
  // grezzo invece di far sparire un numero che esiste.
  const serverSmoothedMB = serverMB === null ? null : (_smoothedServerMB ?? serverMB);

  const totalMB = somma(deviceMB, serverSmoothedMB);
  const totalCpu = somma(deviceCpu, serverCpu);

  return {
    deviceMB,
    deviceProcessCount,
    deviceCpu,
    serverMB: serverSmoothedMB,
    serverProcessCount,
    serverCpu,
    serverMetric,
    scriptsMB,
    scriptsProcessCount,
    totalMB,
    totalProcessCount: (deviceMB === null ? 0 : deviceProcessCount) + (serverSmoothedMB === null ? 0 : serverProcessCount),
    totalCpu,
    // Parziale quando una meta' manca mentre l'altra c'e' (telefono: solo
    // server), oppure quando il lato dispositivo copre la sola shell.
    memPartial: totalMB !== null && (deviceMB === null || serverSmoothedMB === null || devicePartial),
    cpuPartial: totalCpu !== null && (deviceCpu === null || serverCpu === null || devicePartial),
  };
}

/**
 * Etichetta breve per la metrica usata nel lato server.
 * Usata nei tooltip per dire "footprint" vs "RSS (stima alta)".
 */
export function serverMetricLabel(metric: ServerMemMetric): string {
  if (metric === 'footprint') return 'footprint';
  if (metric === 'mixed') return 'footprint parziale';
  return 'RSS (stima alta)';
}
