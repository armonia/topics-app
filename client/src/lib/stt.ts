/**
 * Il lato client della trascrizione: una porta sola per `/api/stt`.
 *
 * Prima ce n'erano due mezze — `useVoiceCall` con la sua `fetch` privata, e la
 * dettatura che non passava di qui affatto perché usava la Web Speech API del
 * browser. Quella API è una feature di **Safari**, non del motore WebKit: dentro
 * una WKWebView (cioè dentro il guscio Tauri, cioè nella app desktop) e dentro
 * WebView2 su Windows `webkitSpeechRecognition` è `undefined`. Risultato: la voce
 * «Dictation mode» del menu non compariva proprio, e nessuno sapeva perché.
 *
 * Con la trascrizione sul server la dettatura funziona ovunque funzioni il
 * microfono, con i modelli allo stato dell'arte invece di quello che il browser
 * si porta dietro.
 */

// Le forme del filo vivono in shared/: qui si ri-esportano perché i callsite del
// client importino da un posto solo, non perché siano dichiarate due volte.
import type { SttCapabilities, SttResult } from '../../../shared/stt';
export type { SttProviderId, SttProviderStatus, SttCapabilities, SttResult } from '../../../shared/stt';

const UNAVAILABLE: SttCapabilities = { available: false, provider: null, model: null, providers: [], language: null };

/**
 * Una sonda per sessione, non una per pannello: ogni ChatPane monta la dettatura,
 * e senza questa memoria aprire dieci topic significava dieci richieste identiche
 * a un endpoint che risponde con la stessa riga di configurazione.
 */
let capabilitiesPromise: Promise<SttCapabilities> | null = null;

export function fetchSttCapabilities(): Promise<SttCapabilities> {
  if (!capabilitiesPromise) {
    capabilitiesPromise = fetch('/api/stt/capabilities', { credentials: 'same-origin' })
      .then(r => (r.ok ? r.json() as Promise<SttCapabilities> : UNAVAILABLE))
      // Server vecchio (404) o irraggiungibile: «non disponibile» è la risposta
      // giusta, e il chiamante ha già la sua strada di ripiego.
      .catch(() => UNAVAILABLE);
  }
  return capabilitiesPromise;
}

/** Da usare quando la configurazione può essere cambiata sotto (es. dopo un restart del server). */
export function resetSttCapabilities(): void {
  capabilitiesPromise = null;
}

export class SttRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'SttRequestError';
  }
}

/**
 * Manda l'audio a `/api/stt` e restituisce la trascrizione. Il `filename` conta:
 * i provider leggono l'estensione per scegliere il decoder, e un `.webm` che
 * dentro è AAC (Safari) viene rifiutato.
 */
export async function transcribeAudio(blob: Blob, opts: { filename?: string; language?: string } = {}): Promise<SttResult> {
  const filename = opts.filename ?? `dictation.${extForMime(blob.type)}`;
  const form = new FormData();
  form.append('audio', blob, filename);
  if (opts.language) form.append('language', opts.language);

  const resp = await fetch('/api/stt', { method: 'POST', body: form, credentials: 'same-origin' });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    let message = text || resp.statusText;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed?.error) message = parsed.error;
    } catch { /* corpo non-JSON: resta il testo grezzo */ }
    throw new SttRequestError(message, resp.status);
  }
  return resp.json() as Promise<SttResult>;
}

/**
 * L'ordine è deliberato e NON va messo in ordine di qualità: mp4/AAC per primo
 * perché WebKit (Safari, e quindi ogni WKWebView del guscio desktop) non SUONA
 * l'audio in container WebM. Una nota vocale registrata in webm sarebbe muta
 * proprio nella app in cui è stata registrata. Chi non ha mp4 (Firefox) prende
 * Opus, che tutti i provider di trascrizione accettano comunque.
 */
const MIME_PREFERENCE = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'];

export function pickRecorderMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const type of MIME_PREFERENCE) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

export function extForMime(mimeType: string): string {
  if (mimeType.includes('mp4')) return 'm4a';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('wav')) return 'wav';
  return 'webm';
}

/**
 * Soglia sotto la quale una registrazione non contiene parlato: un avvio/stop
 * accidentale produce zero chunk o un header di container senza audio dentro.
 * Opus a ~24 kbps la supera in meno di mezzo secondo, quindi nessuna nota vera
 * viene scartata.
 */
export const MIN_VOICE_BLOB_BYTES = 512;

/** Vincoli del microfono buoni per il parlato: mono, con la catena di pulizia del browser accesa. */
export const SPEECH_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

/** Abbastanza per il parlato, abbastanza poco perché 40 secondi restino sotto i 300 KB. */
export const SPEECH_BITS_PER_SECOND = 48_000;

/** Il messaggio da mostrare quando `getUserMedia` dice di no. */
export function micErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError' || /NotAllowed|Permission|denied/i.test(msg)) {
    return 'Microfono negato: autorizzalo nelle impostazioni di sistema/browser.';
  }
  if (name === 'NotFoundError' || /NotFound|Requested device/i.test(msg)) {
    return 'Nessun microfono trovato.';
  }
  if (/secure|insecure|https/i.test(msg)) {
    return 'Microfono non disponibile: serve HTTPS (o il permesso è stato negato).';
  }
  return `Registrazione non partita: ${msg}`;
}
