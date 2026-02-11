import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Paperclip, Mic, MicOff, Volume2, VolumeX, Send, MessageSquare, Phone, PhoneOff, MoreHorizontal } from 'lucide-react';
import type { Topic, ChatMessage } from '../../types';
import { ImageThumbnail } from '../MessageContent';
import { useSpeechToText, useTextToSpeech, useVoiceCall } from '../../hooks/useSpeech';
import { FileMentionMenu, FilePill, type MentionedFile } from './FileMentionMenu';
import { ContextPills, useContextFileTokens } from './ContextPills';

// Available slash commands
const SLASH_COMMANDS = [
  { cmd: '/status', label: 'Status', description: 'Show session status' },
  { cmd: '/clear', label: 'Clear', description: 'Clear conversation' },
  { cmd: '/model', label: 'Model', description: 'Change model (e.g. /model claude-opus-4-5)' },
  { cmd: '/reasoning', label: 'Reasoning', description: 'Toggle reasoning mode' },
  { cmd: '/help', label: 'Help', description: 'Show available commands' },
];

// ---- Overflow Voice Menu ----

function OverflowVoiceMenu({
  isCallActive, isRecording, isListening, isSpeaking, autoTTS,
  voiceCallSupported, sttSupported, currentStreaming, uploading,
  toggleCall, startRecording, stopRecording, toggleListening, stopSpeaking, setAutoTTS,
}: {
  isCallActive: boolean; isRecording: boolean; isListening: boolean; isSpeaking: boolean; autoTTS: boolean;
  voiceCallSupported: boolean; sttSupported: boolean; currentStreaming: boolean; uploading: boolean;
  toggleCall: () => void; startRecording: () => void; stopRecording: () => void;
  toggleListening: () => void; stopSpeaking: () => void; setAutoTTS: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const anyActive = isCallActive || isRecording || isListening || isSpeaking || autoTTS;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`w-10 h-10 flex items-center justify-center rounded-lg transition-all ${
          anyActive
            ? 'text-[var(--primary)] bg-[var(--primary)]/10'
            : 'text-[#999] dark:text-[#666] hover:text-[#555] dark:hover:text-[#ccc] hover:bg-[#f0f0f0] dark:hover:bg-[#2a2a2a]'
        }`}
        title="Voice tools"
        aria-label="Voice tools"
      >
        <MoreHorizontal size={18} />
      </button>
      {open && (
        <div className="absolute bottom-full right-0 mb-1 bg-white dark:bg-[#1e1e1e] border border-[#e0e0e0] dark:border-[#333] rounded-lg shadow-xl z-50 py-1 min-w-[180px]">
          {voiceCallSupported && (
            <button
              type="button"
              onClick={() => { toggleCall(); setOpen(false); }}
              className={`w-full px-3 py-2 text-left flex items-center gap-2.5 text-[12px] transition-colors hover:bg-[#f5f5f5] dark:hover:bg-[#2a2a2a] ${
                isCallActive ? 'text-red-500' : 'text-[#333] dark:text-[#e5e5e5]'
              }`}
              disabled={uploading}
            >
              {isCallActive ? <PhoneOff size={15} /> : <Phone size={15} />}
              {isCallActive ? 'End call' : 'Voice call'}
              <span className="ml-auto text-[10px] text-[#999] dark:text-[#666]">⌘⇧C</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              if (isRecording) stopRecording(); else startRecording();
              setOpen(false);
            }}
            className={`w-full px-3 py-2 text-left flex items-center gap-2.5 text-[12px] transition-colors hover:bg-[#f5f5f5] dark:hover:bg-[#2a2a2a] ${
              isRecording ? 'text-red-500' : 'text-[#333] dark:text-[#e5e5e5]'
            }`}
            disabled={currentStreaming || uploading}
          >
            {isRecording ? <MicOff size={15} /> : <Mic size={15} />}
            {isRecording ? 'Stop recording' : 'Record voice'}
            <span className="ml-auto text-[10px] text-[#999] dark:text-[#666]">⌘⇧R</span>
          </button>
          {sttSupported && !isCallActive && (
            <button
              type="button"
              onClick={() => { toggleListening(); setOpen(false); }}
              className={`w-full px-3 py-2 text-left flex items-center gap-2.5 text-[12px] transition-colors hover:bg-[#f5f5f5] dark:hover:bg-[#2a2a2a] ${
                isListening ? 'text-green-500' : 'text-[#333] dark:text-[#e5e5e5]'
              }`}
              disabled={currentStreaming || uploading}
            >
              {isListening ? <MicOff size={15} /> : <MessageSquare size={15} />}
              {isListening ? 'Stop dictation' : 'Dictation mode'}
              <span className="ml-auto text-[10px] text-[#999] dark:text-[#666]">⌘⇧D</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              if (isSpeaking) stopSpeaking(); else setAutoTTS(prev => !prev);
              setOpen(false);
            }}
            className={`w-full px-3 py-2 text-left flex items-center gap-2.5 text-[12px] transition-colors hover:bg-[#f5f5f5] dark:hover:bg-[#2a2a2a] ${
              isSpeaking || autoTTS ? 'text-blue-500' : 'text-[#333] dark:text-[#e5e5e5]'
            }`}
          >
            {isSpeaking || autoTTS ? <Volume2 size={15} /> : <VolumeX size={15} />}
            {isSpeaking ? 'Stop speaking' : autoTTS ? 'Auto-TTS (ON)' : 'Auto-TTS'}
            <span className="ml-auto text-[10px] text-[#999] dark:text-[#666]">⌘⇧T</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ---- ChatInput ----

interface ChatInputProps {
  isMobile: boolean;
  topic: Topic;
  currentMessages: ChatMessage[];
  currentStreaming: boolean;
  message: string;
  setMessage: (v: string) => void;
  pendingFiles: File[];
  pendingImages: { dataUrl: string; mimeType: string }[];
  setPendingImages: React.Dispatch<React.SetStateAction<{ dataUrl: string; mimeType: string }[]>>;
  uploading: boolean;
  replyingTo: ChatMessage | null;
  setReplyingTo: (v: ChatMessage | null) => void;
  isRecording: boolean;
  recordingTime: number;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onSubmit: (e?: React.FormEvent) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  removePendingFile: (index: number) => void;
  onPaste: (e: React.ClipboardEvent) => void;
  startRecording: () => void;
  stopRecording: () => void;
  formatRecordingTime: (s: number) => string;
  isImageFile: (f: File) => boolean;
  chatError: string | null;
  sendMessageDirect: (content: string) => Promise<boolean>;
  messageQueue: string[];
  othersTyping: boolean;
  othersTypingText: string;
  mentionedFiles: MentionedFile[];
  setMentionedFiles: React.Dispatch<React.SetStateAction<MentionedFile[]>>;
}

export function ChatInput({
  isMobile,
  topic,
  currentMessages,
  currentStreaming,
  message,
  setMessage,
  pendingFiles,
  pendingImages,
  setPendingImages,
  uploading,
  replyingTo,
  setReplyingTo,
  isRecording,
  recordingTime,
  fileInputRef,
  textareaRef,
  onSubmit,
  onKeyDown: parentOnKeyDown,
  onFileSelect,
  removePendingFile,
  onPaste,
  startRecording,
  stopRecording,
  formatRecordingTime,
  isImageFile,
  chatError,
  sendMessageDirect,
  messageQueue,
  othersTyping,
  othersTypingText,
  mentionedFiles,
  setMentionedFiles,
}: ChatInputProps) {
  // Context pills state
  const contextFilePaths = topic.contextFiles || [];
  const contextTokenMap = useContextFileTokens(topic.sessionKey, contextFilePaths);
  const [excludedContextPaths, setExcludedContextPaths] = useState<Set<string>>(new Set());

  const handleToggleContext = useCallback((path: string, currentlyExcluded: boolean) => {
    setExcludedContextPaths(prev => {
      const next = new Set(prev);
      if (currentlyExcluded) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleRemoveContext = useCallback((path: string) => {
    setExcludedContextPaths(prev => {
      const next = new Set(prev);
      next.add(path);
      return next;
    });
  }, []);

  // Slash command menu state
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashMenuIndex, setSlashMenuIndex] = useState(0);
  const [slashFilter, setSlashFilter] = useState('');
  const [showMentionMenu, setShowMentionMenu] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionMenuIndex, setMentionMenuIndex] = useState(0);
  const [mentionStartPos, setMentionStartPos] = useState<number>(-1);

  // Speech-to-text and TTS hooks
  const { isListening, transcript, isSupported: sttSupported, toggleListening, clearTranscript } = useSpeechToText();
  const { speak, stop: stopSpeaking, isSpeaking } = useTextToSpeech();
  const [autoTTS, setAutoTTS] = useState(false);
  
  // Voice Call Mode
  const { isCallActive, callStatus, isSupported: voiceCallSupported, toggleCall } = useVoiceCall(
    sendMessageDirect,
    currentMessages,
    currentStreaming
  );

  // Global keyboard shortcuts for voice features
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      
      if (isMod && e.shiftKey && e.key === 'R') {
        e.preventDefault();
        if (isRecording) stopRecording(); else startRecording();
        return;
      }
      if (isMod && e.shiftKey && e.key === 'C') {
        e.preventDefault();
        if (voiceCallSupported) toggleCall();
        return;
      }
      if (isMod && e.shiftKey && e.key === 'D') {
        e.preventDefault();
        if (sttSupported && !isCallActive) toggleListening();
        return;
      }
      if (isMod && e.shiftKey && e.key === 'T') {
        e.preventDefault();
        setAutoTTS(prev => !prev);
        return;
      }
    };
    
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [toggleCall, toggleListening, voiceCallSupported, sttSupported, isCallActive, isRecording, startRecording, stopRecording]);

  // Sync transcript to message input
  useEffect(() => {
    if (transcript) {
      setMessage(message + ' ' + transcript);
      clearTranscript();
    }
  }, [transcript, clearTranscript]);

  // Auto-TTS for new assistant messages
  useEffect(() => {
    if (!autoTTS) return;
    const lastMsg = currentMessages[currentMessages.length - 1];
    if (lastMsg?.role === 'assistant' && !currentStreaming && lastMsg.content) {
      const textToSpeak = lastMsg.content.slice(0, 500);
      speak(textToSpeak);
    }
  }, [currentMessages, currentStreaming, autoTTS, speak]);

  const filteredSlashCommands = SLASH_COMMANDS.filter(c => 
    c.cmd.toLowerCase().startsWith(slashFilter.toLowerCase())
  );

  const handleMentionSelect = useCallback((file: MentionedFile) => {
    if (mentionStartPos >= 0) {
      const before = message.substring(0, mentionStartPos);
      const afterAtQuery = message.substring(mentionStartPos);
      const spaceIdx = afterAtQuery.indexOf(' ');
      const after = spaceIdx >= 0 ? afterAtQuery.substring(spaceIdx) : '';
      setMessage(before + after);
    }
    if (!mentionedFiles.some(f => f.path === file.path)) {
      setMentionedFiles(prev => [...prev, file]);
    }
    setShowMentionMenu(false);
    setMentionFilter('');
    setMentionStartPos(-1);
    textareaRef.current?.focus();
  }, [mentionStartPos, message, mentionedFiles, setMessage, textareaRef]);

  const handleMessageChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const cursorPos = e.target.selectionStart || 0;
    setMessage(value);
    
    if (value.startsWith('/') && !value.includes(' ')) {
      setShowSlashMenu(true);
      setSlashFilter(value);
      setSlashMenuIndex(0);
      setShowMentionMenu(false);
    } else {
      setShowSlashMenu(false);
      setSlashFilter('');
    }

    if (topic.projectPath) {
      let atPos = -1;
      for (let i = cursorPos - 1; i >= 0; i--) {
        if (value[i] === '@') {
          if (i === 0 || /\s/.test(value[i - 1])) {
            atPos = i;
          }
          break;
        }
        if (/\s/.test(value[i])) break;
      }
      
      if (atPos >= 0) {
        const query = value.substring(atPos + 1, cursorPos);
        setShowMentionMenu(true);
        setMentionFilter(query);
        setMentionMenuIndex(0);
        setMentionStartPos(atPos);
      } else {
        setShowMentionMenu(false);
        setMentionFilter('');
        setMentionStartPos(-1);
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Handle @-mention menu navigation
    if (showMentionMenu) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionMenuIndex(i => i + 1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionMenuIndex(i => Math.max(0, i - 1)); return; }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        const menuEl = document.querySelector('[data-mention-menu]');
        if (menuEl) {
          const selectedBtn = menuEl.querySelector(`[data-mention-idx="${mentionMenuIndex}"]`) as HTMLButtonElement;
          selectedBtn?.click();
        }
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); setShowMentionMenu(false); setMentionStartPos(-1); return; }
    }

    // Handle slash menu navigation
    if (showSlashMenu && filteredSlashCommands.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashMenuIndex(i => (i + 1) % filteredSlashCommands.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashMenuIndex(i => (i - 1 + filteredSlashCommands.length) % filteredSlashCommands.length); return; }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        const selected = filteredSlashCommands[slashMenuIndex];
        if (selected) { setMessage(selected.cmd + ' '); setShowSlashMenu(false); setSlashFilter(''); }
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); setShowSlashMenu(false); return; }
    }
    
    parentOnKeyDown(e);
  };

  return (
    <>
      {/* Pending pasted images */}
      {pendingImages.length > 0 && (
        <div className="px-3 pt-1.5 pb-0 bg-white dark:bg-[#1a1a1a] border-t border-[#f0f0f0] dark:border-[#222] flex-shrink-0">
          <div className="flex flex-wrap gap-1.5">
            {pendingImages.map((img, index) => (
              <div key={index} className="relative inline-block">
                <img src={img.dataUrl} alt="Pasted image" className="h-[100px] max-w-[200px] object-cover rounded-lg border border-gray-300 dark:border-gray-600" />
                <button onClick={() => setPendingImages(prev => prev.filter((_, i) => i !== index))} className="absolute -top-1.5 -right-1.5 bg-red-500 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs hover:bg-red-600">×</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pending files */}
      {pendingFiles.length > 0 && (
        <div className="px-3 pt-1.5 pb-0 bg-white dark:bg-[#1a1a1a] border-t border-[#f0f0f0] dark:border-[#222] flex-shrink-0">
          <div className="flex flex-wrap gap-1.5">
            {pendingFiles.map((file, index) => (
              <div key={index}>
                {isImageFile(file) ? (
                  <ImageThumbnail file={file} onRemove={() => removePendingFile(index)} />
                ) : (
                  <div className="relative flex items-center gap-1.5 bg-[#f5f5f5] dark:bg-[#222] rounded px-2 py-1 text-[11px]">
                    <Paperclip size={15} className="text-[#8b8b8b]" />
                    <span className="max-w-24 truncate text-[#555] dark:text-[#aaa]">{file.name}</span>
                    <button onClick={() => removePendingFile(index)} className="ml-0.5 text-red-400 hover:text-red-500 font-bold text-xs">×</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Voice Call Status Banner */}
      {isCallActive && (
        <div className="px-3 py-2 bg-gradient-to-r from-green-500/20 to-blue-500/20 border-t border-green-500/30 flex items-center gap-3 flex-shrink-0">
          <div className={`w-3 h-3 rounded-full ${
            callStatus === 'listening' ? 'bg-green-500 animate-pulse' :
            callStatus === 'processing' ? 'bg-yellow-500 animate-pulse' :
            callStatus === 'speaking' ? 'bg-blue-500 animate-pulse' :
            'bg-gray-400'
          }`} />
          <div className="flex-1">
            <div className="text-[12px] font-medium text-green-700 dark:text-green-300">
              📞 Voice Call Active
            </div>
            <div className="text-[11px] text-[#666] dark:text-[#999]">
              {callStatus === 'listening' && '🎤 Listening... speak now'}
              {callStatus === 'processing' && '⏳ Processing your message...'}
              {callStatus === 'speaking' && '🔊 Speaking response...'}
            </div>
          </div>
          <button
            onClick={toggleCall}
            className="px-3 py-1 text-[11px] bg-red-500 text-white rounded-md hover:bg-red-600 transition-colors"
          >
            End Call
          </button>
        </div>
      )}

      {/* Orphaned message indicator */}
      {!currentStreaming && currentMessages.length > 0 && currentMessages[currentMessages.length - 1]?.role === 'user' && (
        <div className="px-3 py-2 bg-amber-50 dark:bg-amber-900/20 border-t border-amber-200 dark:border-amber-800/40 flex items-center gap-2 flex-shrink-0">
          <div className="flex-1 min-w-0">
            <div className="text-[11px] text-amber-700 dark:text-amber-400 font-medium">
              No response received
            </div>
            <div className="text-[10px] text-amber-600 dark:text-amber-500">
              The connection may have been interrupted
            </div>
          </div>
          <button
            onClick={() => {
              const lastMsg = currentMessages[currentMessages.length - 1];
              if (lastMsg?.content) sendMessageDirect(lastMsg.content);
            }}
            className="px-3 py-1.5 text-[11px] bg-amber-500 text-white rounded-md hover:bg-amber-600 transition-colors flex items-center gap-1"
          >
            <span>↻</span> Retry
          </button>
        </div>
      )}

      {/* Reply preview */}
      {replyingTo && (
        <div className="px-3 py-1.5 bg-[#fafafa] dark:bg-[#1e1e1e] border-t border-[#e8e8e8] dark:border-[#2a2a2a] flex items-center gap-1.5 flex-shrink-0">
          <div className="w-0.5 h-5 bg-[var(--primary)] rounded-full flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-[10px] text-[#8b8b8b] font-medium">
              Replying to {replyingTo.role === 'user' ? 'yourself' : 'assistant'}
            </div>
            <div className="text-[11px] text-[#666] dark:text-[#aaa] truncate">
              {replyingTo.content.slice(0, 80)}{replyingTo.content.length > 80 ? '…' : ''}
            </div>
          </div>
          <button onClick={() => setReplyingTo(null)} className="text-[#8b8b8b] hover:text-[#555] dark:hover:text-[#ccc] p-0.5">
            <X size={13} />
          </button>
        </div>
      )}

      {/* Others typing indicator */}
      {othersTyping && (
        <div className="px-3 py-1.5 border-t border-[#e8e8e8] dark:border-[#2a2a2a] bg-[#fafafa] dark:bg-[#1e1e1e]">
          <div className="flex items-start gap-2">
            <div className="flex gap-1 mt-1.5 flex-shrink-0">
              <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
            <div className="text-[12px] text-[#666] dark:text-[#999] italic min-w-0 truncate">
              {othersTypingText || 'typing...'}
            </div>
          </div>
        </div>
      )}

      {/* Context pills */}
      {(mentionedFiles.length > 0 || contextFilePaths.length > 0) && (
        <div className="px-3 py-1.5 bg-white dark:bg-[#1a1a1a] border-t border-[#f0f0f0] dark:border-[#222] flex-shrink-0">
          <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide">
            <span className="text-[10px] text-[#888] dark:text-[#666] font-medium flex-shrink-0">Context</span>
            {contextFilePaths.length > 0 && (
              <ContextPills
                files={contextFilePaths.map(cf => ({
                  name: cf.split('/').pop() || cf,
                  path: cf,
                  tokens: contextTokenMap.get(cf),
                  type: cf.toLowerCase().includes('claude') ? 'claude' as const : 'context' as const,
                }))}
                excludedPaths={excludedContextPaths}
                onToggle={handleToggleContext}
                onRemove={handleRemoveContext}
                compact
              />
            )}
            {mentionedFiles.map((file, idx) => (
              <FilePill
                key={file.path}
                file={file}
                onRemove={() => setMentionedFiles(prev => prev.filter((_, i) => i !== idx))}
              />
            ))}
          </div>
        </div>
      )}

      {/* Input area */}
      <form onSubmit={onSubmit} className="px-3 py-2 border-t border-[#e8e8e8] dark:border-[#2a2a2a] bg-white dark:bg-[#1a1a1a] flex-shrink-0" style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom, 0px))' }}>
        {isRecording ? (
          <div className="flex gap-2 items-center mb-2">
            <div className="flex-1 flex items-center gap-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40 rounded-xl px-3 py-2.5">
              <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
              <span className="text-red-500 font-medium text-[12px]">Recording</span>
              <span className="text-red-400 font-mono text-[12px]">{formatRecordingTime(recordingTime)}</span>
            </div>
            <button type="button" onClick={stopRecording} className="bg-red-500 text-white px-4 py-2.5 rounded-xl hover:bg-red-600 transition-colors flex items-center gap-1.5 text-[12px] font-medium">
              Stop
            </button>
          </div>
        ) : (
          <>
            <div className="relative input-glow rounded-xl flex items-end border border-[#e0e0e0] dark:border-[#333] bg-[#fafafa] dark:bg-[#222] focus-within:border-[var(--primary)] dark:focus-within:border-[var(--primary)] transition-all">
              <div className="flex items-center gap-0.5 pl-1.5 pb-[7px] flex-shrink-0">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-10 h-10 flex items-center justify-center rounded-lg text-[#999] dark:text-[#666] hover:text-[var(--primary)] dark:hover:text-[var(--primary)] hover:bg-[#f0f0f0] dark:hover:bg-[#2a2a2a] transition-all"
                  title="Attach file (⌘U)"
                  aria-label="Attach file"
                  disabled={currentStreaming}
                >
                  <Paperclip size={18} />
                </button>
              </div>

              <textarea
                ref={textareaRef}
                value={message}
                onChange={handleMessageChange}
                onKeyDown={handleKeyDown}
                onPaste={onPaste}
                aria-label="Message input"
                placeholder={replyingTo ? 'Reply...' : topic.projectPath ? 'Message... (@ to mention files)' : 'Message...'}
                className={`flex-1 px-1.5 py-2.5 min-w-0 bg-transparent text-[#1a1a1a] dark:text-[#e5e5e5] placeholder-[#b0b0b0] dark:placeholder-[#555] resize-none overflow-y-auto focus:outline-none ${isMobile ? 'text-[16px]' : 'text-[13px]'}`}
                style={{ minHeight: '40px', maxHeight: '140px' }}
                rows={1}
                disabled={uploading}
              />

              <div className="flex items-center gap-0.5 pr-1.5 pb-[7px] flex-shrink-0 relative">
                {!isMobile && (
                  <OverflowVoiceMenu
                    isCallActive={isCallActive}
                    isRecording={isRecording}
                    isListening={isListening}
                    isSpeaking={isSpeaking}
                    autoTTS={autoTTS}
                    voiceCallSupported={voiceCallSupported}
                    sttSupported={sttSupported}
                    currentStreaming={currentStreaming}
                    uploading={uploading}
                    toggleCall={toggleCall}
                    startRecording={startRecording}
                    stopRecording={stopRecording}
                    toggleListening={toggleListening}
                    stopSpeaking={stopSpeaking}
                    setAutoTTS={setAutoTTS}
                  />
                )}

                <button
                  type="submit"
                  disabled={(!message.trim() && pendingFiles.length === 0 && pendingImages.length === 0) || uploading}
                  className={`w-10 h-10 flex items-center justify-center rounded-lg transition-all ${
                    uploading
                      ? 'bg-[var(--primary)] text-white'
                      : currentStreaming && message.trim()
                        ? 'bg-orange-500 text-white hover:bg-orange-600'
                        : (message.trim() || pendingFiles.length > 0 || pendingImages.length > 0)
                          ? 'bg-[var(--primary)] text-white hover:bg-[#0055dd]'
                          : 'bg-transparent text-[#b0b0b0] dark:text-[#555]'
                  }`}
                  title={currentStreaming && message.trim() ? 'Queue message (Enter)' : 'Send (Enter)'}
                  aria-label="Send message"
                >
                  {uploading ? (
                    <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <Send size={16} />
                  )}
                </button>
              </div>

              {/* Slash command menu */}
              {showSlashMenu && filteredSlashCommands.length > 0 && (
                <div className="absolute bottom-full left-0 right-0 mb-1 bg-white dark:bg-[#1e1e1e] border border-[#e0e0e0] dark:border-[#333] rounded-lg shadow-xl z-50 py-1 overflow-hidden max-h-48 overflow-y-auto">
                  {filteredSlashCommands.map((cmd, idx) => (
                    <button
                      key={cmd.cmd}
                      type="button"
                      onClick={() => {
                        setMessage(cmd.cmd + ' ');
                        setShowSlashMenu(false);
                        setSlashFilter('');
                        textareaRef.current?.focus();
                      }}
                      className={`w-full px-3 py-1.5 text-left flex items-center gap-3 transition-colors ${
                        idx === slashMenuIndex 
                          ? 'bg-[var(--primary)]/15 text-[#1a1a1a] dark:text-white' 
                          : 'text-[#333] dark:text-[#e5e5e5] hover:bg-[#f5f5f5] dark:hover:bg-[#2a2a2a]'
                      }`}
                    >
                      <span className="text-[12px] font-mono text-[var(--primary)]">{cmd.cmd}</span>
                      <span className="text-[11px] text-[#888]">{cmd.description}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* @-mention file menu */}
              {topic.projectPath && (
                <FileMentionMenu
                  projectPath={topic.projectPath}
                  visible={showMentionMenu}
                  filter={mentionFilter}
                  onSelect={handleMentionSelect}
                  onClose={() => { setShowMentionMenu(false); setMentionStartPos(-1); }}
                  selectedIndex={mentionMenuIndex}
                  onIndexChange={setMentionMenuIndex}
                />
              )}
            </div>
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={onFileSelect} />
          </>
        )}
        {chatError && <div className="text-red-500 text-[11px] mt-0.5">{chatError}</div>}
        {messageQueue.length > 0 && (
          <div className="text-[11px] mt-1 text-orange-500 flex items-center gap-1.5">
            ({messageQueue.length} message{messageQueue.length > 1 ? 's' : ''} queued)
          </div>
        )}
      </form>
    </>
  );
}
