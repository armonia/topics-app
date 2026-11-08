/**
 * Il registro delle richieste di rete di una pane del browser.
 *
 * PERCHÉ. Davanti a «il bottone non fa niente» un agente oggi può guardare due
 * cose: la console e i pixel. Non la chiamata che è partita, non il 401, non il
 * payload sbagliato — cioè non la cosa che quasi sempre È il difetto. È il
 * divario più costoso rispetto a chrome-devtools-mcp, e quello che cambia cosa
 * un agente riesce a CAPIRE, non quanto in fretta fa ciò che già sa fare
 * (`docs/chrome-devtools-mcp-vs-topics-browser.md`, voce 1).
 *
 * PERCHÉ IL FILTRO È LA PARTE SERIA. Una pagina qualsiasi fa centinaia di
 * richieste: immagini, font, telemetria. Restituirle tutte è un muro di token
 * che costa più di quanto informi, e l'agente smette di guardarle proprio quando
 * servirebbero. Il default qui è quindi RESTRITTIVO — solo le chiamate di dati
 * (xhr/fetch/document) — e l'ampiezza si chiede, non si subisce.
 *
 * Puro: nessun accesso a Playwright. Chi registra sono i listener in
 * `browser-service.ts`; qui c'è la forma del dato, il buffer limitato e la
 * selezione — le tre cose che vale la pena provare.
 */

/** Una richiesta osservata. `status` assente ⇒ ancora in volo o fallita. */
export interface NetworkEntry {
  /** Millisecondi epoch di quando la richiesta è partita. */
  startedAt: number;
  method: string;
  url: string;
  /** Il tipo dichiarato da Chromium: `xhr`, `fetch`, `document`, `image`, … */
  resourceType: string;
  status?: number;
  /** Millisecondi fra richiesta e risposta, quando la risposta è arrivata. */
  durationMs?: number;
  /** Il motivo del fallimento, per le richieste che non hanno mai risposto. */
  failure?: string;
}

/** Quante richieste si tengono per pane. Oltre, si buttano le più vecchie. */
export const MAX_NETWORK_ENTRIES = 500;

/**
 * I tipi che di default interessano: quelli che portano DATI. Immagini, font,
 * fogli di stile e media sono rumore per una diagnosi, e sono anche il 90% del
 * volume.
 */
export const DATA_RESOURCE_TYPES = new Set(["xhr", "fetch", "document", "websocket", "eventsource"]);

/**
 * Aggiunge una richiesta al registro, buttando la più vecchia quando è pieno.
 * Muta l'array di proposito: è un buffer, non un valore.
 */
export function pushNetworkEntry(buf: NetworkEntry[], entry: NetworkEntry, max = MAX_NETWORK_ENTRIES): void {
  buf.push(entry);
  if (buf.length > max) buf.splice(0, buf.length - max);
}

/**
 * Chiude una richiesta con l'esito. Cerca dal FONDO perché la stessa URL può
 * comparire più volte e quella che sta rispondendo è quasi sempre l'ultima
 * partita — e perché una pagina attiva ha centinaia di voci davanti.
 */
export function completeNetworkEntry(
  buf: NetworkEntry[],
  url: string,
  outcome: { status?: number; failure?: string; at: number },
): void {
  for (let i = buf.length - 1; i >= 0; i--) {
    const e = buf[i]!;
    if (e.url !== url || e.status != null || e.failure != null) continue;
    if (outcome.status != null) e.status = outcome.status;
    if (outcome.failure != null) e.failure = outcome.failure;
    e.durationMs = Math.max(0, outcome.at - e.startedAt);
    return;
  }
}

export interface NetworkFilter {
  /** Sottostringa dell'URL (senza distinzione fra maiuscole e minuscole). */
  urlContains?: string;
  /** Tipi di risorsa da includere. Assente ⇒ solo quelli che portano dati. */
  types?: string[];
  /** Solo ciò che è andato storto: stato ≥ 400, oppure fallita del tutto. */
  onlyFailures?: boolean;
  /** Quante restituirne, dalla più recente. */
  limit?: number;
}

/** Una richiesta è «andata storta»? Include quelle mai risposte. */
export function isFailure(e: NetworkEntry): boolean {
  if (e.failure) return true;
  return e.status != null && e.status >= 400;
}

/**
 * Seleziona le richieste da mostrare. **Le più recenti**, non le prime: quando
 * un agente chiede della rete sta guardando ciò che ha appena fatto.
 */
export function filterNetwork(entries: readonly NetworkEntry[], f: NetworkFilter = {}): NetworkEntry[] {
  const types = f.types && f.types.length ? new Set(f.types.map((t) => t.toLowerCase())) : null;
  const needle = f.urlContains?.toLowerCase();
  const out: NetworkEntry[] = [];
  for (const e of entries) {
    if (f.onlyFailures && !isFailure(e)) continue;
    if (types) {
      if (!types.has(e.resourceType.toLowerCase())) continue;
    } else if (!DATA_RESOURCE_TYPES.has(e.resourceType.toLowerCase())) {
      continue;
    }
    if (needle && !e.url.toLowerCase().includes(needle)) continue;
    out.push(e);
  }
  const limit = f.limit != null && f.limit > 0 ? f.limit : 50;
  return out.slice(-limit);
}

/**
 * Il riassunto in una riga. Serve a rendere onesta una risposta corta: «10 di
 * 347» dice che si sta guardando una fetta, «10 di 10» che non manca niente.
 */
export function summarizeNetwork(all: readonly NetworkEntry[], shown: readonly NetworkEntry[]): {
  shown: number;
  matched: number;
  recorded: number;
  failures: number;
} {
  return {
    shown: shown.length,
    matched: shown.length,
    recorded: all.length,
    failures: all.reduce((n, e) => n + (isFailure(e) ? 1 : 0), 0),
  };
}
