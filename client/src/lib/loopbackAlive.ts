/**
 * «Su questa porta locale c'è ancora qualcuno?» — lato client.
 *
 * Il browser non può sondare una porta da solo (una fetch verso `http://` da
 * una pagina servita altrove viene bloccata prima ancora di partire, e comunque
 * non distinguerebbe «rifiutata» da «CORS»), quindi la domanda va al server:
 * `/api/browsers/port-listening` fa un TCP connect e basta.
 *
 * In caso di dubbio si risponde `true`. Un falso «è morta» è il danno peggiore:
 * parcheggerebbe una scheda viva e farebbe sembrare rotto il pannello. Un falso
 * «è viva» al massimo ci fa provare a caricare, che è il comportamento di
 * sempre.
 */
import { isLoopbackUrl } from '../components/Browser/navErrorMessage';

/**
 * Oltre questo, si smette di aspettare e si prova a caricare.
 *
 * La risposta arriva da loopback in pochi millisecondi, ma la chiamata passa
 * comunque dal server di Topics: se quello è impallato o sta ripartendo, senza
 * un tetto qui la pane resterebbe per sempre su «Initializing native browser…»
 * — cioè una sonda pensata per evitare un fastidio diventerebbe un blocco.
 */
const PROBE_TIMEOUT_MS = 1500;

export async function loopbackAlive(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  if (!isLoopbackUrl(url)) return true;
  const ctrl = new AbortController();
  // Una corsa, non solo il segnale di abort: il tetto deve valere anche se la
  // fetch non onora l'abort (uno stub nei test, un polyfill).
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bail = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => { ctrl.abort(); resolve(true); }, timeoutMs);
  });
  const ask = (async () => {
    try {
      const res = await fetch(`/api/browsers/port-listening?url=${encodeURIComponent(url)}`, { signal: ctrl.signal });
      if (!res.ok) return true;
      const body = (await res.json()) as { listening?: boolean };
      return body.listening !== false;
    } catch {
      return true;
    }
  })();
  try {
    return await Promise.race([ask, bail]);
  } finally {
    clearTimeout(timer);
  }
}
