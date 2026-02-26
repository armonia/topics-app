import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Paperclip, Mic, MicOff, Volume2, VolumeX, Send, MessageSquare, Phone, PhoneOff, MoreHorizontal, ClipboardList, Zap, Trash2, Cpu, Brain, HelpCircle, Users, Pause, Play, UserPlus } from 'lucide-react';
import type { Topic, ChatMessage } from '../../types';
import { ImageThumbnail } from '../MessageContent';
import { useSpeechToText, useTextToSpeech, useVoiceCall } from '../../hooks/useSpeech';
import { FileMentionMenu, FilePill, type MentionedFile } from './FileMentionMenu';
import { ContextPills, useContextFileTokens } from './ContextPills';
import { MentionAutocomplete } from './MentionAutocomplete';
import { ShortcutHint } from '../Shared/KeyboardShortcuts';

// Available slash commands
const SLASH_COMMANDS = [
  { cmd: '/status', label: 'Status', description: 'Show session status', icon: Zap },
  { cmd: '/clear', label: 'Clear', description: 'Clear conversation', icon: Trash2 },
  { cmd: '/model', label: 'Model', description: 'Change model', icon: Cpu },
  { cmd: '/reasoning', label: 'Reasoning', description: 'Toggle reasoning mode', icon: Brain },
  { cmd: '/agents', label: 'Agents', description: 'List agent profiles', icon: Users },
  { cmd: '/pause', label: 'Pause', description: 'Pause agent (@name)', icon: Pause },
  { cmd: '/resume', label: 'Resume', description: 'Resume agent (@name)', icon: Play },
  { cmd: '/assign', label: 'Assign', description: 'Assign task (@name task)', icon: UserPlus },
  { cmd: '/help', label: 'Help', description: 'Show available commands', icon: HelpCircle },
];

// ---- Overflow Menu (slash commands + voice tools) ----

function OverflowMenu({
  isCallActive, isRecording, isListening, isSpeaking, autoTTS,
  voiceCallSupported, sttSupported, currentStreaming, uploading,
  toggleCall, startRecording, stopRecording, toggleListening, stopSpeaking, setAutoTTS,
  onSlashCommand,
}: {
  isCallActive: boolean; isRecording: boolean; isListening: boolean; isSpeaking: boolean; autoTTS: boolean;
  voiceCallSupported: boolean; sttSupported: boolean; currentStreaming: boolean; uploading: boolean;
  toggleCall: () => void; startRecording: () => void; stopRecording: () => void;
  toggleListening: () => void; stopSpeaking: () => void; setAutoTTS: React.Dispatch<React.SetStateAction<boolean>>;
  onSlashCommand: (cmd: string) => void;
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
        className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all ${
          anyActive
            ? 'text-primary bg-primary/10'
            : 'text-app-text-muted hover:text-app-text hover:bg-app-hover'
        }`}
        title="Tools & commands"
        aria-label="Tools & commands"
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div className="absolute bottom-full right-0 mb-1 bg-surface border border-app-border-light rounded-lg shadow-xl z-50 py-1 min-w-[200px]">
          {/* Slash commands */}
          {SLASH_COMMANDS.map((cmd) => {
            const Icon = cmd.icon;
            return (
              <button
                key={cmd.cmd}
                type="button"
                onClick={() => { onSlashCommand(cmd.cmd); setOpen(false); }}
                className="w-full px-3 py-1.5 text-left flex items-center gap-2.5 text-[12px] transition-colors hover:bg-app-hover text-app-text"
              >
                <Icon size={14} className="text-app-text-muted flex-shrink-0" />
                <span className="font-mono text-primary text-[11px]">{cmd.cmd}</span>
                <span className="ml-auto text-[10px] text-app-text-muted">{cmd.description}</span>
              </button>
            );
          })}

          {/* Divider */}
          <div className="h-px bg-app-border my-1" />

          {/* Voice tools */}
          {voiceCallSupported && (
            <button
              type="button"
              onClick={() => { toggleCall(); setOpen(false); }}
              className={`w-full px-3 py-1.5 text-left flex items-center gap-2.5 text-[12px] transition-colors hover:bg-app-hover ${
                isCallActive ? 'text-red-500' : 'text-app-text'
              }`}
              disabled={uploading}
            >
              {isCallActive ? <PhoneOff size={14} /> : <Phone size={14} />}
              {isCallActive ? 'End call' : 'Voice call'}
              <span className="ml-auto text-[10px] text-app-text-muted">⌘⇧C</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              if (isRecording) stopRecording(); else startRecording();
              setOpen(false);
            }}
            className={`w-full px-3 py-1.5 text-left flex items-center gap-2.5 text-[12px] transition-colors hover:bg-app-hover ${
              isRecording ? 'text-red-500' : 'text-app-text'
            }`}
            disabled={currentStreaming || uploading}
          >
            {isRecording ? <MicOff size={14} /> : <Mic size={14} />}
            {isRecording ? 'Stop recording' : 'Record voice'}
            <span className="ml-auto text-[10px] text-app-text-muted">⌘⇧R</span>
          </button>
          {sttSupported && !isCallActive && (
            <button
              type="button"
              onClick={() => { toggleListening(); setOpen(false); }}
              className={`w-full px-3 py-1.5 text-left flex items-center gap-2.5 text-[12px] transition-colors hover:bg-app-hover ${
                isListening ? 'text-green-500' : 'text-app-text'
              }`}
              disabled={currentStreaming || uploading}
            >
              {isListening ? <MicOff size={14} /> : <MessageSquare size={14} />}
              {isListening ? 'Stop dictation' : 'Dictation mode'}
              <span className="ml-auto text-[10px] text-app-text-muted">⌘⇧D</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              if (isSpeaking) stopSpeaking(); else setAutoTTS(prev => !prev);
              setOpen(false);
            }}
            className={`w-full px-3 py-1.5 text-left flex items-center gap-2.5 text-[12px] transition-colors hover:bg-app-hover ${
              isSpeaking || autoTTS ? 'text-blue-500' : 'text-app-text'
            }`}
          >
            {isSpeaking || autoTTS ? <Volume2 size={14} /> : <VolumeX size={14} />}
            {isSpeaking ? 'Stop speaking' : autoTTS ? 'Auto-TTS (ON)' : 'Auto-TTS'}
            <span className="ml-auto text-[10px] text-app-text-muted">⌘⇧T</span>
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
  planMode?: boolean;
  onTogglePlanMode?: () => void;
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
  planMode,
  onTogglePlanMode,
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

  // Agent @mention state
  const [showAgentMention, setShowAgentMention] = useState(false);
  const [agentMentionQuery, setAgentMentionQuery] = useState('');
  const [agentMentionPos, setAgentMentionPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [agentMentionStartPos, setAgentMentionStartPos] = useState<number>(-1);

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

    // Detect @ trigger for mentions (agent or file)
    {
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

        // Show file mention menu if project path exists
        if (topic.projectPath) {
          setShowMentionMenu(true);
          setMentionFilter(query);
          setMentionMenuIndex(0);
          setMentionStartPos(atPos);
        }

        // Show agent @mention autocomplete
        const ta = textareaRef.current;
        if (ta) {
          const rect = ta.getBoundingClientRect();
          setAgentMentionPos({ top: rect.top - 4, left: rect.left + 12 });
        }
        setShowAgentMention(true);
        setAgentMentionQuery(query);
        setAgentMentionStartPos(atPos);
      } else {
        if (topic.projectPath) {
          setShowMentionMenu(false);
          setMentionFilter('');
          setMentionStartPos(-1);
        }
        setShowAgentMention(false);
        setAgentMentionQuery('');
        setAgentMentionStartPos(-1);
      }
    }
  };

  const handleAgentMentionSelect = useCallback((name: string) => {
    if (agentMentionStartPos >= 0) {
      const before = message.substring(0, agentMentionStartPos);
      const afterAt = message.substring(agentMentionStartPos);
      const spaceIdx = afterAt.indexOf(' ', 1);
      const after = spaceIdx >= 0 ? afterAt.substring(spaceIdx) : '';
      setMessage(before + '@' + name + ' ' + after.trimStart());
    }
    setShowAgentMention(false);
    setAgentMentionQuery('');
    setAgentMentionStartPos(-1);
    // Also dismiss file mention if open
    setShowMentionMenu(false);
    setMentionStartPos(-1);
    textareaRef.current?.focus();
  }, [agentMentionStartPos, message, setMessage, textareaRef]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Handle agent @-mention autocomplete navigation
    // MentionAutocomplete uses a document-level keydown capture listener,
    // so we just need to prevent defaults here to avoid conflicts.
    if (showAgentMention) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowAgentMention(false);
        setAgentMentionStartPos(-1);
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        // MentionAutocomplete handles these via its document-level capture listener
        return;
      }
    }

    // Handle file @-mention menu navigation
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

  const hasAttachments = pendingImages.length > 0 || pendingFiles.length > 0;
  const hasContext = mentionedFiles.length > 0 || contextFilePaths.length > 0;

  return (
    <>
      {/* Status banners (outside floating card) */}
      {isCallActive && (
        <div className={`${isMobile ? 'mx-2' : 'mx-3'} mb-1 rounded-xl bg-gradient-to-r from-green-500/20 to-blue-500/20 border border-green-500/30 px-3 py-2 flex items-center gap-3 flex-shrink-0`}>
          <div className={`w-3 h-3 rounded-full ${
            callStatus === 'listening' ? 'bg-green-500 animate-pulse' :
            callStatus === 'processing' ? 'bg-yellow-500 animate-pulse' :
            callStatus === 'speaking' ? 'bg-blue-500 animate-pulse' :
            'bg-gray-400'
          }`} />
          <div className="flex-1">
            <div className="text-[12px] font-medium text-green-700 dark:text-green-300">Voice Call Active</div>
            <div className="text-[11px] text-app-text-secondary">
              {callStatus === 'listening' && 'Listening... speak now'}
              {callStatus === 'processing' && 'Processing your message...'}
              {callStatus === 'speaking' && 'Speaking response...'}
            </div>
          </div>
          <button onClick={toggleCall} className="px-3 py-1 text-[11px] bg-red-500 text-white rounded-md hover:bg-red-600 transition-colors">End Call</button>
        </div>
      )}

      {!currentStreaming && currentMessages.length > 0 && currentMessages[currentMessages.length - 1]?.role === 'user' && (
        <div className={`${isMobile ? 'mx-2' : 'mx-3'} mb-1 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40 px-3 py-2 flex items-center gap-2 flex-shrink-0`}>
          <div className="flex-1 min-w-0">
            <div className="text-[11px] text-amber-700 dark:text-amber-400 font-medium">No response received</div>
            <div className="text-[10px] text-amber-600 dark:text-amber-500">The connection may have been interrupted</div>
          </div>
          <button
            onClick={() => { const lastMsg = currentMessages[currentMessages.length - 1]; if (lastMsg?.content) sendMessageDirect(lastMsg.content); }}
            className="px-3 py-1.5 text-[11px] bg-amber-500 text-white rounded-md hover:bg-amber-600 transition-colors flex items-center gap-1"
          >
            <span>↻</span> Retry
          </button>
        </div>
      )}

      {othersTyping && (
        <div className={`${isMobile ? 'mx-2' : 'mx-3'} mb-1 flex items-center gap-2 px-3`}>
          <div className="flex gap-1 flex-shrink-0">
            <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
          <div className="text-[11px] text-app-text-secondary italic min-w-0 truncate">{othersTypingText || 'typing...'}</div>
        </div>
      )}

      {/* Floating input card */}
      <form
        onSubmit={onSubmit}
        className={`relative ${isMobile ? 'mx-2 mb-1.5' : 'mx-3 mb-2'} rounded-2xl shadow-md border ${planMode ? 'border-indigo-400 dark:border-indigo-500/50 focus-within:border-indigo-400' : 'border-app-border-light focus-within:border-primary'} bg-surface flex-shrink-0 transition-colors`}
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        {isRecording ? (
          <div className="flex gap-2 items-center p-3">
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
            {/* Row 0: Attachments preview (inside card) */}
            {hasAttachments && (
              <div className="px-3 pt-2.5 flex flex-wrap gap-1.5">
                {pendingImages.map((img, index) => (
                  <div key={`img-${index}`} className="relative inline-block">
                    <img src={img.dataUrl} alt="Pasted image" className="h-[80px] max-w-[160px] object-cover rounded-lg border border-app-border-light" />
                    <button onClick={() => setPendingImages(prev => prev.filter((_, i) => i !== index))} className="absolute -top-1.5 -right-1.5 bg-red-500 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs hover:bg-red-600">×</button>
                  </div>
                ))}
                {pendingFiles.map((file, index) => (
                  <div key={`file-${index}`}>
                    {isImageFile(file) ? (
                      <ImageThumbnail file={file} onRemove={() => removePendingFile(index)} />
                    ) : (
                      <div className="relative flex items-center gap-1.5 bg-app-hover rounded-lg px-2 py-1 text-[11px]">
                        <Paperclip size={14} className="text-app-text-tertiary" />
                        <span className="max-w-24 truncate text-app-text-secondary">{file.name}</span>
                        <button onClick={() => removePendingFile(index)} className="ml-0.5 text-red-400 hover:text-red-500 font-bold text-xs">×</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Row 0b: Reply preview (inside card) */}
            {replyingTo && (
              <div className="mx-3 mt-2 flex items-center gap-1.5">
                <div className="w-0.5 h-5 bg-primary rounded-full flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] text-app-text-tertiary font-medium">
                    Replying to {replyingTo.role === 'user' ? 'yourself' : 'assistant'}
                  </div>
                  <div className="text-[11px] text-app-text-secondary truncate">
                    {replyingTo.content.slice(0, 80)}{replyingTo.content.length > 80 ? '…' : ''}
                  </div>
                </div>
                <button onClick={() => setReplyingTo(null)} className="text-app-text-tertiary hover:text-app-text p-0.5">
                  <X size={13} />
                </button>
              </div>
            )}

            {/* Row 0c: Context pills (inside card) */}
            {hasContext && (
              <div className="px-3 mt-1.5 flex items-center gap-1.5 overflow-x-auto scrollbar-hide">
                <span className="text-[10px] text-app-text-muted font-medium flex-shrink-0">Context</span>
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
            )}

            {/* Row 1: Textarea (full width, borderless) */}
            <textarea
              ref={textareaRef}
              value={message}
              onChange={handleMessageChange}
              onKeyDown={handleKeyDown}
              onPaste={onPaste}
              aria-label={`Message input for ${topic.name}`}
              aria-describedby="chat-input-hint"
              placeholder={replyingTo ? 'Reply...' : topic.projectPath ? 'Message... (@ to mention files)' : 'Message...'}
              className={`w-full px-3 ${hasAttachments || replyingTo || hasContext ? 'pt-1.5' : 'pt-3'} pb-1 bg-transparent text-app-text placeholder-app-placeholder resize-none overflow-y-auto focus:outline-none focus-visible:outline-none ${isMobile ? 'text-[16px]' : 'text-[13px]'}`}
              style={{ minHeight: '36px', maxHeight: '140px' }}
              rows={1}
              disabled={uploading}
            />
            <span id="chat-input-hint" className="sr-only">Press Enter to send, Shift+Enter for new line. Type / for commands.</span>

            {/* Row 2: Action bar */}
            <div className={`flex items-center justify-between ${isMobile ? 'px-1.5 pb-1.5' : 'px-2 pb-2'}`}>
              {/* Left: tools */}
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className={`${isMobile ? 'w-8 h-8' : 'w-8 h-8'} flex items-center justify-center rounded-lg text-app-text-muted hover:text-primary hover:bg-app-hover transition-all`}
                  title="Attach file"
                  aria-label="Attach file"
                  disabled={currentStreaming}
                >
                  <Paperclip size={16} />
                  {!isMobile && <ShortcutHint keys="⌘U" className="opacity-50 ml-0.5" />}
                </button>
                <button
                  type="button"
                  onClick={onTogglePlanMode}
                  className={`${isMobile ? 'w-8 h-8' : 'w-8 h-8'} flex items-center justify-center rounded-lg transition-all ${
                    planMode
                      ? 'text-indigo-500 bg-indigo-500/10'
                      : 'text-app-text-muted hover:text-app-text hover:bg-app-hover'
                  }`}
                  title={planMode ? 'Plan Mode ON' : 'Plan Mode OFF'}
                  aria-label="Toggle plan mode"
                >
                  <ClipboardList size={16} />
                </button>
                {planMode && (
                  <span className="text-[9px] font-semibold text-indigo-500 uppercase tracking-wider ml-0.5">Plan</span>
                )}
              </div>

              {/* Right: voice + send */}
              <div className="flex items-center gap-0.5">
                {!isMobile && (
                  <OverflowMenu
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
                    onSlashCommand={(cmd) => {
                      setMessage(cmd + ' ');
                      textareaRef.current?.focus();
                    }}
                  />
                )}
                <button
                  type="submit"
                  disabled={(!message.trim() && pendingFiles.length === 0 && pendingImages.length === 0) || uploading}
                  className={`${isMobile ? 'w-8 h-8' : 'w-8 h-8'} flex items-center justify-center rounded-lg transition-all ${
                    uploading
                      ? 'bg-primary text-white'
                      : currentStreaming && message.trim()
                        ? 'bg-orange-500 text-white hover:bg-orange-600'
                        : (message.trim() || pendingFiles.length > 0 || pendingImages.length > 0)
                          ? 'bg-primary text-white hover:bg-primary-hover'
                          : 'bg-transparent text-app-placeholder'
                  }`}
                  title={currentStreaming && message.trim() ? 'Queue message (Enter)' : 'Send (Enter)'}
                  aria-label="Send message"
                >
                  {uploading ? (
                    <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <Send size={15} />
                  )}
                </button>
              </div>
            </div>

            {/* Popover menus (anchored to form) */}
            {showSlashMenu && filteredSlashCommands.length > 0 && (
              <div className="absolute bottom-full left-0 right-0 mb-1 bg-surface dark:bg-app-panel border border-app-border-input rounded-lg shadow-xl z-50 py-1 overflow-hidden max-h-48 overflow-y-auto">
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
                        ? 'bg-primary/15 text-app-text'
                        : 'text-app-text hover:bg-app-hover'
                    }`}
                  >
                    <span className="text-[12px] font-mono text-primary">{cmd.cmd}</span>
                    <span className="text-[11px] text-app-text-muted">{cmd.description}</span>
                  </button>
                ))}
              </div>
            )}

            {topic.projectPath && (
              <FileMentionMenu
                projectPath={topic.projectPath}
                visible={showMentionMenu}
                filter={mentionFilter}
                onSelect={handleMentionSelect}
                selectedIndex={mentionMenuIndex}
                onIndexChange={setMentionMenuIndex}
              />
            )}

            {showAgentMention && (
              <MentionAutocomplete
                query={agentMentionQuery}
                onSelect={handleAgentMentionSelect}
                onClose={() => { setShowAgentMention(false); setAgentMentionStartPos(-1); }}
                position={agentMentionPos}
              />
            )}

            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={onFileSelect} />
          </>
        )}
        {chatError && <div className="text-red-500 text-[11px] px-3 pb-1.5">{chatError}</div>}
        {messageQueue.length > 0 && (
          <div className="text-[11px] px-3 pb-1.5 text-orange-500 flex items-center gap-1.5">
            ({messageQueue.length} message{messageQueue.length > 1 ? 's' : ''} queued)
          </div>
        )}
      </form>
    </>
  );
}
