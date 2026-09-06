import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchSttCapabilities,
  forgetSttCapabilities,
  transcribeAudio,
  pickRecorderMimeType,
  extForMime,
  micErrorMessage,
  MIN_VOICE_BLOB_BYTES,
  messaggioNotaVuota,
  fallbackNotice,
  segnalaNotaVuota,
  SPEECH_AUDIO_CONSTRAINTS,
  SPEECH_BITS_PER_SECOND,
  type SttCapabilities,
} from '../lib/stt';
import { ascoltaLivello, messaggioTrascrittoVuoto, type SondaLivello } from '../lib/livello-audio';
import { errMessage } from '../lib/errMessage';
import type { RealtimeSession } from '../lib/stt-realtime';
import { useSpeechToText } from './useSpeech';
import { useLocale, useT } from './useT';

export type DictationEngine = 'server' | 'webspeech' | null;

/** The rate Scribe v2 Realtime wants, and the one the probe asks the context for. */
const REALTIME_SAMPLE_RATE = 16_000;

/**
 * How much audio is kept while the socket is still being negotiated.
 *
 * Asking for the token, opening the WebSocket and waiting for `session_started`
 * costs a few hundred milliseconds, and the microphone is already open: without
 * this buffer the first words would be captured and thrown away, which is the
 * one part of a dictation nobody forgives. Sixteen thousand samples a second
 * over four seconds is the ceiling; past that the socket is not coming.
 */
const PREROLL_MAX_SAMPLES = REALTIME_SAMPLE_RATE * 4;

/**
 * Dettatura: parli, e le parole finiscono nel composer.
 *
 * Fin qui l'unico motore era la Web Speech API del browser, che è una feature di
 * **Safari**, non di WebKit: in una WKWebView — il guscio Tauri della app
 * desktop — `webkitSpeechRecognition` non esiste, e su Windows WebView2 nemmeno.
 * `sttSupported` era quindi `false` per la stragrande maggioranza degli utenti
 * della app, e la riga «Dictation mode» del menu spariva senza spiegazioni.
 *
 * Ora il motore preferito è il SERVER (`/api/stt` → Scribe v2 / gpt-transcribe /
 * Nova-3 / Whisper): registra col microfono, che nella webview c'è, e trascrive
 * con i modelli di oggi. La Web Speech resta come ripiego per chi gira in Chrome
 * senza nessuna chiave configurata e senza whisper locale — così nessuno perde
 * una capacità che prima aveva.
 */
export function useDictation(opts: {
  /** Riceve il testo trascritto. Chiamato una volta a fine dettatura (motore server) o a ogni frase finale (Web Speech). */
  onText: (text: string) => void;
  onError?: (message: string) => void;
  /** Something worth knowing that is not a failure: the text arrived, but from
   *  the fallback engine, and here is why the first one did not answer. */
  onNotice?: (message: string) => void;
  /** ISO-639-1 to force the language. Absent = the interface locale, sent as a
   *  hint: the cloud models take it as a suggestion, and the local whisper
   *  stops guessing «you» / «Thank you.» on a short Italian clip. */
  language?: string;
}) {
  const { onText, onError, onNotice, language } = opts;
  const locale = useLocale();
  const languageHint = language ?? locale;
  // The recorder callbacks live outside the render, so the translator reaches
  // them through a ref: same shape as `onTextRef` and friends below.
  const tr = useT();
  const trRef = useRef(tr);
  trRef.current = tr;
  const [capabilities, setCapabilities] = useState<SttCapabilities | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  /** Un annullo (Escape, smontaggio) non deve pagare una trascrizione né incollare niente. */
  const discardRef = useRef(false);
  const maxDurationRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Misura il segnale mentre si registra: serve solo se il trascritto torna vuoto. */
  const sondaRef = useRef<SondaLivello | null>(null);
  /** The live socket, while it lives. Null means the batch flow owns the stop. */
  const realtimeRef = useRef<RealtimeSession | null>(null);
  /** Samples captured before the socket was ready, replayed as soon as it is. */
  const prerollRef = useRef<Float32Array[]>([]);
  const prerollSamplesRef = useRef(0);
  /** How many segments the live engine settled: zero is what hands the stop back to batch. */
  const committedRef = useRef(0);
  /**
   * The text the live engine is still revising. It is shown in grey and it is
   * NOT pasted: a partial is a guess that the next packet is allowed to rewrite.
   */
  const [partial, setPartial] = useState('');

  // I callback arrivano dal componente e cambiano a ogni render: tenerli in un
  // ref evita che `stop`/`start` cambino identità (e con loro le dipendenze
  // dell'effetto delle scorciatoie da tastiera, che si rimonterebbe a ogni tasto).
  const onTextRef = useRef(onText);
  const onErrorRef = useRef(onError);
  const onNoticeRef = useRef(onNotice);
  useEffect(() => { onTextRef.current = onText; onErrorRef.current = onError; onNoticeRef.current = onNotice; }, [onText, onError, onNotice]);
  /** When the current state began: what the strip's clock counts from. */
  const [since, setSince] = useState(0);

  // Motore di ripiego. L'hook si monta sempre (le regole dei hook non ammettono
  // rami), ma viene PILOTATO solo quando il server non sa trascrivere.
  const webSpeech = useSpeechToText();

  const micAvailable = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';

  useEffect(() => {
    let alive = true;
    const chiedi = () => { void fetchSttCapabilities().then(caps => { if (alive) setCapabilities(caps); }); };
    chiedi();
    // L'ACCOPPIAMENTO CAMBIA LA RISPOSTA. `/api/stt/capabilities` sta dietro
    // l'identita': su un dispositivo appena arrivato in rete risponde `401`
    // finche' non e' dentro. Senza questo ascolto il microfono resterebbe
    // invisibile fino a un ricarico della pagina - la sonda si dimentica il
    // «no» (vedi `fetchSttCapabilities`), ma qualcuno deve pur richiederla, e
    // aspettare un tentativo naturale qui vuol dire aspettare che l'utente
    // riapra un pannello.
    const riprova = () => { forgetSttCapabilities(); chiedi(); };
    window.addEventListener('topics:auth-pair-resolved', riprova);
    return () => { alive = false; window.removeEventListener('topics:auth-pair-resolved', riprova); };
  }, []);

  // Read inside the recorder callbacks, which live outside the render.
  const capabilitiesRef = useRef<SttCapabilities | null>(null);
  capabilitiesRef.current = capabilities;

  const engine: DictationEngine =
    capabilities?.available && micAvailable ? 'server'
    : webSpeech.isSupported ? 'webspeech'
    : null;

  // Finché la sonda non ha risposto il motore è ignoto: mostrare il tasto e poi
  // toglierlo è peggio che aspettare un giro di rete. `isSupported` resta falso
  // solo se, a sonda conclusa, non c'è davvero nessun motore.
  const isSupported = capabilities === null ? micAvailable || webSpeech.isSupported : engine !== null;

  const releaseMic = useCallback(() => {
    if (maxDurationRef.current) { clearTimeout(maxDurationRef.current); maxDurationRef.current = null; }
    // La sonda si chiude col microfono, non con la trascrizione: il picco che
    // ha gia' raccolto resta leggibile anche dopo, ed e' quello che serve.
    sondaRef.current?.chiudi();
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
  }, []);

  const startServer = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: SPEECH_AUDIO_CONSTRAINTS });
      streamRef.current = stream;
      // THE WORDS WHILE YOU SPEAK, when the engine at the head of the chain can
      // stream them. The probe is the one that captures the samples, because it
      // already owns an AudioContext over this microphone: a second one would
      // mean a second resampler and, in WebKit, a second object outliving the
      // dictation. The recorder keeps running in parallel either way, so the
      // audio for the batch flow is there whole if the socket never opens.
      const wantsRealtime = capabilitiesRef.current?.realtime === true;
      committedRef.current = 0;
      prerollRef.current = [];
      prerollSamplesRef.current = 0;
      setPartial('');
      sondaRef.current = ascoltaLivello(stream, wantsRealtime ? {
        sampleRate: REALTIME_SAMPLE_RATE,
        onPcm: (frame) => {
          const live = realtimeRef.current;
          if (live) { live.send(frame); return; }
          if (prerollSamplesRef.current >= PREROLL_MAX_SAMPLES) return;
          prerollRef.current.push(frame);
          prerollSamplesRef.current += frame.length;
        },
      } : {});
      const mimeType = pickRecorderMimeType();
      const recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: SPEECH_BITS_PER_SECOND,
      });
      recorderRef.current = recorder;
      chunksRef.current = [];
      discardRef.current = false;

      recorder.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        const live = realtimeRef.current;
        realtimeRef.current = null;
        releaseMic();
        const type = recorder.mimeType || mimeType || 'audio/webm';
        const spezzoni = chunksRef.current.length;
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        setIsListening(false);
        // ANNULLATO A MANO: nessun messaggio, e' una scelta di chi usa la app.
        if (discardRef.current) { live?.abort(); setPartial(''); return; }
        // The last segment is asked for and waited: a commit that arrives after
        // the socket closed is a sentence the person said and never sees.
        if (live) {
          setIsTranscribing(true);
          setSince(performance.now());
          await live.finish();
          setIsTranscribing(false);
          setPartial('');
        }
        // THE LIVE ENGINE ALREADY PASTED WHAT IT HEARD. Transcribing the same
        // audio again in batch would not add a safety net, it would paste the
        // whole dictation a second time under the first. Batch takes over only
        // when nothing at all was committed, which is exactly the case the
        // fallback exists for: token refused, socket dead, quota spent.
        if (committedRef.current > 0) return;
        // VUOTA: e questo ramo era MUTO, come lo era il gemello della chat prima
        // di `fe635287` che pero' ha fatto parlare solo quello. Qui premevi il
        // microfono nel campo task, parlavi, mollavi, e non compariva niente:
        // indistinguibile da una app rotta, ed e' il motivo per cui la dettatura
        // «non funziona» sul telefono senza che nessuno sappia perche'.
        //
        // I due numeri sono la diagnosi, non un ornamento: ZERO spezzoni vuol
        // dire che il microfono non ha aperto affatto (permesso negato in
        // silenzio, traccia muta), mentre pochi byte in uno spezzone solo vuol
        // dire che ha aperto e ha prodotto la sola intestazione del contenitore.
        // Sono due guasti diversi e si riparano in due posti diversi.
        if (blob.size < MIN_VOICE_BLOB_BYTES) {
          onErrorRef.current?.(messaggioNotaVuota(spezzoni, blob.size, type, trRef.current));
          segnalaNotaVuota(spezzoni, blob.size, type, 'dettatura');
          return;
        }
        setIsTranscribing(true);
        setSince(performance.now());
        try {
          const result = await transcribeAudio(blob, { filename: `dictation.${extForMime(type)}`, language: languageHint });
          // Silenzio (o l'artefatto che Whisper produce sul silenzio, che il
          // server filtra): niente da incollare, e niente errore da mostrare.
          const testo = result.transcript.trim();
          if (testo) onTextRef.current(testo);
          const notice = fallbackNotice(result, trRef.current);
          if (notice) onNoticeRef.current?.(notice);
          // SILENZIO NON E' NIENTE DA DIRE: e' una notizia.
          //
          // Questo era l'ultimo ramo muto della dettatura. Il giro andava a
          // buon fine, il server rispondeva 200 con un trascritto vuoto (o
          // l'artefatto che Whisper produce sul silenzio, che il server
          // filtra), e il client non faceva NULLA: nessun testo, nessun
          // messaggio. Chi aveva premuto e parlato vedeva la stessa cosa di
          // una app rotta, ed e' il sintomo con cui questa caccia e' iniziata.
          //
          // I due casi che si somigliano — «non ho sentito» (microfono aperto
          // sul nulla) e «non ho capito» (audio c'era, il modello non ha
          // riconosciuto parole) — li separa la SONDA, non un'ipotesi: ha
          // misurato il segnale prima che venisse codificato, quindi sa dire
          // se dal microfono e' passato qualcosa.
          else onErrorRef.current?.(messaggioTrascrittoVuoto({
            sonda: sondaRef.current,
            provider: result.provider,
            durataMs: result.durationMs,
          }));
        } catch (err) {
          onErrorRef.current?.(trRef.current('stt.dictationFailed', { reason: err instanceof Error ? err.message : trRef.current('stt.unknownError') }));
        } finally {
          setIsTranscribing(false);
        }
      };

      // 100 ms: chunk piccoli, così uno stop immediato ha comunque dei dati.
      recorder.start(100);
      setIsListening(true);
      setSince(performance.now());
      // The socket is negotiated AFTER the recorder is running, and nothing
      // waits for it: a token that takes 300 ms must not delay the recording,
      // and one that never arrives must not stop it either.
      const probe = sondaRef.current;
      if (wantsRealtime && probe) {
        // Lost mid-sentence: what was committed stays in the field, the rest
        // is worth a line, because the person is still speaking into a
        // microphone that no longer shows anything.
        const fellBack = (reason: string): void => {
          realtimeRef.current = null;
          setPartial('');
          onNoticeRef.current?.(trRef.current('stt.realtimeFellBack', { reason }));
        };
        // The realtime machine is its own chunk: it is paid only by the
        // session that dictates live, not by every boot (2.8 KB raw of the
        // entry as a static import). Nothing waits for it, see above; and a
        // chunk that fails to arrive is the same event as a socket that
        // does — the batch upload behind the recorder is the safety net.
        void import('../lib/stt-realtime').then(({ startRealtimeDictation }) => startRealtimeDictation({
          sampleRate: probe.sampleRate(),
          language: languageHint,
          onPartial: setPartial,
          onCommitted: (text) => {
            committedRef.current += 1;
            setPartial('');
            onTextRef.current(text);
          },
          onFail: fellBack,
        }), (err: unknown) => { fellBack(errMessage(err)); return null; }).then((session) => {
          if (!session) return;
          // Stopped or cancelled while the token was in flight: a session opened
          // over a closed microphone would transcribe silence and bill for it.
          if (!streamRef.current || discardRef.current) { session.abort(); return; }
          realtimeRef.current = session;
          for (const frame of prerollRef.current) session.send(frame);
          prerollRef.current = [];
          prerollSamplesRef.current = 0;
        });
      }
      // Rete di sicurezza contro il microfono lasciato acceso: cinque minuti sono
      // molto oltre qualunque dettatura, e sotto il tetto di 25 MB del server.
      maxDurationRef.current = setTimeout(() => {
        if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
      }, 5 * 60 * 1000);
    } catch (err) {
      releaseMic();
      setIsListening(false);
      onErrorRef.current?.(micErrorMessage(err, trRef.current));
    }
  }, [languageHint, releaseMic]);

  const stopServer = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') { setIsListening(false); releaseMic(); return; }
    recorder.stop();
  }, [releaseMic]);

  const start = useCallback(() => {
    if (isListening || isTranscribing) return;
    if (engine === 'server') void startServer();
    else if (engine === 'webspeech') { webSpeech.startListening(); setIsListening(true); }
    else onErrorRef.current?.(trRef.current('stt.noEngine'));
  }, [engine, isListening, isTranscribing, startServer, webSpeech]);

  const stop = useCallback(() => {
    if (engine === 'server') stopServer();
    else { webSpeech.stopListening(); setIsListening(false); }
  }, [engine, stopServer, webSpeech]);

  /** Chiude il microfono BUTTANDO via l'audio: nessuna trascrizione, nessun testo. */
  const cancel = useCallback(() => {
    discardRef.current = true;
    if (engine === 'server') stopServer();
    else { webSpeech.stopListening(); setIsListening(false); }
  }, [engine, stopServer, webSpeech]);

  const toggle = useCallback(() => {
    if (isListening) stop(); else start();
  }, [isListening, start, stop]);

  // Ponte per il motore di ripiego: la Web Speech consegna frasi via stato.
  useEffect(() => {
    if (engine !== 'webspeech') return;
    if (webSpeech.transcript) {
      onTextRef.current(webSpeech.transcript.trim());
      webSpeech.clearTranscript();
    }
  }, [engine, webSpeech]);

  // La Web Speech si ferma da sola (timeout di silenzio del browser): lo stato
  // locale deve seguirla, altrimenti il tasto resta acceso su un motore spento.
  useEffect(() => {
    if (engine === 'webspeech' && !webSpeech.isListening && isListening) setIsListening(false);
  }, [engine, webSpeech.isListening, isListening]);

  // Il pannello che si smonta a microfono aperto non deve lasciarlo acceso —
  // né pagare la trascrizione di un audio che nessuno leggerà.
  useEffect(() => {
    return () => {
      discardRef.current = true;
      if (maxDurationRef.current) clearTimeout(maxDurationRef.current);
      if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
      realtimeRef.current?.abort();
      realtimeRef.current = null;
      sondaRef.current?.chiudi();
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    };
  }, []);

  /** Stable across renders, so a meter can read it every frame. */
  const level = useCallback(() => sondaRef.current?.livello() ?? 0, []);

  return {
    isListening,
    isTranscribing,
    isSupported,
    engine,
    since,
    level,
    /** The live text still being revised: grey, and never pasted as is. */
    partial,
    /** True while the words appear as they are spoken, not after the stop. */
    isLive: capabilities?.realtime === true,
    /** Es. «ElevenLabs scribe_v2» — da mostrare nel tooltip così l'umano sa chi lo sta ascoltando. */
    modelLabel: capabilities?.available ? `${capabilities.provider} ${capabilities.model}` : null,
    capabilities,
    start,
    stop,
    cancel,
    toggle,
  };
}
