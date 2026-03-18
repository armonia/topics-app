import { useState, useRef, useCallback, useEffect } from 'react';

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
    const SpeechRecognitionClass = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
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

// Text-to-speech hook using server TTS endpoint
export function useTextToSpeech() {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);

  const speak = useCallback(async (text: string) => {
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

      if (ttsAudioRef.current) {
        ttsAudioRef.current.pause();
        URL.revokeObjectURL(ttsAudioRef.current.src);
      }

      const audio = new Audio(url);
      ttsAudioRef.current = audio;

      audio.onended = () => {
        setIsSpeaking(false);
        URL.revokeObjectURL(url!);
      };

      audio.onerror = () => {
        setIsSpeaking(false);
        URL.revokeObjectURL(url!);
      };

      await audio.play();
    } catch (e) {
      console.error('TTS error:', e);
      setIsSpeaking(false);
      if (url) URL.revokeObjectURL(url);
    }
  }, []);

  const stop = useCallback(() => {
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause();
      ttsAudioRef.current.currentTime = 0;
      setIsSpeaking(false);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (ttsAudioRef.current) {
        ttsAudioRef.current.pause();
        URL.revokeObjectURL(ttsAudioRef.current.src);
      }
    };
  }, []);

  return { speak, stop, isSpeaking };
}

// Voice Call Mode - continuous voice conversation using local Whisper
export function useVoiceCall(
  sendMessage: (content: string) => Promise<boolean>,
  currentMessages: { role: string; content: string }[],
  isStreaming: boolean
) {
  const [isCallActive, setIsCallActive] = useState(false);
  const [callStatus, setCallStatus] = useState<'idle' | 'listening' | 'processing' | 'speaking'>('idle');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const silenceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastProcessedMsgRef = useRef<number>(0);
  const isSupported = typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

  // Transcribe audio using local Whisper
  const transcribeAudio = useCallback(async (audioBlob: Blob): Promise<string> => {
    const formData = new FormData();
    formData.append('audio', audioBlob, 'recording.webm');
    
    const response = await fetch('/api/stt', {
      method: 'POST',
      body: formData,
    });
    
    if (!response.ok) {
      throw new Error('STT failed');
    }
    
    const data = await response.json();
    return data.transcript || '';
  }, []);

  // Start recording
  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      try {
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm';

        const mediaRecorder = new MediaRecorder(stream, { mimeType });

        audioChunksRef.current = [];

        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            audioChunksRef.current.push(e.data);
          }
        };

        mediaRecorder.onstop = async () => {
          if (audioChunksRef.current.length === 0) {
            setCallStatus('listening');
            setTimeout(() => startRecording(), 500);
            return;
          }

          const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
          audioChunksRef.current = [];

          setCallStatus('processing');

          try {
            const transcript = await transcribeAudio(audioBlob);
            if (transcript.trim()) {
              await sendMessage(transcript.trim());
            } else {
              setCallStatus('listening');
              setTimeout(() => startRecording(), 500);
            }
          } catch (e) {
            console.error('[VoiceCall] Transcription error:', e);
            setCallStatus('listening');
            setTimeout(() => startRecording(), 500);
          }
        };

        mediaRecorderRef.current = mediaRecorder;
        mediaRecorder.start(1000); // Request data every second

        // Auto-stop after 5 seconds of recording
        silenceTimeoutRef.current = setTimeout(() => {
          if (mediaRecorder.state === 'recording') {
            mediaRecorder.stop();
            if (streamRef.current) {
              streamRef.current.getTracks().forEach(t => t.stop());
              streamRef.current = null;
            }
          }
        }, 5000);
      } catch (innerErr) {
        stream.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        throw innerErr;
      }

    } catch (e) {
      console.error('[VoiceCall] Failed to start recording:', e);
    }
  }, [transcribeAudio, sendMessage]);

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
      if (ttsAudioRef.current) {
        ttsAudioRef.current.pause();
        URL.revokeObjectURL(ttsAudioRef.current.src);
      }

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
    setIsCallActive(true);
    setCallStatus('listening');
    lastProcessedMsgRef.current = currentMessages.filter(m => m.role === 'assistant').length;
    startRecording();
  }, [currentMessages, startRecording]);

  const endCall = useCallback(() => {
    setIsCallActive(false);
    setCallStatus('idle');
    
    if (silenceTimeoutRef.current) {
      clearTimeout(silenceTimeoutRef.current);
    }
    
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }

    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause();
      URL.revokeObjectURL(ttsAudioRef.current.src);
      ttsAudioRef.current = null;
    }
  }, []);

  const toggleCall = useCallback(() => {
    if (isCallActive) {
      endCall();
    } else {
      startCall();
    }
  }, [isCallActive, startCall, endCall]);

  return {
    isCallActive,
    callStatus,
    isSupported,
    startCall,
    endCall,
    toggleCall,
  };
}
