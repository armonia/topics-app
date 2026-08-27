import { useState, useRef, useCallback, useEffect } from 'react';
import { releaseAudio } from '../lib/releaseAudio';
import {
  transcribeAudio,
  extForMime,
  pickRecorderMimeType,
  MIN_VOICE_BLOB_BYTES,
  SPEECH_AUDIO_CONSTRAINTS,
  SPEECH_BITS_PER_SECOND,
} from '../lib/stt';
import { attachSilenceDetector, type VadHandle } from '../lib/vad';



// Type definitions for Web Speech API
interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEventType extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEventType extends Event {
  readonly error: string;
}

interface SpeechRecognitionType extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventType) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventType) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

// Speech-to-text hook using Web Speech API (free in browser)
export function useSpeechToText() {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [isSupported, setIsSupported] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionType | null>(null);

  useEffect(() => {
    const win = window as Window & {
      SpeechRecognition?: { new (): SpeechRecognitionType };
      webkitSpeechRecognition?: { new (): SpeechRecognitionType };
    };
    const SpeechRecognitionClass = win.SpeechRecognition || win.webkitSpeechRecognition;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot init syncing an external capability (Web Speech API availability) into state on mount; runs once, no cascade
    setIsSupported(!!SpeechRecognitionClass);
    
    if (SpeechRecognitionClass) {
      const recognition: SpeechRecognitionType = new SpeechRecognitionClass();
      recognition.lang = 'it-IT'; // Italian
      recognition.continuous = true;
      recognition.interimResults = true;
      
      recognition.onresult = (event: SpeechRecognitionEventType) => {
        let finalTranscript = '';
        
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal) {
            finalTranscript += result[0].transcript;
          }
        }
        
        if (finalTranscript) {
          setTranscript(finalTranscript);
        }
      };
      
      recognition.onerror = (event: SpeechRecognitionErrorEventType) => {
        console.error('Speech recognition error:', event.error);
        if (event.error !== 'no-speech') {
          setIsListening(false);
        }
      };
      
      recognition.onend = () => {
        // Will be handled by toggleListening
        setIsListening(false);
      };
      
      recognitionRef.current = recognition;
    }
    
    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.abort();
      }
    };
  }, []);

  const startListening = useCallback(() => {
    if (recognitionRef.current && !isListening) {
      setTranscript('');
      try {
        recognitionRef.current.start();
        setIsListening(true);
      } catch (e) {
        console.error('Failed to start speech recognition:', e);
      }
    }
  }, [isListening]);

  const stopListening = useCallback(() => {
    if (recognitionRef.current && isListening) {
      recognitionRef.current.stop();
      setIsListening(false);
    }
  }, [isListening]);

  const toggleListening = useCallback(() => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  }, [isListening, startListening, stopListening]);

  const clearTranscript = useCallback(() => {
    setTranscript('');
  }, []);

  return {
    isListening,
    transcript,
    isSupported,
    startListening,
    stopListening,
    toggleListening,
    clearTranscript,
  };
}

/**
 * Native fallback, no key required: the browser/webview's own
 * `speechSynthesis`.
 *
 * `/api/tts` (ElevenLabs) answers 500 when `ELEVENLABS_API_KEY` is not
 * configured — which is most of the time, for anyone who never set it.
 * Before this fallback, `speak()` stayed silent in that case: a console
 * error, no audio. ElevenLabs is tried first (better voice, paid) and this
 * one is used only when it is missing or fails — the same cascade shape as
 * STT (`server/lib/stt.ts`), mirrored.
 */
function speakNative(text: string, onEnd: () => void): boolean {
  if (typeof window === 'undefined' || !window.speechSynthesis) return false;
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = onEnd;
    utterance.onerror = onEnd;
    window.speechSynthesis.speak(utterance);
    return true;
  } catch {
    return false;
  }
}

// Text-to-speech hook using server TTS endpoint
export function useTextToSpeech() {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);

  // Resolves when speech has FINISHED (playback end, not start): `await
  // audio.play()` alone resolves at START, not at the end — a caller that
  // needs to know "it's done talking" (the board's voice controller, which
  // then opens the mic) previously had only `isSpeaking` to poll. Existing
  // fire-and-forget callers (e.g. `ChatInput`) stay valid: they don't await
  // the promise, same behaviour as before.
  const speak = useCallback(async (text: string): Promise<void> => {
    if (!text.trim()) return;

    setIsSpeaking(true);

    let url: string | undefined;
    try {
      // Call server TTS endpoint
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      if (!response.ok) {
        throw new Error('TTS failed');
      }

      const blob = await response.blob();
      url = URL.createObjectURL(blob);

      releaseAudio(ttsAudioRef.current);

      const audio = new Audio(url);
      ttsAudioRef.current = audio;

      await new Promise<void>((resolve) => {
        audio.onended = () => {
          setIsSpeaking(false);
          URL.revokeObjectURL(url!);
          resolve();
        };
        audio.onerror = () => {
          setIsSpeaking(false);
          URL.revokeObjectURL(url!);
          resolve();
        };
        audio.play().catch(() => resolve());
      });
    } catch (e) {
      console.error('TTS error, falling back to native speechSynthesis:', e);
      if (url) URL.revokeObjectURL(url);
      await new Promise<void>((resolve) => {
        if (!speakNative(text, () => { setIsSpeaking(false); resolve(); })) {
          setIsSpeaking(false);
          resolve();
        }
      });
    }
  }, []);

  const stop = useCallback(() => {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    if (ttsAudioRef.current) {
      // Rilascio pieno, non solo pausa: chi preme "stop" ha finito di
      // ascoltare, e tenere vivo il renderer costa un thread per sempre.
      releaseAudio(ttsAudioRef.current);
      ttsAudioRef.current = null;
    }
    setIsSpeaking(false);
  }, []);

  useEffect(() => {
    return () => {
      releaseAudio(ttsAudioRef.current);
    };
  }, []);

  return { speak, stop, isSpeaking };
}

/**
 * Voice call: si parla, l'agente risponde a voce, e si ricomincia.
 *
 * Il turno finiva su un cronometro di 5 secondi fissi — non su quando smettevi
 * di parlare. Una frase lunga veniva tagliata a metà, una corta faceva aspettare
 * il resto del tempo, e un pezzo di silenzio puro veniva comunque mandato al
 * modello (che sul silenzio non restituisce vuoto: restituisce «Sottotitoli e
 * revisione a cura di QTSS»). Ora il fine turno è il silenzio, misurato sul
 * rumore vero della stanza — vedi `lib/vad.ts` — e la trascrizione passa dalla
 * porta unica `/api/stt`, cioè dai modelli allo stato dell'arte invece che dal
 * solo whisper locale.
 */
export function useVoiceCall(
  sendMessage: (content: string) => Promise<boolean>,
  currentMessages: { role: string; content: string }[],
  isStreaming: boolean
) {
  const [isCallActive, setIsCallActive] = useState(false);
  // Synchronous mirror of isCallActive: onstop's restart branches (and their
  // pending 500ms timers) capture a stale `isCallActive` and fire AFTER endCall,
  // so a plain state check can't stop them re-acquiring the mic. startCall/endCall
  // flip this ref synchronously and startRecording gates on it.
  const isCallActiveRef = useRef(false);
  const [callStatus, setCallStatus] = useState<'idle' | 'listening' | 'processing' | 'speaking'>('idle');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const vadRef = useRef<VadHandle | null>(null);
  const lastProcessedMsgRef = useRef<number>(0);
  const isSupported = typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

  const transcribeTurn = useCallback(async (audioBlob: Blob): Promise<string> => {
    const result = await transcribeAudio(audioBlob, { filename: `call.${extForMime(audioBlob.type)}` });
    return result.transcript;
  }, []);

  /** Chiude microfono e analisi. Idempotente: viene chiamata dal VAD, da endCall e dallo smontaggio. */
  const releaseMic = useCallback(() => {
    vadRef.current?.stop();
    vadRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
  }, []);

  // Start recording
  const startRecording = useCallback(async () => {
    // Never (re)acquire the mic once the call has ended. onstop's restart
    // branches and any pending 500ms timers fire after endCall — without this
    // guard the mic silently goes hot again with no UI left to stop it.
    if (!isCallActiveRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: SPEECH_AUDIO_CONSTRAINTS });
      streamRef.current = stream;

      try {
        const mimeType = pickRecorderMimeType();
        const mediaRecorder = new MediaRecorder(stream, {
          ...(mimeType ? { mimeType } : {}),
          audioBitsPerSecond: SPEECH_BITS_PER_SECOND,
        });

        audioChunksRef.current = [];

        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            audioChunksRef.current.push(e.data);
          }
        };

        /** Riapre il microfono per il turno successivo, se la chiamata è ancora viva. */
        const relisten = () => {
          setCallStatus('listening');
          setTimeout(() => { void startRecording(); }, 300);
        };

        mediaRecorder.onstop = async () => {
          releaseMic();
          const type = mediaRecorder.mimeType || mimeType || 'audio/webm';
          const chunks = audioChunksRef.current;
          audioChunksRef.current = [];
          // Nessun dato, o solo l'header del container: non c'è niente da
          // trascrivere e nemmeno da pagare.
          if (chunks.length === 0) { relisten(); return; }
          const audioBlob = new Blob(chunks, { type });
          if (audioBlob.size < MIN_VOICE_BLOB_BYTES) { relisten(); return; }

          setCallStatus('processing');
          try {
            const transcript = await transcribeTurn(audioBlob);
            if (transcript.trim()) {
              await sendMessage(transcript.trim());
            } else {
              // Silenzio (o l'artefatto da silenzio, che il server filtra):
              // si torna ad ascoltare senza disturbare l'agente.
              relisten();
            }
          } catch (e) {
            console.error('[VoiceCall] Transcription error:', e);
            relisten();
          }
        };

        mediaRecorderRef.current = mediaRecorder;
        mediaRecorder.start(250);

        // Fine turno sul SILENZIO. Il vecchio taglio a 5 secondi fissi troncava
        // le frasi lunghe e faceva aspettare quelle corte; il tetto duro resta,
        // ma come rete di sicurezza, non come regola.
        const closeTurn = () => {
          if (mediaRecorder.state === 'recording') mediaRecorder.stop();
          else releaseMic();
        };
        vadRef.current = attachSilenceDetector(stream, {
          onSilence: closeTurn,
          onMaxDuration: closeTurn,
          onNoSpeech: closeTurn,
          silenceMs: 1200,
          maxTurnMs: 30_000,
          noSpeechTimeoutMs: 10_000,
        });
      } catch (innerErr) {
        releaseMic();
        throw innerErr;
      }

    } catch (e) {
      console.error('[VoiceCall] Failed to start recording:', e);
    }
  }, [transcribeTurn, sendMessage, releaseMic]);

  // Watch for new assistant messages to speak
  useEffect(() => {
    if (!isCallActive || isStreaming) return;

    const assistantMsgs = currentMessages.filter(m => m.role === 'assistant');
    if (assistantMsgs.length > lastProcessedMsgRef.current) {
      const lastMsg = assistantMsgs[assistantMsgs.length - 1];
      lastProcessedMsgRef.current = assistantMsgs.length;

      if (lastMsg.content && callStatus === 'processing') {
        // Speak the response
        setCallStatus('speaking');
        speakAndResume(lastMsg.content);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- speakAndResume is declared below and stable enough; the lastProcessedMsgRef guard prevents re-speaking the same message, so omitting it avoids re-running on every speakAndResume identity change
  }, [currentMessages, isStreaming, isCallActive, callStatus]);

  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);

  const speakAndResume = useCallback(async (text: string) => {
    try {
      // Call server TTS endpoint (ElevenLabs)
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.slice(0, 1000) }),
      });

      if (!response.ok) {
        throw new Error('TTS failed');
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);

      // Stop any previous audio
      releaseAudio(ttsAudioRef.current);

      const audio = new Audio(url);
      ttsAudioRef.current = audio;

      audio.onended = () => {
        URL.revokeObjectURL(url);
        if (isCallActive) {
          setCallStatus('listening');
          startRecording();
        }
      };

      audio.onerror = () => {
        URL.revokeObjectURL(url);
        if (isCallActive) {
          setCallStatus('listening');
          startRecording();
        }
      };

      await audio.play();
    } catch (e) {
      console.error('TTS error:', e);
      if (isCallActive) {
        setCallStatus('listening');
        startRecording();
      }
    }
  }, [isCallActive, startRecording]);

  const startCall = useCallback(() => {
    isCallActiveRef.current = true;
    setIsCallActive(true);
    setCallStatus('listening');
    lastProcessedMsgRef.current = currentMessages.filter(m => m.role === 'assistant').length;
    startRecording();
  }, [currentMessages, startRecording]);

  const endCall = useCallback(() => {
    isCallActiveRef.current = false;
    setIsCallActive(false);
    setCallStatus('idle');

    // Il VAD si stacca PRIMA del recorder: il suo `onSilence` chiama
    // `mediaRecorder.stop()`, e uno stop già in corso lo farebbe rientrare da
    // dietro riaprendo il microfono su una chiamata appena chiusa.
    releaseMic();
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }

    releaseAudio(ttsAudioRef.current);
    ttsAudioRef.current = null;
  }, [releaseMic]);

  const toggleCall = useCallback(() => {
    if (isCallActive) {
      endCall();
    } else {
      startCall();
    }
  }, [isCallActive, startCall, endCall]);

  // Release the mic/recorder/audio on unmount (e.g. the pane closes mid-call).
  // endCall() otherwise only runs from a user click via toggleCall, so nothing
  // would stop the getUserMedia stream if the component just goes away.
  useEffect(() => {
    return () => {
      isCallActiveRef.current = false;
      vadRef.current?.stop();
      vadRef.current = null;
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }
      releaseAudio(ttsAudioRef.current);
      ttsAudioRef.current = null;
    };
  }, []);

  return {
    isCallActive,
    callStatus,
    isSupported,
    startCall,
    endCall,
    toggleCall,
  };
}
