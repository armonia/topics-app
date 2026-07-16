import { useEffect, useRef } from 'react';
import { Mic, Send, X, Copy, CheckCircle } from 'lucide-react';
import { useSpeechToText } from '../../hooks/useSpeech';
import { useVoiceTaskDialog } from '../../state/voiceTaskDialog';
import { MODAL_BACKDROP } from '../../lib/modalStyles';

interface VoiceTaskDialogProps {
  onSubmit: (transcript: string) => Promise<void>;
  isSubmitting?: boolean;
}

export function VoiceTaskDialog({ onSubmit, isSubmitting = false }: VoiceTaskDialogProps) {
  const {
    isOpen,
    transcript,
    isListening,
    lastCreatedTaskId,
    lastCreatedTaskTitle,
    close,
    setIsListening,
    clearTranscript,
  } = useVoiceTaskDialog();

  const { isListening: isSpeechListening, transcript: speechTranscript, toggleListening, clearTranscript: clearSpeechTranscript } = useSpeechToText();
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { setTranscript } = useVoiceTaskDialog();

  // Mirror speech hook state to dialog store
  useEffect(() => {
    setIsListening(isSpeechListening);
  }, [isSpeechListening, setIsListening]);

  // Sync speech transcript to dialog store
  useEffect(() => {
    setTranscript(speechTranscript);
  }, [speechTranscript, setTranscript]);

  // Stop speech recognition on close
  useEffect(() => {
    return () => {
      if (isSpeechListening) {
        toggleListening();
      }
    };
  }, [isSpeechListening, toggleListening]);

  if (!isOpen) return null;

  const handleToggleMic = () => {
    if (!isSpeechListening) {
      clearTranscript();
      clearSpeechTranscript();
    }
    toggleListening();
  };

  const handleSubmit = async () => {
    if (!transcript.trim()) return;
    try {
      await onSubmit(transcript);
      clearTranscript();
      if (isSpeechListening) toggleListening();
    } catch (e) {
      console.error('[VoiceTaskDialog] Submit error:', e);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(transcript);
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    // TODO: show toast feedback
    copyTimeoutRef.current = setTimeout(() => {}, 2000);
  };

  const handleClose = () => {
    if (isSpeechListening) toggleListening();
    clearTranscript();
    close();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={handleClose}>
      <div className={MODAL_BACKDROP} />
      <div
        className="relative w-full max-w-md mx-4 mb-4 bg-surface rounded-xl shadow-2xl border border-app-border overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-app-border">
          <h3 className="text-[14px] font-semibold text-app-text">Describe Task for Agent</h3>
          <button
            onClick={handleClose}
            className="text-app-text-muted hover:text-app-text-secondary transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-3">
          {/* Transcript display */}
          <div className="min-h-[80px] p-3 bg-code-bg rounded border border-app-border text-[13px] text-app-text leading-relaxed">
            {transcript || (
              <span className="text-app-text-muted italic">
                {isListening ? 'Listening...' : 'Click the mic to start describing your task'}
              </span>
            )}
          </div>

          {/* Last created task indicator */}
          {lastCreatedTaskId && lastCreatedTaskTitle && (
            <div className="flex items-center gap-2 p-2 bg-green-500/10 border border-green-500/30 rounded text-[12px] text-green-600 dark:text-green-400">
              <CheckCircle size={14} />
              <span>Task #{lastCreatedTaskId} created</span>
            </div>
          )}

          {/* Status */}
          <div className="text-[11px] text-app-text-muted">
            Status: {isSubmitting ? 'Creating...' : isListening ? 'Recording' : 'Ready'}
          </div>

          {/* Controls */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleToggleMic}
              disabled={isSubmitting}
              className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded font-medium text-[13px] transition-colors ${
                isListening
                  ? 'bg-red-500 text-white hover:bg-red-600 disabled:opacity-50'
                  : 'bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50'
              }`}
            >
              <Mic size={16} />
              {isListening ? 'Stop' : 'Record'}
            </button>

            {transcript && (
              <button
                onClick={handleCopy}
                className="p-2 text-app-text-muted hover:text-app-text-secondary transition-colors rounded hover:bg-surface-secondary"
                title="Copy"
              >
                <Copy size={16} />
              </button>
            )}

            <button
              onClick={handleSubmit}
              disabled={!transcript.trim() || isSubmitting}
              className="flex items-center justify-center gap-2 py-2 px-3 rounded font-medium text-[13px] bg-green-500 text-white hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Send size={16} />
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
