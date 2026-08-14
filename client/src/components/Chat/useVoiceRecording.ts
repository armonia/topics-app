import { useState, useRef, useCallback, useEffect } from 'react';
import { uploadApi } from '../../lib/api';
import {
  transcribeAudio,
  pickRecorderMimeType,
  extForMime,
  micErrorMessage,
  MIN_VOICE_BLOB_BYTES,
  messaggioNotaVuota,
  segnalaNotaVuota,
  SPEECH_AUDIO_CONSTRAINTS,
  SPEECH_BITS_PER_SECOND,
  fetchSttCapabilities,
} from '../../lib/stt';

export function useVoiceRecording(
  sendMessage: (sessionKey: string, content: string) => Promise<boolean>,
  sessionKey: string,
  // Reserved for callers that gate recording on stream state; not used internally.
  _currentStreaming: boolean,
  /**
   * L'UNICA uscita d'errore del hook: registrazione che non parte E invio che
   * fallisce. Il messaggio arriva già completo — il chiamante lo mostra e basta,
   * senza aggiungere un prefisso, perché i due casi non sono la stessa frase.
   *
   * Serve perché questo era l'UNICO upload dell'app che non diceva niente: un
   * `console.error` e quaranta secondi di dettatura — una spec, un ragionamento
   * lungo — spariti senza una bolla, senza un errore, senza modo di riprovare. Il
   * fratello che carica i file (`ChatPane.tsx:556`) fa un toast; qui non c'era.
   * L'altra metà usava invece `alert()`, che in una WKWebView BLOCCA il thread
   * della webview: un microfono negato congelava chat, terminali e pane accanto
   * finché non chiudevi il dialog a mano.
   */
  onError?: (message: string) => void,
) {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [uploading, setUploading] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // The session the recording STARTED on. ChatPane persists across topic
  // switches (reconcile-not-remount, see its fastMode effects), so
  // stopRecording's closure would otherwise read the CURRENT sessionKey — a
  // voice note recorded on topic A but stopped after switching to B was
  // delivered into B's history.
  const recordingSessionKeyRef = useRef<string | null>(null);

  const onErrorRef = useRef(onError);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: SPEECH_AUDIO_CONSTRAINTS });
      streamRef.current = stream;
      const mimeType = pickRecorderMimeType();
      const options: MediaRecorderOptions = {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: SPEECH_BITS_PER_SECOND,
      };
      const recorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      recordingSessionKeyRef.current = sessionKey;
      recorder.start(100);
      setIsRecording(true);
      setRecordingTime(0);
      recordingTimerRef.current = setInterval(() => setRecordingTime(t => t + 1), 1000);
    } catch (err) {
      console.error('Failed to start recording:', err);
      onErrorRef.current?.(micErrorMessage(err));
    }
  }, [sessionKey]);

  const stopRecording = useCallback(async (): Promise<void> => {
    return new Promise((resolve) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state === 'inactive') { resolve(); return; }
      recorder.onstop = async () => {
        if (recordingTimerRef.current) { clearInterval(recordingTimerRef.current); recordingTimerRef.current = null; }
        if (streamRef.current) { streamRef.current.getTracks().forEach(track => track.stop()); streamRef.current = null; }
        const mimeType = recorder.mimeType || 'audio/webm';
        const ext = extForMime(mimeType);
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: mimeType });
        setIsRecording(false);
        setRecordingTime(0);
        // Silence is not a message: drop an empty/header-only capture instead of
        // uploading it and sending a `[Voice message: …]` bubble for it.
        if (audioChunksRef.current.length === 0 || blob.size < MIN_VOICE_BLOB_BYTES) {
          console.warn(`[voice] discarded empty recording (${blob.size}B) — nothing sent`);
          // E lo DICE. Questo ramo era muto, e su un telefono non c'è nessuna
          // console dove leggere il `console.warn`: premevi, parlavi, mollavi, e
          // non compariva niente. Indistinguibile da una app rotta, che è il
          // motivo per cui la nota vocale "non funziona" senza una diagnosi.
          // Il numero serve: dice se il microfono non ha aperto affatto (0
          // spezzoni) o se ha prodotto solo l'intestazione del contenitore.
          onErrorRef.current?.(messaggioNotaVuota(audioChunksRef.current.length, blob.size, mimeType));
          segnalaNotaVuota(audioChunksRef.current.length, blob.size, mimeType, 'nota-vocale');
          audioChunksRef.current = [];
          recordingSessionKeyRef.current = null;
          resolve();
          return;
        }
        setUploading(true);
        try {
          // Caricamento e trascrizione IN PARALLELO: sono due viaggi indipendenti
          // e in serie raddoppiavano l'attesa fra «stop» e la bolla in chat.
          //
          // La trascrizione è il punto della faccenda: un agente da terminale —
          // Claude Code, Codex — NON sente l'audio. Fin qui la nota vocale gli
          // arrivava come `[Voice message: /…/voice-173…webm]`, cioè un percorso a
          // un file che nessun modello può aprire: l'agente rispondeva al nulla, o
          // provava a leggerlo come testo. Il messaggio è quello che hai DETTO; il
          // marcatore col file resta in coda perché la bolla mantenga il suo
          // lettore audio (MessageContent lo riconosce e lo stacca dal testo).
          // Il MOTIVO per cui la trascrizione è saltata non deve restare nella
          // console: è l'unica riga che distingue "chiave scaduta" da "il file
          // che ho registrato non si decodifica", e su un telefono nessuno la
          // legge. Viene raccolto qui e mostrato insieme all'avviso.
          let failure = '';
          const [upload, transcription] = await Promise.all([
            uploadApi.uploadFile(file),
            (await fetchSttCapabilities()).available
              ? transcribeAudio(blob, { filename: file.name }).catch((err: unknown) => {
                  console.error('[voice] transcription failed:', err);
                  failure = err instanceof Error ? err.message : String(err);
                  return null;
                })
              : Promise.resolve(null),
          ]);
          const spoken = transcription?.transcript.trim() ?? '';
          const marker = `[Voice message: ${upload.path}]`;
          if (!spoken) {
            onErrorRef.current?.(
              `Nota vocale inviata senza trascrizione: l'agente riceve solo il file audio, che non può ascoltare.${failure ? ` Motivo: ${failure}` : ''}`,
            );
          }
          // Deliver to the session the recording STARTED on, not whatever
          // topic is active at stop time (see recordingSessionKeyRef above).
          await sendMessage(recordingSessionKeyRef.current ?? sessionKey, spoken ? `${spoken}\n\n${marker}` : marker);
        } catch (err) {
          console.error('Voice upload failed:', err);
          onErrorRef.current?.(`Invio del vocale fallito: ${err instanceof Error ? err.message : 'errore sconosciuto'}`);
        }
        finally { setUploading(false); recordingSessionKeyRef.current = null; }
        resolve();
      };
      recorder.stop();
    });
  }, [sendMessage, sessionKey]);

  useEffect(() => {
    return () => {
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') mediaRecorderRef.current.stop();
      if (streamRef.current) streamRef.current.getTracks().forEach(track => track.stop());
    };
  }, []);

  const formatRecordingTime = (seconds: number): string => {
    const m = Math.floor(seconds / 60); const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return { isRecording, recordingTime, voiceUploading: uploading, startRecording, stopRecording, formatRecordingTime };
}
