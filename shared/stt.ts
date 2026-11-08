/**
 * Il contratto della trascrizione, uno solo per i due lati del filo.
 *
 * `/api/stt` e `/api/stt/capabilities` rispondono ESATTAMENTE queste forme: il
 * server le produce (`server/lib/stt.ts`), il client le consuma
 * (`client/src/lib/stt.ts`). Dichiararle due volte è il modo in cui un campo
 * aggiunto da una parte resta invisibile all'altra finché non si rompe a runtime.
 */

/** I motori che sanno trascrivere, dal migliore per accuratezza al ripiego offline. */
export type SttProviderId = 'elevenlabs' | 'openai' | 'deepgram' | 'groq' | 'local';

export interface SttProviderStatus {
  id: SttProviderId;
  available: boolean;
  /** Il modello che verrebbe usato — es. `scribe_v2`, `gpt-transcribe`. */
  model: string;
  /** Perché NON è disponibile: la frase che l'umano legge invece di «non funziona». */
  reason?: string;
}

export interface SttResult {
  transcript: string;
  provider: SttProviderId;
  model: string;
  /** ISO-639-1 rilevato dal modello, quando lo dichiara. */
  language: string | null;
  durationMs: number;
  /**
   * Who fell over before `provider` answered, and why. Absent when the first
   * engine did the job. It is what turns «it took 20 seconds» into «ElevenLabs
   * rejected the key (401), whisper transcribed locally»: without it the client
   * shows the engine it believed in, and the person blames the wrong thing.
   */
  attempts?: { provider: SttProviderId; error: string }[];
}

export interface SttCapabilities {
  /** C'è almeno un motore utilizzabile: sotto a questo, la dettatura non ha senso di esistere a schermo. */
  available: boolean;
  provider: SttProviderId | null;
  model: string | null;
  providers: SttProviderStatus[];
  /** Lingua forzata da configurazione; `null` = auto-detect. */
  language: string | null;
  /**
   * The words can appear WHILE you speak, not after you stop.
   *
   * True only when the engine at the head of the chain is the one that has a
   * streaming API (ElevenLabs Scribe v2 Realtime) with a key that answered.
   * The client reads it BEFORE opening the microphone: without it, discovering
   * that live dictation is not on offer would cost a wasted round trip to the
   * token endpoint at the exact moment the person pressed the button.
   *
   * Optional on the wire: an older server, or a test double, simply does not
   * say it, and the client stays on the batch flow it already had.
   */
  realtime?: boolean;
}

/**
 * What the client needs to open the realtime socket ITSELF, without ever
 * holding the API key: a single-use token (15 minutes, consumed on connect)
 * plus the model and the audio format the session was asked for.
 */
export interface SttRealtimeToken {
  token: string;
  /** e.g. `scribe_v2_realtime`. */
  model: string;
  /** Sample rate of the PCM the client must send. */
  sampleRate: number;
  /** ElevenLabs audio format id, e.g. `pcm_16000`. */
  audioFormat: string;
  /** Forced language, or `null` for auto-detect. */
  language: string | null;
}
