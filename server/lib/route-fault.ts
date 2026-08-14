/**
 * Ritardo SINTETICO su una rotta, per far diventare rosso il cancello sulle
 * latenze (`bun run check:rotte`).
 *
 * PERCHE' esiste. Un cancello che non si e' mai visto fallire non e' un
 * cancello: e' una riga di CI che dice sempre di si'. Per le soglie di byte
 * (`scripts/check-bundle-size.ts`) il rosso si costruisce con una fixture, un
 * file finto che pesa troppo. Per una latenza no: il numero non nasce da un
 * file, nasce dal server mentre risponde. L'unico modo di provare che il
 * cancello sa dire "questa rotta e' peggiorata" e' peggiorare DAVVERO una
 * rotta, e poi rimetterla a posto.
 *
 * Abbassare la soglia nella baseline non lo prova: dimostrerebbe che il
 * confronto sa fare una sottrazione, non che la MISURA vede il rallentamento.
 * Sono due guasti diversi, e quello che fa passare una regressione vera e' il
 * secondo (una misura che guarda il posto sbagliato resta verde per sempre).
 *
 * PERCHE' non puo' toccare la produzione. Due condizioni, non una:
 *   1. `TOPICS_E2E=1`, che esiste SOLO nel server di prova
 *      (`scripts/start-test-server.sh` e' l'unico posto che lo esporta, come
 *      gia' fa per le rotte distruttive di `/api/test/*`);
 *   2. `TOPICS_ROTTE_FAULT_MS` con un numero positivo.
 * Il server di produzione non ha ne' l'una ne' l'altra, quindi qui
 * {@link ROUTE_FAULT} vale `null` e il chiamante non arriva nemmeno a chiamare
 * la funzione: e' un test di verita' su una costante letta una volta al
 * caricamento del modulo, non una lettura di `process.env` per richiesta.
 *
 * Uso:
 *   TOPICS_ROTTE_FAULT_MS=40 bun run scripts/check-rotte.ts
 *   TOPICS_ROTTE_FAULT_MS=40 TOPICS_ROTTE_FAULT_PATH=/api/all-boards/tasks …
 */

export interface RouteFault {
  /** Millisecondi di attesa aggiunti alla rotta. */
  delayMs: number;
  /** Prefisso del path colpito: tutto cio' che inizia cosi' rallenta. */
  pathPrefix: string;
}

/** Legge l'armamento dall'ambiente. Esportata pura per i test. */
export function readRouteFault(env: Record<string, string | undefined>): RouteFault | null {
  // Il primo cancello e' l'ambiente di prova, non il ritardo: cosi' una
  // variabile lasciata per sbaglio in una shell non puo' rallentare nulla di
  // vivo.
  if (env.TOPICS_E2E !== "1") return null;
  const delayMs = Number(env.TOPICS_ROTTE_FAULT_MS);
  if (!Number.isFinite(delayMs) || delayMs <= 0) return null;
  const pathPrefix = env.TOPICS_ROTTE_FAULT_PATH || "/api/topics";
  return { delayMs, pathPrefix };
}

/**
 * Letta UNA volta al caricamento del modulo. Il server la usa come interruttore
 * sincrono (`if (ROUTE_FAULT) await applyRouteFault(...)`), cosi' quando e'
 * spenta il costo per richiesta e' un confronto con `null` e non una promessa
 * allocata a vuoto.
 */
export const ROUTE_FAULT: RouteFault | null = readRouteFault(process.env);

/** Aspetta, se questo path e' quello colpito. */
export async function applyRouteFault(pathname: string, fault: RouteFault | null = ROUTE_FAULT): Promise<void> {
  if (!fault) return;
  if (!pathname.startsWith(fault.pathPrefix)) return;
  await new Promise((r) => setTimeout(r, fault.delayMs));
}
