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
export type { SttCapabilities, SttResult } from '../../../shared/stt';

const UNAVAILABLE: SttCapabilities = { available: false, provider: null, model: null, providers: [], language: null };

/**
 * Una sonda per sessione, non una per pannello: ogni ChatPane monta la dettatura,
 * e senza questa memoria aprire dieci topic significava dieci richieste identiche
 * a un endpoint che risponde con la stessa riga di configurazione.
 *
 * SI RICORDA SOLO IL SI'. Un «no» viene dimenticato, e non è pignoleria:
 * `/api/stt/capabilities` sta dietro l'identità, quindi su un dispositivo
 * appena arrivato in rete risponde `401 device not paired` finché
 * l'accoppiamento non è concluso. Con la vecchia memoria quel 401 diventava la
 * risposta DEFINITIVA della sessione: `isSupported` restava falso, il bottone
 * del microfono non si disegnava affatto, e non c'era nessun gesto capace di
 * farlo tornare — solo un ricarico della pagina. È «in locale non funziona il
 * microfono», e la parte che lo rendeva difficile da credere è che il server
 * trascriveva benissimo (misurato: `POST /api/stt` risponde in 5,2s con
 * whisper.cpp).
 *
 * Ricordare il sì e dimenticare il no costa, al massimo, una fetch in più per
 * pannello mentre il dispositivo non è ancora dentro; il contrario costa la
 * funzione, in silenzio, fino al prossimo ricarico.
 */
let capabilitiesPromise: Promise<SttCapabilities> | null = null;

export function fetchSttCapabilities(): Promise<SttCapabilities> {
  if (!capabilitiesPromise) {
    capabilitiesPromise = fetch('/api/stt/capabilities', { credentials: 'same-origin' })
      .then(r => {
        if (r.ok) return r.json() as Promise<SttCapabilities>;
        // Server vecchio (404), non ancora appaiati (401), server che riparte
        // (5xx): «non disponibile» è la risposta giusta ADESSO, non per sempre.
        capabilitiesPromise = null;
        return UNAVAILABLE;
      })
      .catch(() => {
        // Rete giù mentre la pagina si monta: idem, si riproverà.
        capabilitiesPromise = null;
        return UNAVAILABLE;
      });
  }
  return capabilitiesPromise;
}

/** Dimentica la sonda: la usa chi SA che qualcosa è cambiato (l'accoppiamento
 *  è andato a buon fine), invece di aspettare un tentativo naturale. */
export function forgetSttCapabilities(): void {
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

/**
 * Cosa si dice a chi ha appena parlato e non ha ottenuto niente.
 *
 * Una frase sola, in un posto solo, perche' i due microfoni della app (la chat
 * e il campo task della board) hanno lo stesso guasto e devono dare la stessa
 * risposta. Erano due rami separati e ne parlava UNO: `fe635287` ha fatto
 * parlare la chat e ha lasciato muta la board, quindi dallo stesso difetto
 * uscivano due esperienze diverse.
 *
 * I DUE NUMERI SONO LA DIAGNOSI, e per questo stanno nel messaggio invece che in
 * un `console.warn` che su un telefono non legge nessuno:
 *  · ZERO spezzoni = il microfono non ha aperto affatto (permesso negato senza
 *    dirlo, traccia muta, registratore mai partito);
 *  · pochi byte in uno spezzone = ha aperto e ha prodotto la sola intestazione
 *    del contenitore, cioe' ha registrato silenzio.
 * Sono due guasti diversi e si riparano in due posti diversi: senza i numeri,
 * chi legge «non funziona» non puo' saperlo.
 */
/**
 * La stessa notizia, ma al SERVER.
 *
 * Il messaggio a schermo lo legge chi sta guardando in quel momento; su un
 * telefono il toast sparisce e chi lo legge non e' chi ripara. Questa riga
 * invece resta nel log del server, ed e' il motivo per cui il difetto «il
 * vocale non parte» e' rimasto senza diagnosi: il guasto succede PRIMA della
 * richiesta di trascrizione, quindi il server non ne sapeva niente. Misurato
 * su 300 avvii: 27 richieste di capabilities e zero caricamenti di audio.
 *
 * Non aspetta la risposta e non rompe niente se fallisce: e' una segnalazione,
 * e una segnalazione che fa danno e' peggio del silenzio che voleva togliere.
 */
export function segnalaNotaVuota(spezzoni: number, byte: number, mimeType: string, superficie: string): void {
  try {
    void fetch('/api/stt/vuota', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spezzoni, byte, mimeType, superficie }),
      keepalive: true,
    }).catch(() => { /* il log e' un di piu': non deve poter rompere la app */ });
  } catch { /* idem */ }
}

export function messaggioNotaVuota(spezzoni: number, byte: number, mimeType: string): string {
  return `Nota vocale vuota: ${spezzoni} spezzoni, ${byte} byte in ${mimeType || 'formato ignoto'}. Niente da trascrivere.`;
}

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
