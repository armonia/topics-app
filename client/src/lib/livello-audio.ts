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

/**
 * Attacca una sonda a uno stream gia' aperto.
 *
 * Restituisce `null` se il browser non offre `AudioContext`: la sonda e' una
 * diagnosi in piu', non un requisito. Se manca, la dettatura funziona come
 * prima e il messaggio resta quello generico.
 */
export function ascoltaLivello(stream: MediaStream): SondaLivello | null {
  const Ctx: typeof AudioContext | undefined =
    typeof window === 'undefined'
      ? undefined
      : window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;

  let ctx: AudioContext;
  try {
    ctx = new Ctx();
  } catch {
    return null;
  }

  let massimo = 0;
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

    timer = setInterval(() => {
      analizzatore.getByteTimeDomainData(finestra);
      for (let i = 0; i < finestra.length; i++) {
        const scarto = Math.abs(finestra[i] - 128) / 128;
        if (scarto > massimo) massimo = scarto;
      }
    }, PASSO_MS);
  } catch {
    void ctx.close().catch(() => {});
    return null;
  }

  return {
    picco: () => massimo,
    muta: () => massimo < SOGLIA_TRACCIA_MUTA,
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
