/**
 * Le parole mentre le dici, invece che dopo.
 *
 * PERCHE' ESISTE. La dettatura di Topics era batch: premi, parli, molli, e
 * aspetti. Anche quando il giro e' veloce (650-800 ms su una clip da 5 s con
 * Scribe v2, misurato il 04/09) restano due secondi in cui a schermo non
 * succede niente, e chi detta una frase lunga non ha modo di accorgersi che il
 * microfono ha sentito «git ribes» finche' non ha finito di parlare.
 *
 * Scribe v2 Realtime manda `partial_transcript` mentre parli e
 * `committed_transcript` quando un segmento e' stabile. Il socket lo apre il
 * CLIENT: e' lui che ha il microfono, e far transitare l'audio dal server
 * aggiungerebbe un salto a ogni pacchetto da 250 ms. La chiave pero' non deve
 * mai arrivare qui, quindi il permesso di connettersi e' un token monouso che
 * chiede il server (`POST /api/stt/realtime-token`).
 *
 * QUESTO MODULO NON SA NIENTE DEL MICROFONO. Riceve blocchi Float32 gia'
 * campionati (li produce la sonda di `livello-audio.ts`, sullo stesso
 * AudioContext) e li impacchetta in PCM 16 bit base64. Chi lo usa continua a
 * registrare col `MediaRecorder` in parallelo: se questa strada muore a meta',
 * l'audio per il flusso batch c'e' gia' tutto.
 */

import type { SttRealtimeToken } from '../../../shared/stt';

const REALTIME_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';

/**
 * I formati che il socket accetta. La lista serve a una domanda sola: il
 * contesto audio ha davvero dato la frequenza che gli abbiamo chiesto? Un
 * AudioContext puo' rispondere con la sua nativa (48 kHz e' il caso comune), e
 * dichiarare 16 kHz su campioni a 48 kHz significa trascrivere un nastro
 * accelerato di tre volte: parole vere, tutte sbagliate.
 */
const AUDIO_FORMAT_BY_RATE: Record<number, string> = {
  8000: 'pcm_8000',
  16000: 'pcm_16000',
  22050: 'pcm_22050',
  24000: 'pcm_24000',
  44100: 'pcm_44100',
  48000: 'pcm_48000',
};

/**
 * Quanti campioni si accumulano prima di spedire. 4096 a 16 kHz sono 256 ms:
 * abbastanza pochi perche' il primo parziale arrivi entro il secondo, e
 * abbastanza tanti da non trasformare una dettatura in duecento messaggi al
 * secondo (il worklet consegna blocchi da 128 campioni, cioe' 8 ms).
 */
const CHUNK_SAMPLES = 4096;

/** Oltre questo senza `session_started` la connessione si considera morta. */
const SESSION_START_TIMEOUT_MS = 5_000;

/**
 * Quanto si aspetta l'ultimo `committed_transcript` dopo lo stop. Il segmento
 * finale arriva subito dopo il commit; oltre questo tempo si chiude comunque,
 * perche' tenere aperta la striscia in attesa di una coda che non arriva e' il
 * difetto che il realtime doveva togliere, non aggiungere.
 */
const FINAL_COMMIT_WAIT_MS = 2_500;

export interface RealtimeSession {
  /** Un blocco mono di campioni float, alla frequenza dichiarata all'apertura. */
  send(frame: Float32Array): void;
  /** Chiude il segmento in corso e aspetta il suo testo, poi chiude il socket. */
  finish(): Promise<void>;
  /** Chiude subito senza commit: un annullo non paga una trascrizione. */
  abort(): void;
  /** Quanti segmenti sono stati confermati: zero e' cio' che fa scattare il batch. */
  committedCount(): number;
}

export interface RealtimeOptions {
  /** ISO-639-1 da suggerire al modello. Assente = riconoscimento automatico. */
  language?: string;
  /** La frequenza REALE del contesto audio che produce i blocchi. */
  sampleRate: number;
  /** Testo provvisorio: cambia, va mostrato in grigio e non si incolla. */
  onPartial(text: string): void;
  /** Segmento stabile: questo si incolla, e non tornera' indietro. */
  onCommitted(text: string): void;
  /**
   * Il socket e' morto mentre si parlava (rete, quota, chiave). Chiamato UNA
   * volta sola: chi ascolta torna al flusso batch con l'audio che ha gia'.
   */
  onFail(reason: string): void;
}

/** La forma dei messaggi che il socket manda indietro, ridotta a cio' che serve. */
interface ScribeMessage {
  message_type?: string;
  text?: string;
  error?: string;
  warning?: string;
}

/**
 * `null` quando il realtime non e' in offerta: il server dice di no (chiave non
 * verificata, un altro motore in testa alla catena), il browser non ha
 * WebSocket, o il contesto audio gira a una frequenza che il servizio non
 * accetta. Non e' un errore da mostrare: e' la dettatura di prima.
 */
export async function startRealtimeDictation(opts: RealtimeOptions): Promise<RealtimeSession | null> {
  if (typeof WebSocket === 'undefined') return null;
  const audioFormat = AUDIO_FORMAT_BY_RATE[opts.sampleRate];
  if (!audioFormat) return null;

  const grant = await fetchRealtimeToken();
  if (!grant) return null;

  const params = new URLSearchParams({
    model_id: grant.model,
    token: grant.token,
    audio_format: audioFormat,
    commit_strategy: 'vad',
  });
  const language = opts.language ?? grant.language ?? '';
  if (language) params.set('language_code', language);

  let socket: WebSocket;
  try {
    socket = new WebSocket(`${REALTIME_URL}?${params.toString()}`);
  } catch {
    return null;
  }

  const pending: number[] = [];
  let committed = 0;
  let dead = false;
  let started = false;
  let onFinalCommit: (() => void) | null = null;

  // UN GUASTO PRIMA DELL'AVVIO NON SI RACCONTA. Finche' `session_started` non
  // e' arrivato questa funzione non ha ancora restituito niente, e il rifiuto
  // si comunica con un `null`: chi chiama resta sul batch senza che nessuno
  // legga una riga su un socket che non ha mai trascritto niente. Dopo, invece,
  // la striscia era accesa sul realtime e il cambio di motore va detto.
  const die = (reason: string) => {
    if (dead) return;
    dead = true;
    onFinalCommit?.();
    onFinalCommit = null;
    try { socket.close(); } catch { /* gia' chiuso: non c'e' niente da fare */ }
    if (started) opts.onFail(reason);
  };

  const flush = (commit: boolean) => {
    if (dead || socket.readyState !== WebSocket.OPEN) return;
    if (pending.length === 0 && !commit) return;
    const samples = Int16Array.from(pending);
    pending.length = 0;
    socket.send(JSON.stringify({
      message_type: 'input_audio_chunk',
      audio_base_64: base64FromPcm(samples),
      commit,
      sample_rate: opts.sampleRate,
    }));
  };

  socket.onmessage = (event: MessageEvent) => {
    if (typeof event.data !== 'string') return;
    let msg: ScribeMessage;
    try { msg = JSON.parse(event.data) as ScribeMessage; } catch { return; }
    switch (msg.message_type) {
      case 'session_started':
        started = true;
        break;
      case 'partial_transcript':
        if (msg.text) opts.onPartial(msg.text);
        break;
      case 'committed_transcript': {
        const text = (msg.text ?? '').trim();
        if (text) { committed++; opts.onCommitted(text); }
        // Lo stop aspetta QUESTO: il segmento finale, non un tempo fisso.
        onFinalCommit?.();
        onFinalCommit = null;
        break;
      }
      // Ogni tipo `*_error`, piu' i rifiuti che non si chiamano cosi': quota
      // finita, termini non accettati, sessione troppo lunga. Tutti finiscono
      // allo stesso posto, che e' il flusso batch: cambia la riga di diagnosi,
      // non cosa succede a chi sta parlando.
      default:
        if (msg.error) die(`${msg.message_type ?? 'error'}: ${msg.error}`);
        break;
    }
  };

  socket.onerror = () => die('socket in errore');
  socket.onclose = (event: CloseEvent) => {
    if (dead) return;
    dead = true;
    onFinalCommit?.();
    onFinalCommit = null;
    // Una chiusura DOPO il commit finale e' la fine normale della sessione.
    if (started && committed === 0) opts.onFail(`socket chiuso (${event.code})`);
  };

  const open = await waitForOpen(socket);
  if (!open) { try { socket.close(); } catch { /* idem */ } return null; }

  // Il socket aperto non e' ancora una sessione: senza `session_started` il
  // servizio non ha accettato il token, e i campioni andrebbero nel vuoto.
  const sessionStarted = await waitFor(() => started || dead, SESSION_START_TIMEOUT_MS);
  if (!sessionStarted || dead) { try { socket.close(); } catch { /* idem */ } return null; }

  return {
    send(frame: Float32Array) {
      if (dead || socket.readyState !== WebSocket.OPEN) return;
      for (let i = 0; i < frame.length; i++) {
        const clamped = Math.max(-1, Math.min(1, frame[i]));
        pending.push(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
      }
      if (pending.length >= CHUNK_SAMPLES) flush(false);
    },
    async finish() {
      if (dead) return;
      const last = new Promise<void>((resolve) => { onFinalCommit = resolve; });
      flush(true);
      await Promise.race([last, delay(FINAL_COMMIT_WAIT_MS)]);
      dead = true;
      try { socket.close(); } catch { /* idem */ }
    },
    abort() {
      dead = true;
      pending.length = 0;
      try { socket.close(); } catch { /* idem */ }
    },
    committedCount: () => committed,
  };
}

/**
 * Il permesso di connettersi. `null` su qualunque risposta che non sia un
 * token: il 503 («non in offerta») e il 502 («ci ho provato e si e' rotto»)
 * portano allo stesso posto, cioe' alla dettatura batch di prima.
 */
async function fetchRealtimeToken(): Promise<SttRealtimeToken | null> {
  try {
    const resp = await fetch('/api/stt/realtime-token', { method: 'POST', credentials: 'same-origin' });
    if (!resp.ok) return null;
    const body = (await resp.json()) as SttRealtimeToken;
    return typeof body?.token === 'string' && body.token ? body : null;
  } catch {
    return null;
  }
}

/** PCM 16 bit little-endian in base64, a fette: `fromCharCode` con ottomila argomenti fa saltare lo stack. */
function base64FromPcm(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Vero se il socket si e' aperto entro il tempo, falso se e' morto o ha tardato. */
function waitForOpen(socket: WebSocket): Promise<boolean> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
    socket.addEventListener('open', () => done(true), { once: true });
    socket.addEventListener('close', () => done(false), { once: true });
    socket.addEventListener('error', () => done(false), { once: true });
    setTimeout(() => done(socket.readyState === WebSocket.OPEN), SESSION_START_TIMEOUT_MS);
  });
}

/** Aspetta che una condizione diventi vera, controllandola a intervalli brevi. */
async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await delay(20);
  }
  return condition();
}
