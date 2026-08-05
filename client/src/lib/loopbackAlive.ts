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

export async function loopbackAlive(url: string, signal?: AbortSignal): Promise<boolean> {
  if (!isLoopbackUrl(url)) return true;
  try {
    const res = await fetch(`/api/browsers/port-listening?url=${encodeURIComponent(url)}`, { signal });
    if (!res.ok) return true;
    const body = (await res.json()) as { listening?: boolean };
    return body.listening !== false;
  } catch {
    return true;
  }
}
