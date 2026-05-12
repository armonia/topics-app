import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Paperclip, Mic, MicOff, Volume2, VolumeX, Send, Square, MessageSquare, Phone, PhoneOff, MoreHorizontal, ClipboardList, Zap, Trash2, Cpu, Brain, HelpCircle, Users, Pause, Play, UserPlus, FolderOpen, Globe } from 'lucide-react';
import { decideComposerAction } from './composerAction';
import type { Topic, ChatMessage } from '../../types';
import { ImageThumbnail } from '../MessageContent';
import { useSpeechToText, useTextToSpeech, useVoiceCall } from '../../hooks/useSpeech';
import { FileMentionMenu, FilePill, type MentionedFile } from './FileMentionMenu';
import { ContextPills, useContextFileTokens } from './ContextPills';
import { MentionAutocomplete } from './MentionAutocomplete';
import { ProviderModelPicker } from './ProviderModelPicker';
import { ContextRing } from '../Shared/ContextRing';
import { useContextInspector } from '../../hooks/useContextInspector';

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
  { cmd: '/project', label: 'Project', description: 'Create or open a project', icon: FolderOpen },
  { cmd: '/browser', label: 'Browser', description: 'Open browser tab and navigate (e.g. /browser https://example.com)', icon: Globe },
  { cmd: '/help', label: 'Help', description: 'Show available commands', icon: HelpCircle },
];

// ---- Overflow Menu (slash commands + voice tools) ----

function OverflowMenu({
  isCallActive, isRecording, isListening, isSpeaking, autoTTS,
  voiceCallSupported, sttSupported, currentStreaming, uploading,
  toggleCall, startRecording: _startRecording, stopRecording: _stopRecording, toggleListening, stopSpeaking, setAutoTTS,
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
        <div className="absolute bottom-full right-0 mb-1 bg-surface border border-app-border-light rounded-xl shadow-xl z-50 py-1.5 min-w-[220px]">
          {/* Slash commands */}
          {SLASH_COMMANDS.map((cmd) => {
            const Icon = cmd.icon;
            return (
              <button
                key={cmd.cmd}
                type="button"
                onClick={() => { onSlashCommand(cmd.cmd); setOpen(false); }}
                className="w-full px-3 py-1.5 text-left grid grid-cols-[14px_auto_1fr] gap-x-2.5 items-baseline text-[12px] transition-colors hover:bg-app-hover text-app-text"
              >
                <Icon size={14} className="text-app-text-muted" />
                <span className="font-mono text-primary text-[11px] whitespace-nowrap">{cmd.cmd}</span>
                <span className="text-[10px] text-app-text-muted text-right truncate">{cmd.description}</span>
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

// ---- Message Queue Badge (clickable popover) ----
//
// The queue is a `string[]` owned by the parent ChatPane (mirrored to
// localStorage). This component just renders the badge + popover; mutations
// flow back through the callbacks so the parent keeps a single source of
// truth and the auto-dispatch effect on `messageQueue` keeps firing on
// stream:end. Each row is a small auto-resizing textarea so users can edit
// the queued prompt before it ships, plus an X to drop it. Outside-click
// closes the popover (mirrors OverflowMenu).

function MessageQueueBadge({
  queue,
  onUpdateItem,
  onRemoveItem,
  onClear,
}: {
  queue: string[];
  onUpdateItem: (index: number, content: string) => void;
  onRemoveItem: (index: number) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const count = queue.length;

  // Close the popover when the queue empties (last message dispatched while
  // open). Without this the panel lingers as an empty box until clicked away.
  useEffect(() => {
    if (count === 0 && open) setOpen(false);
  }, [count, open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="relative px-3 pb-1.5" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="text-[11px] text-orange-500 hover:text-orange-600 flex items-center gap-1.5 transition-colors"
        title={open ? 'Hide queued messages' : 'Show queued messages'}
        aria-expanded={open}
      >
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse" />
        ({count} message{count > 1 ? 's' : ''} queued)
        <span className="text-app-text-muted">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="absolute bottom-full left-3 right-3 mb-1 bg-surface dark:bg-app-panel border border-app-border-light rounded-xl shadow-xl z-50 max-h-[60vh] overflow-y-auto">
          <div className="sticky top-0 bg-surface dark:bg-app-panel border-b border-app-border px-3 py-2 flex items-center justify-between">
            <span className="text-[11px] font-medium text-app-text">
              Queued message{count > 1 ? 's' : ''} ({count})
            </span>
            <button
              type="button"
              onClick={() => { onClear(); setOpen(false); }}
              className="text-[11px] text-app-text-muted hover:text-red-500 transition-colors"
              title="Clear all queued messages"
            >
              Clear all
            </button>
          </div>
          <ul className="py-1.5">
            {queue.map((content, idx) => (
              <QueuedRow
                key={idx}
                index={idx}
                content={content}
                onChange={(next) => onUpdateItem(idx, next)}
                onRemove={() => onRemoveItem(idx)}
              />
            ))}
          </ul>
          <div className="px-3 pb-2 pt-1 text-[10px] text-app-text-muted">
            Sent automatically when the current response finishes.
          </div>
        </div>
      )}
    </div>
  );
}

function QueuedRow({
  index,
  content,
  onChange,
  onRemove,
}: {
  index: number;
  content: string;
  onChange: (next: string) => void;
  onRemove: () => void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Auto-grow textarea so multi-line queued prompts are visible without scroll.
  const resize = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  }, []);
  useEffect(() => { resize(); }, [content, resize]);

  return (
    <li className="px-3 py-1.5 grid grid-cols-[20px_1fr_auto] gap-2 items-start group">
      <span className="text-[10px] font-mono text-app-text-muted pt-1.5 select-none">{index + 1}.</span>
      <textarea
        ref={taRef}
        value={content}
        onChange={(e) => onChange(e.target.value)}
        rows={1}
        className="resize-none w-full text-[12px] leading-snug px-2 py-1 rounded-md bg-app-hover/40 border border-transparent focus:border-app-border-input focus:bg-surface focus:outline-none text-app-text"
        spellCheck={false}
      />
      <button
        type="button"
        onClick={onRemove}
        className="w-6 h-6 mt-0.5 flex items-center justify-center rounded-md text-app-text-muted hover:text-red-500 hover:bg-red-500/10 transition-colors opacity-60 group-hover:opacity-100"
        title="Remove from queue"
        aria-label={`Remove queued message ${index + 1}`}
      >
        <X size={12} />
      </button>
    </li>
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
  /**
   * Abort the in-flight assistant turn. Wired to `useChat.stopSession` via
   * `ChatPane`. The unified composer button calls this when the agent owns
   * the turn AND the composer is empty (see `composerAction.ts`).
   */
  onStop: () => void;
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
  onUpdateQueueItem: (index: number, content: string) => void;
  onRemoveQueueItem: (index: number) => void;
  onClearQueue: () => void;
  othersTyping: boolean;
  othersTypingText: string;
  mentionedFiles: MentionedFile[];
  setMentionedFiles: React.Dispatch<React.SetStateAction<MentionedFile[]>>;
  planMode?: boolean;
  onTogglePlanMode?: () => void;
  /**
   * Fast Mode toggle (openspec change `chat-fast-mode`). When ON, the chat
   * route uses the provider's native fast model (haiku / gpt-4o-mini / …).
   * Independent of plan mode — both can be ON simultaneously. Persisted
   * per-topic on the server; the toggle is positioned between Plan mode
   * and the Context ring in the composer's left tool cluster.
   */
  fastMode?: boolean;
  onToggleFastMode?: () => void;
  editingMessage?: ChatMessage | null;
  onCancelEdit?: () => void;
  providerOverride?: { provider: string; model: string } | null;
  onProviderOverrideChange?: (override: { provider: string; model: string } | null) => void;
  defaultProviderLabel?: string;
  onOpenSettings?: () => void;
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
  onStop,
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
  onUpdateQueueItem,
  onRemoveQueueItem,
  onClearQueue,
  othersTyping,
  othersTypingText,
  mentionedFiles,
  setMentionedFiles,
  planMode,
  onTogglePlanMode,
  fastMode,
  onToggleFastMode,
  editingMessage,
  onCancelEdit,
  providerOverride,
  onProviderOverrideChange,
  defaultProviderLabel,
  onOpenSettings,
}: ChatInputProps) {
  // Context pills state
  const contextFilePaths = topic.contextFiles || [];
  const contextTokenMap = useContextFileTokens(topic.sessionKey, contextFilePaths);
  const [excludedContextPaths, setExcludedContextPaths] = useState<Set<string>>(new Set());

  // Context budget ring — sits left of the model selector. Drafts have no
  // server-side topic yet, so skip the analysis call until promotion.
  const isDraftTopic = topic.id.startsWith('draft:');
  const { budgetPercent } = useContextInspector(isDraftTopic ? null : topic.id);
  const handleContextRingClick = useCallback(() => {
    // ChatPanel listens for this event and toggles its inspector flag.
    window.dispatchEvent(new CustomEvent('chat-input:toggle-context', { detail: { topicId: topic.id } }));
  }, [topic.id]);

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

  // Phase 30 BROWSER-CHAT-04 — listen for chat:insert-text custom events
  // dispatched by SelectElementOverlay (Cmd+Shift+E pick) and other loosely
  // coupled producers. Inserts the provided text into the chat input prefixed
  // with a blank line if there's existing content, then focuses the textarea.
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ text?: string }>;
      const incoming = ce.detail?.text;
      if (!incoming) return;
      setMessage(message ? `${message}\n\n${incoming}` : incoming);
      textareaRef.current?.focus();
    };
    window.addEventListener('chat:insert-text', handler as EventListener);
    return () => window.removeEventListener('chat:insert-text', handler as EventListener);
  }, [message, setMessage, textareaRef]);

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
        className={`relative ${isMobile ? 'm-2' : 'm-3'} rounded-2xl shadow-md border ${planMode ? 'border-indigo-400 dark:border-indigo-500/50 focus-within:border-indigo-400' : 'border-app-border-light focus-within:border-primary'} bg-surface flex-shrink-0 transition-colors min-w-0 max-w-full`}
        style={{ maxWidth: '100%' }}
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

            {/* Row 0a: Editing indicator (inside card) */}
            {editingMessage && (
              <div className="mx-3 mt-2 flex items-center gap-1.5">
                <div className="w-0.5 h-5 bg-amber-500 rounded-full flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] text-amber-600 dark:text-amber-400 font-medium">
                    Editing message
                  </div>
                </div>
                <button onClick={onCancelEdit} className="text-app-text-tertiary hover:text-app-text p-0.5" title="Cancel edit">
                  <X size={14} />
                </button>
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
                  <X size={14} />
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
              data-testid="chat-message-input"
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
            <div className={`flex items-center justify-between ${'px-1.5 pb-1.5'}`}>
              {/* Left: tools */}
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className={`w-8 h-8 flex items-center justify-center rounded-lg text-app-text-muted hover:text-primary hover:bg-app-hover transition-all`}
                  title="Attach file (⌘U)"
                  aria-label="Attach file"
                  disabled={currentStreaming}
                >
                  <Paperclip size={16} />
                </button>
                <button
                  type="button"
                  onClick={onTogglePlanMode}
                  className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors ${
                    planMode
                      ? 'text-indigo-500 bg-indigo-500/10'
                      : 'text-app-text-muted hover:text-app-text hover:bg-app-hover'
                  }`}
                  title={planMode ? 'Plan Mode ON' : 'Plan Mode OFF'}
                  aria-label="Toggle plan mode"
                >
                  <ClipboardList size={16} />
                </button>
                {onToggleFastMode && (
                  <button
                    type="button"
                    onClick={onToggleFastMode}
                    className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors ${
                      fastMode
                        ? 'text-amber-500 bg-amber-500/10'
                        : 'text-app-text-muted hover:text-app-text hover:bg-app-hover'
                    }`}
                    title={
                      fastMode
                        ? "Fast Mode ON — using the provider's fast model"
                        : 'Fast Mode OFF — using the topic’s default model'
                    }
                    aria-label="Toggle fast mode"
                    aria-pressed={!!fastMode}
                    data-testid="chat-input-fast-mode"
                  >
                    <Zap size={16} />
                  </button>
                )}
                {!isDraftTopic && (
                  <button
                    type="button"
                    onClick={handleContextRingClick}
                    className="w-8 h-8 flex items-center justify-center rounded-lg text-app-text-muted hover:text-app-text hover:bg-app-hover transition-colors"
                    title={`Context: ${budgetPercent}%`}
                    aria-label="Toggle context inspector"
                    data-testid="chat-input-context-ring"
                  >
                    <ContextRing percent={budgetPercent} size={14} />
                  </button>
                )}
                {onProviderOverrideChange && (
                  <ProviderModelPicker
                    override={providerOverride ?? null}
                    defaultProviderLabel={defaultProviderLabel}
                    onChange={onProviderOverrideChange}
                    onOpenSettings={onOpenSettings}
                  />
                )}
              </div>

              {/* Right: voice + send */}
              <div className="flex items-center gap-0.5">
                {/* Direct mic button — always visible on all screen sizes */}
                <button
                  type="button"
                  onClick={() => { if (isRecording) stopRecording(); else startRecording(); }}
                  className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all ${
                    isRecording ? 'bg-red-500 text-white animate-pulse' : 'text-app-text-tertiary hover:text-app-text hover:bg-app-hover'
                  }`}
                  title={isRecording ? 'Stop recording (⌘⇧R)' : 'Record voice (⌘⇧R)'}
                  aria-label={isRecording ? 'Stop recording' : 'Record voice'}
                  disabled={currentStreaming || uploading}
                >
                  {isRecording ? <MicOff size={16} /> : <Mic size={16} />}
                </button>
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
                {/*
                  Unified composer button. The four states resolve via the
                  pure `decideComposerAction` helper so this JSX no longer
                  buries the rules in nested ternaries (the previous version
                  hand-coded the send / queue / disabled split inline and
                  had no notion of "stop"). Rules:

                    busy & empty   → Stop (abort the turn)
                    busy & filled  → Queue (orange Send; text auto-flushes
                                     when the stream ends, no token loss)
                    idle & filled  → Send
                    idle & empty   → Disabled

                  `Enter` keeps its existing semantics in `ChatPane.handleKeyDown`
                  (which calls `onSubmit` → `handleSendMessage`, and that
                  function already routes to the queue when streaming). Stop
                  is only reachable via click, never via the keyboard, so a
                  stray Enter can't accidentally cancel a turn.
                */}
                {(() => {
                  const hasContent =
                    message.trim().length > 0 ||
                    pendingFiles.length > 0 ||
                    pendingImages.length > 0;
                  const action = decideComposerAction({
                    busy: currentStreaming,
                    hasContent,
                  });

                  if (action.kind === 'stop') {
                    return (
                      <button
                        type="button"
                        onClick={onStop}
                        className="w-8 h-8 flex items-center justify-center rounded-lg bg-app-text/15 text-app-text hover:bg-app-text/25 transition-all"
                        title="Stop streaming"
                        aria-label="Stop streaming"
                      >
                        <Square size={12} fill="currentColor" />
                      </button>
                    );
                  }

                  const isQueue = action.kind === 'queue';
                  const isDisabled = action.kind === 'disabled' || uploading;

                  return (
                    <button
                      type="submit"
                      disabled={isDisabled && !uploading}
                      className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all ${
                        uploading
                          ? 'bg-primary text-white'
                          : isQueue
                            ? 'bg-orange-500 text-white hover:bg-orange-600'
                            : action.kind === 'send'
                              ? 'bg-primary text-white hover:bg-primary-hover'
                              : 'bg-transparent text-app-placeholder'
                      }`}
                      title={isQueue ? 'Queue message (Enter)' : 'Send (Enter)'}
                      aria-label={isQueue ? 'Queue message' : 'Send message'}
                    >
                      {uploading ? (
                        <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <Send size={14} />
                      )}
                    </button>
                  );
                })()}
              </div>
            </div>

            {/* Popover menus (anchored to form) */}
            {showSlashMenu && filteredSlashCommands.length > 0 && (
              <div className="absolute bottom-full left-0 right-0 mb-1 bg-surface dark:bg-app-panel border border-app-border-input rounded-xl shadow-xl z-50 py-1.5 max-h-48 overflow-y-auto">
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
                    className={`w-full px-3 py-1.5 text-left grid grid-cols-[auto_1fr] gap-x-3 items-baseline transition-colors ${
                      idx === slashMenuIndex
                        ? 'bg-primary/10 text-app-text'
                        : 'text-app-text hover:bg-app-hover'
                    }`}
                  >
                    <span className="text-[12px] font-mono text-primary whitespace-nowrap">{cmd.cmd}</span>
                    <span className="text-[11px] text-app-text-muted truncate">{cmd.description}</span>
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
          <MessageQueueBadge
            queue={messageQueue}
            onUpdateItem={onUpdateQueueItem}
            onRemoveItem={onRemoveQueueItem}
            onClear={onClearQueue}
          />
        )}
      </form>
    </>
  );
}
