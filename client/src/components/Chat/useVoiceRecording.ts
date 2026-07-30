import { useState, useRef, useCallback, useEffect } from 'react';
import { uploadApi } from '../../lib/api';

/**
 * Floor under which a recording carries no speech: an accidental start/stop
 * (the ⌘⇧R chord toggling twice, a pane unmounting mid-record) yields zero data
 * chunks or a container header with no audio in it. Uploading those posted a
 * real `[Voice message: …]` bubble into the transcript that played silence —
 * the "random empty voice note at the end of a chat". Opus at ~24kbps clears
 * this in well under half a second, so no genuine note is dropped.
 */
const MIN_VOICE_BLOB_BYTES = 512;

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
  // switches (reconcile-not-remount, see its fastMode/planMode effects), so
  // stopRecording's closure would otherwise read the CURRENT sessionKey — a
  // voice note recorded on topic A but stopped after switching to B was
  // delivered into B's history.
  const recordingSessionKeyRef = useRef<string | null>(null);

  const getSupportedMimeType = useCallback((): string => {
    // Safari supports mp4/aac, Chrome/Firefox support webm/opus
    const types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'];
    for (const type of types) { if (MediaRecorder.isTypeSupported(type)) return type; }
    return '';
  }, []);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = getSupportedMimeType();
      const options: MediaRecorderOptions = mimeType ? { mimeType } : {};
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
      // On mobile Safari over HTTP, getUserMedia is blocked silently
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('secure') || msg.includes('NotAllowed') || msg.includes('Permission')) {
        onError?.('Microfono non disponibile: serve HTTPS (o il permesso è stato negato).');
      } else {
        onError?.(`Registrazione non partita: ${msg}`);
      }
    }
  }, [getSupportedMimeType, sessionKey, onError]);

  const stopRecording = useCallback(async (): Promise<void> => {
    return new Promise((resolve) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state === 'inactive') { resolve(); return; }
      recorder.onstop = async () => {
        if (recordingTimerRef.current) { clearInterval(recordingTimerRef.current); recordingTimerRef.current = null; }
        if (streamRef.current) { streamRef.current.getTracks().forEach(track => track.stop()); streamRef.current = null; }
        const mimeType = recorder.mimeType || 'audio/webm';
        const ext = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('ogg') ? 'ogg' : 'webm';
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: mimeType });
        setIsRecording(false);
        setRecordingTime(0);
        // Silence is not a message: drop an empty/header-only capture instead of
        // uploading it and sending a `[Voice message: …]` bubble for it.
        if (audioChunksRef.current.length === 0 || blob.size < MIN_VOICE_BLOB_BYTES) {
          console.warn(`[voice] discarded empty recording (${blob.size}B) — nothing sent`);
          audioChunksRef.current = [];
          recordingSessionKeyRef.current = null;
          resolve();
          return;
        }
        setUploading(true);
        try {
          const result = await uploadApi.uploadFile(file);
          // Deliver to the session the recording STARTED on, not whatever
          // topic is active at stop time (see recordingSessionKeyRef above).
          await sendMessage(recordingSessionKeyRef.current ?? sessionKey, `[Voice message: ${result.path}]`);
        } catch (err) {
          console.error('Voice upload failed:', err);
          onError?.(`Invio del vocale fallito: ${err instanceof Error ? err.message : 'errore sconosciuto'}`);
        }
        finally { setUploading(false); recordingSessionKeyRef.current = null; }
        resolve();
      };
      recorder.stop();
    });
  }, [sendMessage, sessionKey, onError]);

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
