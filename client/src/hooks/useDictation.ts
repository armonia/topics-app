import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchSttCapabilities,
  transcribeAudio,
  pickRecorderMimeType,
  extForMime,
  micErrorMessage,
  MIN_VOICE_BLOB_BYTES,
  messaggioNotaVuota,
  segnalaNotaVuota,
  SPEECH_AUDIO_CONSTRAINTS,
  SPEECH_BITS_PER_SECOND,
  type SttCapabilities,
} from '../lib/stt';
import { useSpeechToText } from './useSpeech';

export type DictationEngine = 'server' | 'webspeech' | null;

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
  /** ISO-639-1 per forzare la lingua; assente = auto-detect (il default giusto sui modelli moderni). */
  language?: string;
}) {
  const { onText, onError, language } = opts;
  const [capabilities, setCapabilities] = useState<SttCapabilities | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  /** Un annullo (Escape, smontaggio) non deve pagare una trascrizione né incollare niente. */
  const discardRef = useRef(false);
  const maxDurationRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // I callback arrivano dal componente e cambiano a ogni render: tenerli in un
  // ref evita che `stop`/`start` cambino identità (e con loro le dipendenze
  // dell'effetto delle scorciatoie da tastiera, che si rimonterebbe a ogni tasto).
  const onTextRef = useRef(onText);
  const onErrorRef = useRef(onError);
  useEffect(() => { onTextRef.current = onText; onErrorRef.current = onError; }, [onText, onError]);

  // Motore di ripiego. L'hook si monta sempre (le regole dei hook non ammettono
  // rami), ma viene PILOTATO solo quando il server non sa trascrivere.
  const webSpeech = useSpeechToText();

  const micAvailable = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';

  useEffect(() => {
    let alive = true;
    void fetchSttCapabilities().then(caps => { if (alive) setCapabilities(caps); });
    return () => { alive = false; };
  }, []);

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
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
  }, []);

  const startServer = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: SPEECH_AUDIO_CONSTRAINTS });
      streamRef.current = stream;
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
        releaseMic();
        const type = recorder.mimeType || mimeType || 'audio/webm';
        const spezzoni = chunksRef.current.length;
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        setIsListening(false);
        // ANNULLATO A MANO: nessun messaggio, e' una scelta di chi usa la app.
        if (discardRef.current) return;
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
          onErrorRef.current?.(messaggioNotaVuota(spezzoni, blob.size, type));
          segnalaNotaVuota(spezzoni, blob.size, type, 'dettatura');
          return;
        }
        setIsTranscribing(true);
        try {
          const result = await transcribeAudio(blob, { filename: `dictation.${extForMime(type)}`, language });
          // Silenzio (o l'artefatto che Whisper produce sul silenzio, che il
          // server filtra): niente da incollare, e niente errore da mostrare.
          if (result.transcript.trim()) onTextRef.current(result.transcript.trim());
        } catch (err) {
          onErrorRef.current?.(`Dettatura non trascritta: ${err instanceof Error ? err.message : 'errore sconosciuto'}`);
        } finally {
          setIsTranscribing(false);
        }
      };

      // 100 ms: chunk piccoli, così uno stop immediato ha comunque dei dati.
      recorder.start(100);
      setIsListening(true);
      // Rete di sicurezza contro il microfono lasciato acceso: cinque minuti sono
      // molto oltre qualunque dettatura, e sotto il tetto di 25 MB del server.
      maxDurationRef.current = setTimeout(() => {
        if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
      }, 5 * 60 * 1000);
    } catch (err) {
      releaseMic();
      setIsListening(false);
      onErrorRef.current?.(micErrorMessage(err));
    }
  }, [language, releaseMic]);

  const stopServer = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') { setIsListening(false); releaseMic(); return; }
    recorder.stop();
  }, [releaseMic]);

  const start = useCallback(() => {
    if (isListening || isTranscribing) return;
    if (engine === 'server') void startServer();
    else if (engine === 'webspeech') { webSpeech.startListening(); setIsListening(true); }
    else onErrorRef.current?.('Dettatura non disponibile: nessun motore di trascrizione configurato.');
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
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    };
  }, []);

  return {
    isListening,
    isTranscribing,
    isSupported,
    engine,
    /** Es. «ElevenLabs scribe_v2» — da mostrare nel tooltip così l'umano sa chi lo sta ascoltando. */
    modelLabel: capabilities?.available ? `${capabilities.provider} ${capabilities.model}` : null,
    capabilities,
    start,
    stop,
    cancel,
    toggle,
  };
}
