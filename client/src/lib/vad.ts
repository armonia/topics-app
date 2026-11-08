/**
 * Fine turno per SILENZIO, non per cronometro.
 *
 * La modalità voice-call tagliava la registrazione a 5 secondi fissi. Cinque
 * secondi non sono una frase: chi parla più a lungo veniva troncato a metà
 * parola, e chi rispondeva «sì» aspettava comunque quattro secondi di niente
 * prima che il turno partisse. Il turno finisce quando SMETTI di parlare.
 *
 * La soglia non è una costante: il rumore di fondo di una stanza silenziosa e
 * quello di un bar stanno due ordini di grandezza distanti, e un valore fisso
 * significa «non chiude mai» in un posto e «chiude a metà respiro» nell'altro.
 * Qui il pavimento di rumore si misura sul vivo e la soglia gli sta sopra.
 */

export interface VadHandle {
  /** Stacca l'analisi e chiude l'AudioContext (un contesto lasciato aperto tiene vivo un thread audio). */
  stop(): void;
}

export interface VadOptions {
  /** Il parlato è iniziato (primo campione sopra soglia). */
  onSpeechStart?: () => void;
  /** Fine turno: silenzio abbastanza lungo DOPO che qualcosa è stato detto. */
  onSilence: () => void;
  /** Tetto duro: si chiude comunque, con o senza silenzio. */
  onMaxDuration?: () => void;
  /** Nessuno ha parlato entro questo tempo dall'apertura del microfono. */
  onNoSpeech?: () => void;
  /** Quanto silenzio chiude il turno (ms). */
  silenceMs?: number;
  /** Sotto questa durata il parlato è un colpo di tosse, non una frase (ms). */
  minSpeechMs?: number;
  /** Tetto duro sul turno (ms). */
  maxTurnMs?: number;
  /** Quanto si aspetta la prima parola prima di arrendersi (ms). */
  noSpeechTimeoutMs?: number;
}

const TICK_MS = 50;
/** Sotto questo livello assoluto è silenzio comunque, per quanto basso sia il pavimento misurato. */
const ABSOLUTE_FLOOR = 0.008;
/** Quanto sopra il rumore di fondo deve stare un campione per contare come voce. */
const SPEECH_MARGIN = 2.5;

export function attachSilenceDetector(stream: MediaStream, opts: VadOptions): VadHandle {
  const {
    onSpeechStart,
    onSilence,
    onMaxDuration,
    onNoSpeech,
    silenceMs = 1200,
    minSpeechMs = 300,
    maxTurnMs = 30_000,
    noSpeechTimeoutMs = 8_000,
  } = opts;

  const AudioCtor: typeof AudioContext | undefined =
    typeof AudioContext !== 'undefined'
      ? AudioContext
      : (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  // Nessun AudioContext (ambiente di test, webview esotica): il chiamante deve
  // comunque avere una fine turno, quindi si degrada al solo tetto di durata.
  if (!AudioCtor) {
    const t = setTimeout(() => onMaxDuration?.() ?? onSilence(), maxTurnMs);
    return { stop: () => clearTimeout(t) };
  }

  const ctx = new AudioCtor();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.2;
  source.connect(analyser);
  const buf = new Uint8Array(analyser.fftSize);

  let noiseFloor = 0.02;
  let calibrating = true;
  let calibrationSum = 0;
  let calibrationTicks = 0;
  let speechMs = 0;
  let silenceRun = 0;
  let started = false;
  let elapsed = 0;
  let done = false;

  const finish = (cb?: () => void) => {
    if (done) return;
    done = true;
    stop();
    cb?.();
  };

  const timer = setInterval(() => {
    // `getByteTimeDomainData` accetta una view su ArrayBuffer; il cast tiene
    // insieme le due definizioni di lib DOM (ArrayBufferLike vs ArrayBuffer).
    analyser.getByteTimeDomainData(buf as Uint8Array<ArrayBuffer>);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    elapsed += TICK_MS;

    // Primi 300 ms: si misura la stanza, non si decide niente.
    if (calibrating) {
      calibrationSum += rms;
      calibrationTicks++;
      if (calibrationTicks * TICK_MS >= 300) {
        noiseFloor = Math.max(calibrationSum / calibrationTicks, ABSOLUTE_FLOOR / SPEECH_MARGIN);
        calibrating = false;
      }
      return;
    }

    const threshold = Math.max(noiseFloor * SPEECH_MARGIN, ABSOLUTE_FLOOR);
    if (rms > threshold) {
      speechMs += TICK_MS;
      silenceRun = 0;
      if (!started && speechMs >= minSpeechMs) {
        started = true;
        onSpeechStart?.();
      }
    } else {
      silenceRun += TICK_MS;
      // Il pavimento insegue il silenzio verso il basso: una stanza che si zittisce
      // (il ventilatore che si spegne) non deve restare sopra soglia per sempre.
      noiseFloor = Math.min(noiseFloor, noiseFloor * 0.95 + rms * 0.05);
      if (started && silenceRun >= silenceMs) { finish(onSilence); return; }
      if (!started && elapsed >= noSpeechTimeoutMs) { finish(onNoSpeech ?? onSilence); return; }
    }

    if (elapsed >= maxTurnMs) finish(onMaxDuration ?? onSilence);
  }, TICK_MS);

  function stop() {
    clearInterval(timer);
    try { source.disconnect(); } catch { /* già staccato */ }
    // `close()` rilascia il thread audio: senza, ogni turno ne lascia uno vivo.
    void ctx.close().catch(() => { /* già chiuso */ });
  }

  return { stop: () => { done = true; stop(); } };
}
