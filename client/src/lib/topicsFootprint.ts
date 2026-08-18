/**
 * topicsFootprint: un solo calcolatore per l'utilizzo di memoria di Topics.
 *
 * PROBLEMA CHE RISOLVE:
 * Il codice precedente aveva due percorsi di calcolo separati:
 *  1. PerfSection.tsx:113 sommava shell-footprint + server-RSS (due metriche diverse)
 *  2. SidebarStatusBar.tsx mostrava le due meta' senza sommarle
 * Risultato: numeri diversi su due superfici, e la somma non aveva senso (unita' diverse).
 *
 * SOLUZIONE:
 * Un solo modulo, una sola regola, tre assi:
 *  - device: la shell e i suoi processi WKWebView (da perf_metrics Tauri, footprint)
 *  - server: il lato server e i sidecar (da fleet, footprint o rss con label)
 *  - scripts: il lavoro lanciato dagli agenti (da fleet.scriptsMB, terzo asse)
 * La somma device+server e' il "totale Topics". Scripts e' escluso dal titolo.
 *
 * SMORZAMENTO:
 * Un agente che lancia `pnpm install` puo' far oscillare il totale di 700 MB in
 * 20 secondi. Si applica un EMA (Exponential Moving Average) con alpha=0.25
 * all'asse server (che e' quello volatile): il device e gli scripts vengono
 * mostrati al valore attuale, il server viene smorzato.
 *
 * SUL TELEFONO:
 * `deviceMB` e' null (nessuna shell nativa). Il totale e' solo il lato server,
 * che e' la cifra corretta: e' sempre la stessa macchina.
 */

/** Il risultato del calcolatore: tre assi piu' il totale smorzato. */
export interface TopicsFootprint {
  /** Memoria della shell e dei suoi processi (WKWebView, GPU, XPC).
   *  `phys_footprint` su macOS, stessa metrica di Monitoraggio Attivita'.
   *  `null` su telefono/browser dove non c'e' introspezione nativa. */
  deviceMB: number | null;
  /** Numero di processi nel lato dispositivo. */
  deviceProcessCount: number;
  /** Memoria del lato server (Bun + sidecar pty/ai/webrtc).
   *  Stesso footprint del lato dispositivo dove disponibile. */
  serverMB: number;
  /** Numero di processi nel lato server. */
  serverProcessCount: number;
  /** Metrica usata per il lato server: 'footprint' = stessa del dispositivo,
   *  'rss' = stima alta (conta pagine condivise piu' volte),
   *  'mixed' = copertura parziale. */
  serverMetric: 'footprint' | 'rss' | 'mixed';
  /** Memoria del lavoro lanciato dagli agenti (terzo asse, escluso dal totale).
   *  es. npm install, build, test avviati dall'agente. */
  scriptsMB: number;
  scriptsProcessCount: number;
  /** Totale Topics (device + server), smorzato con EMA per ridurre le oscillazioni.
   *  Non include scripts: quelli sono lavoro degli agenti, non costo fisso. */
  totalMB: number;
  /** Copertura parziale: true su Windows/Linux dove la shell non vede i figli
   *  WKWebView. Il client deve dire "lettura parziale" invece di presentarla
   *  come il totale. */
  partial: boolean;
}

/** Stato interno per lo smorzamento EMA. Un modulo singleton: la chiamata e'
 *  sempre dallo stesso hook, quindi non servono istanze multiple. */
let _smoothedServerMB: number | null = null;

/** Alpha per l'EMA del lato server. 0.25 su un ciclo di 5s = costante di tempo
 *  ~20s: abbastanza lenta da assorbire un `pnpm install`, abbastanza veloce da
 *  riflettere un cambio reale entro un minuto. */
const EMA_ALPHA = 0.25;

/** Reimposta lo smorzamento (utile nei test). */
export function _resetTopicsFootprintSmoothing(): void {
  _smoothedServerMB = null;
}

/**
 * Calcola il footprint di Topics unendo i dati della shell (Tauri) e del server.
 *
 * @param deviceTotalMB - footprint totale della shell in MB (da perf_metrics),
 *   null se non disponibile (web/telefono)
 * @param deviceProcessCount - numero di processi nel lato dispositivo
 * @param devicePartial - true se il numero del dispositivo copre solo la shell
 * @param fleetMemoryMB - memoria fleet del lato server in MB
 * @param fleetProcessCount - numero di processi nel lato server
 * @param fleetMetric - metrica usata dal fleet ('footprint' | 'rss' | 'mixed')
 * @param scriptsMB - memoria dei processi-script degli agenti
 * @param scriptsProcessCount - numero di processi-script
 */
export function computeTopicsFootprint(
  deviceTotalMB: number | null,
  deviceProcessCount: number,
  devicePartial: boolean,
  fleetMemoryMB: number,
  fleetProcessCount: number,
  fleetMetric: 'footprint' | 'rss' | 'mixed',
  scriptsMB: number,
  scriptsProcessCount: number,
): TopicsFootprint {
  // Smorzamento EMA sul lato server (quello che oscilla).
  if (_smoothedServerMB === null) {
    _smoothedServerMB = fleetMemoryMB;
  } else {
    _smoothedServerMB = Math.round(EMA_ALPHA * fleetMemoryMB + (1 - EMA_ALPHA) * _smoothedServerMB);
  }

  const serverMB = _smoothedServerMB;
  const totalMB = deviceTotalMB !== null
    ? deviceTotalMB + serverMB
    : serverMB;

  return {
    deviceMB: deviceTotalMB,
    deviceProcessCount,
    serverMB,
    serverProcessCount: fleetProcessCount,
    serverMetric: fleetMetric,
    scriptsMB,
    scriptsProcessCount,
    totalMB,
    partial: devicePartial,
  };
}

/**
 * Etichetta breve per la metrica usata nel lato server.
 * Usata nei tooltip per dire "footprint" vs "RSS (stima alta)".
 */
export function serverMetricLabel(metric: 'footprint' | 'rss' | 'mixed'): string {
  if (metric === 'footprint') return 'footprint';
  if (metric === 'mixed') return 'footprint parziale';
  return 'RSS (stima alta)';
}
