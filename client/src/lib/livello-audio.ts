/**
 * Quanto suono e' passato davvero dal microfono.
 *
 * PERCHE' ESISTE. «Non ho sentito parole» ha due cause che da fuori sono la
 * stessa frase: o il microfono ha registrato la stanza e il modello non ha
 * riconosciuto parole, oppure il microfono non ha registrato NIENTE — traccia
 * muta, ingresso di sistema sbagliato, dispositivo virtuale che non passa
 * segnale — e il modello ha giustamente trascritto il nulla. La prima si ripara
 * parlando piu' vicino, la seconda cambiando l'ingresso audio, e mandare
 * qualcuno a fare la prima quando serve la seconda e' come non dirgli niente.
 *
 * Misurato il 14/08: una nota di alcuni secondi arrivava al server con byte a
 * sufficienza, whisper rispondeva a vuoto, e non c'era modo di sapere se il
 * contenitore trasportasse silenzio o parlato. Il contenitore non lo dice: un
 * codec a bitrate fisso produce byte anche sul silenzio assoluto.
 *
 * Questa sonda guarda il segnale PRIMA che venga codificato, quindi risponde a
 * quella domanda e basta. Non trascrive, non decide, non blocca la
 * registrazione: raccoglie un numero, e chi mostra il messaggio lo usa per
 * scegliere quale delle due frasi e' vera.
 */

/**
 * Sotto questa ampiezza di picco la traccia si considera muta.
 *
 * 1% di fondo scala, cioe' circa -40 dBFS. Il rumore di una stanza silenziosa
 * con un microfono aperto sta sopra: un portatile su una scrivania ferma misura
 * qualche punto percentuale. Sotto c'e' il silenzio DIGITALE, quello che
 * produce un dispositivo che non passa segnale — ed e' un'altra cosa dal
 * silenzio acustico.
 */
export const SOGLIA_TRACCIA_MUTA = 0.01;

export interface SondaLivello {
  /** Il picco di ampiezza visto finora, da 0 (silenzio digitale) a 1 (fondo scala). */
  picco(): number;
  /** Vero se in tutta la registrazione non e' passato niente. */
  muta(): boolean;
  /** The level of the LAST window, 0-1: what a meter draws while you speak. */
  livello(): number;
  /**
   * The context's REAL sample rate, which is not always the one that was
   * asked for: a browser may hand back its native 48 kHz instead. Whoever
   * streams those samples has to declare this number, not the wish.
   */
  sampleRate(): number;
  /**
   * Chiude il contesto audio.
   *
   * NON e' facoltativo: un `AudioContext` non chiuso resta vivo in WebKit
   * insieme al suo proxy di destinazione, e ogni dettatura ne lascerebbe uno.
   */
  chiudi(): void;
}

/** Intervallo di campionamento: la finestra dell'analizzatore e' ~46 ms, quindi 50 ms copre la registrazione senza buchi utili. */
const PASSO_MS = 50;

export interface LevelProbeOptions {
  /**
   * The rate to ASK the audio context for. Live dictation needs 16 kHz mono,
   * and asking the context resamples for free; check `sampleRate()` afterwards,
   * because a browser is allowed to answer with its own.
   */
  sampleRate?: number;
  /**
   * Receives every block of mono samples, as they are captured.
   *
   * WHY IT LIVES IN THE PROBE and not in a module of its own: it is the SAME
   * AudioContext. Opening a second one over the same microphone means a second
   * resampler, a second graph and, in WebKit, a second object that survives the
   * dictation. The probe already holds one, already closes it, and the samples
   * it is measuring are exactly the ones the socket has to send.
   */
  onPcm?: (frame: Float32Array) => void;
}

/**
 * Attacca una sonda a uno stream gia' aperto.
 *
 * Restituisce `null` se il browser non offre `AudioContext`: la sonda e' una
 * diagnosi in piu', non un requisito. Se manca, la dettatura funziona come
 * prima e il messaggio resta quello generico.
 */
export function ascoltaLivello(stream: MediaStream, opts: LevelProbeOptions = {}): SondaLivello | null {
  const Ctx: typeof AudioContext | undefined =
    typeof window === 'undefined'
      ? undefined
      : window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;

  let ctx: AudioContext;
  try {
    ctx = opts.sampleRate ? new Ctx({ sampleRate: opts.sampleRate }) : new Ctx();
  } catch {
    // Una frequenza rifiutata non deve costare la sonda: senza vincolo il
    // contesto nasce comunque, e la dettatura in tempo reale si arrende da
    // sola quando legge una frequenza che il servizio non accetta.
    try { ctx = new Ctx(); } catch { return null; }
  }

  let massimo = 0;
  let corrente = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let chiuso = false;

  try {
    const sorgente = ctx.createMediaStreamSource(stream);
    const analizzatore = ctx.createAnalyser();
    analizzatore.fftSize = 2048;
    sorgente.connect(analizzatore);
    // NIENTE `connect(ctx.destination)`: rimandare il microfono agli
    // altoparlanti mentre uno detta produce un ritorno acustico immediato.
    const finestra = new Uint8Array(analizzatore.fftSize);

    // Il contesto puo' nascere sospeso: senza risveglio l'analizzatore legge
    // 128 fisso, cioe' misurerebbe muta OGNI traccia. Sarebbe una diagnosi che
    // accusa sempre.
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});

    if (opts.onPcm) attachPcmTap(ctx, sorgente, opts.onPcm);

    timer = setInterval(() => {
      analizzatore.getByteTimeDomainData(finestra);
      let windowPeak = 0;
      for (let i = 0; i < finestra.length; i++) {
        const scarto = Math.abs(finestra[i] - 128) / 128;
        if (scarto > windowPeak) windowPeak = scarto;
      }
      corrente = windowPeak;
      if (windowPeak > massimo) massimo = windowPeak;
    }, PASSO_MS);
  } catch {
    void ctx.close().catch(() => {});
    return null;
  }

  return {
    picco: () => massimo,
    muta: () => massimo < SOGLIA_TRACCIA_MUTA,
    livello: () => (chiuso ? 0 : corrente),
    sampleRate: () => ctx.sampleRate,
    chiudi: () => {
      if (chiuso) return;
      chiuso = true;
      if (timer) clearInterval(timer);
      timer = null;
      void ctx.close().catch(() => {});
    },
  };
}

/**
 * Il codice del worklet, come sorgente.
 *
 * Un AudioWorklet si carica da un URL, e un file a parte dovrebbe attraversare
 * la pipeline di build per finire in `public/` con un percorso stabile: un
 * blob URL costruito qui evita quel giro, e tiene le dodici righe che contano
 * accanto a chi le usa. Il processore non scrive niente sull'uscita, quindi il
 * suo collegamento alla destinazione trasporta silenzio: serve solo perche' il
 * grafo venga TIRATO: un nodo che non arriva alla destinazione, in Chromium,
 * puo' non essere elaborato affatto.
 */
const PCM_TAP_SOURCE = `
class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(new Float32Array(channel));
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);
`;

/**
 * Attacca la presa dei campioni. Fallisce in silenzio: senza AudioWorklet (o
 * se il modulo non si carica) la sonda continua a misurare il livello e la
 * dettatura resta quella batch, che e' esattamente il ripiego previsto.
 */
function attachPcmTap(ctx: AudioContext, sorgente: AudioNode, onPcm: (frame: Float32Array) => void): void {
  if (!ctx.audioWorklet) return;
  const url = URL.createObjectURL(new Blob([PCM_TAP_SOURCE], { type: 'application/javascript' }));
  void ctx.audioWorklet
    .addModule(url)
    .then(() => {
      if (ctx.state === 'closed') return;
      const node = new AudioWorkletNode(ctx, 'pcm-tap');
      node.port.onmessage = (event: MessageEvent<Float32Array>) => onPcm(event.data);
      sorgente.connect(node);
      node.connect(ctx.destination);
    })
    .catch(() => { /* niente presa: la dettatura resta batch */ })
    .finally(() => URL.revokeObjectURL(url));
}

/**
 * La frase da mostrare quando la trascrizione torna vuota.
 *
 * Vive qui, e non nei due hook che registrano, perche' i due hook — dettatura
 * nel campo e nota vocale in chat — hanno gia' divergiuto tre volte oggi sullo
 * stesso ramo. Una frase sola in un posto solo e' il modo per non ritrovarsi
 * con una superficie che spiega e l'altra che tace.
 */
export function messaggioTrascrittoVuoto(opts: {
  sonda: SondaLivello | null;
  provider: string;
  durataMs: number;
}): string {
  const secondi = Math.round(opts.durataMs / 100) / 10;
  if (opts.sonda?.muta()) {
    const picco = Math.round(opts.sonda.picco() * 1000) / 10;
    return (
      `Il microfono non ha prodotto suono: per tutta la registrazione il segnale e' rimasto a ${picco}% ` +
      `(sotto ${SOGLIA_TRACCIA_MUTA * 100}% e' silenzio digitale, non una stanza silenziosa). ` +
      `Controlla quale ingresso e' selezionato in Impostazioni di Sistema, Suono, Ingresso, e che non sia a volume zero.`
    );
  }
  return `Non ho sentito parole (${opts.provider}, ${secondi}s). Riprova parlando piu' vicino al microfono.`;
}
