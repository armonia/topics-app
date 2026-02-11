import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { Settings, Pin, X, ExternalLink, Menu, MessageSquare, FolderTree, GitBranch, Zap, Globe, TerminalSquare } from 'lucide-react';
import type { Topic, ChatMessage, WSMessage, UpdateTopicRequest, PanelTab } from '../../types';
import { uploadApi, topicsApi, autoNameApi, commandApi, filesApi } from '../../lib/api';
const TopicSettingsModal = lazy(() => import('../Modals/TopicSettingsModal').then(m => ({ default: m.TopicSettingsModal })));
import type { MentionedFile } from '../Chat/FileMentionMenu';
const RemoteBrowserPanel = lazy(() => import('../Browser/RemoteBrowserPanel').then(m => ({ default: m.RemoteBrowserPanel })));
const TerminalPanel = lazy(() => import('../Terminal/TerminalPanel').then(m => ({ default: m.TerminalPanel })));
const CodeEditor = lazy(() => import('../Editor/CodeEditor').then(m => ({ default: m.CodeEditor })));
const ContextPieChart = lazy(() => import('../ContextPieChart').then(m => ({ default: m.ContextPieChart })));
import { ProjectSidebar } from '../Project/ProjectSidebar';
import { CommandMenu } from '../Shared/CommandMenu';
import { PinnedMessages } from '../Chat/PinnedMessages';
import { MessageList } from '../Chat/MessageList';
import { ChatInput } from '../Chat/ChatInput';
import { useVoiceRecording } from '../Chat/useVoiceRecording';

const isNativeApp = typeof window !== 'undefined' && !!(window as any).webkit?.messageHandlers;

const SLASH_COMMANDS = [
  { cmd: '/status', description: 'Show session status' },
  { cmd: '/clear', description: 'Clear conversation' },
  { cmd: '/model', description: 'Change model (e.g. /model claude-opus-4-5)' },
  { cmd: '/reasoning', description: 'Toggle reasoning mode' },
  { cmd: '/help', description: 'Show available commands' },
];

interface ChatPanelProps {
  topic: Topic; isFocused: boolean; onFocus: () => void; onClose: () => void;
  onDragStart: (e: React.DragEvent) => void; onToggleSidebar?: () => void; isDragOver: boolean;
  getSessionMessages: (sk: string) => ChatMessage[]; isSessionLoading: (sk: string) => boolean;
  isSessionStreaming: (sk: string) => boolean; sendMessage: (sk: string, content: string) => Promise<boolean>;
  loadHistory: (sk: string) => Promise<boolean>; chatError: string | null;
  sendWS: (msg: WSMessage) => void; onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  onUpdateTopic: (id: string, data: UpdateTopicRequest) => Promise<Topic | null>;
}

export function ChatPanel({
  topic, isFocused, onFocus, onClose, onDragStart, onToggleSidebar, isDragOver,
  getSessionMessages, isSessionLoading, isSessionStreaming, sendMessage, loadHistory,
  chatError, sendWS, onWSMessage, onUpdateTopic,
}: ChatPanelProps) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => { const h = () => setIsMobile(window.innerWidth < 768); window.addEventListener('resize', h); return () => window.removeEventListener('resize', h); }, []);

  const [message, setMessage] = useState('');
  const [pendingImages, setPendingImages] = useState<{ dataUrl: string; mimeType: string }[]>([]);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [mentionedFiles, setMentionedFiles] = useState<MentionedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [fileDragOver, setFileDragOver] = useState(false);
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [showPinned, setShowPinned] = useState(false);
  const [activeTab, setActiveTab] = useState<PanelTab>('chat');
  const [autoNameTriggered, setAutoNameTriggered] = useState(false);
  const [suggestedProject, setSuggestedProject] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [rightPanelType, setRightPanelType] = useState<'browser' | 'file' | null>(null);
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [fileLoading, setFileLoading] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [browserNavigateUrl, setBrowserNavigateUrl] = useState<string | null>(null);
  const [commandLoading, setCommandLoading] = useState(false);
  const [commandResult, setCommandResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [messageQueue, setMessageQueue] = useState<string[]>([]);
  const [othersTyping, setOthersTyping] = useState(false);
  const [othersTypingText, setOthersTypingText] = useState('');
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const currentMessages = getSessionMessages(topic.sessionKey);
  const currentLoading = isSessionLoading(topic.sessionKey);
  const currentStreaming = isSessionStreaming(topic.sessionKey);
  const hasProject = !!topic.projectPath;

  const { isRecording, recordingTime, voiceUploading, startRecording, stopRecording, formatRecordingTime } = useVoiceRecording(sendMessage, topic.sessionKey, currentStreaming);
  const isUploading = uploading || voiceUploading;

  useEffect(() => { const check = () => setDarkMode(document.documentElement.classList.contains('dark')); check(); const obs = new MutationObserver(check); obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] }); return () => obs.disconnect(); }, []);
  useEffect(() => { if (rightPanelType === 'file' && openFilePath) { setFileLoading(true); setFileContent(''); filesApi.content(openFilePath).then(c => setFileContent(c)).catch(e => setFileContent(`// Error: ${e.message}`)).finally(() => setFileLoading(false)); } }, [rightPanelType, openFilePath]);
  useEffect(() => { if (!hasProject && activeTab !== 'chat' && activeTab !== 'terminal' && activeTab !== 'browser') setActiveTab('chat'); }, [hasProject, activeTab]);

  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  useEffect(() => { if (activeTab === 'chat' && !isUserScrolledUp) messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [currentMessages, currentStreaming, activeTab, isUserScrolledUp]);
  useEffect(() => { const c = chatContainerRef.current; if (!c) return; const h = () => { setIsUserScrolledUp(c.scrollHeight - c.scrollTop - c.clientHeight > 200); }; c.addEventListener('scroll', h, { passive: true }); return () => c.removeEventListener('scroll', h); }, []);
  useEffect(() => { if (!currentStreaming && messageQueue.length > 0) { const next = messageQueue[0]; setMessageQueue(prev => prev.slice(1)); sendMessage(topic.sessionKey, next); } }, [currentStreaming, messageQueue, sendMessage, topic.sessionKey]);
  useEffect(() => { loadHistory(topic.sessionKey); setReplyingTo(null); setAutoNameTriggered(false); }, [topic.sessionKey, loadHistory]);
  useEffect(() => { if (isFocused) { topicsApi.markRead(topic.id).catch(() => {}); sendWS({ type: 'focus', topicId: topic.id }); if (currentMessages.length === 0) textareaRef.current?.focus(); } }, [isFocused, topic.id, sendWS, currentMessages.length]);

  useEffect(() => {
    if (autoNameTriggered || currentStreaming) return;
    const aMsgs = currentMessages.filter(m => m.role === 'assistant' && m.content.trim() !== '');
    const isDefaultName = topic.name === 'New Chat' || topic.name.startsWith('New ');
    if (aMsgs.length >= 1 && isDefaultName) {
      setAutoNameTriggered(true);
      autoNameApi.autoName(topic.id).then(r => {
        if (r.suggestedProject && !topic.projectPath) {
          onUpdateTopic(topic.id, { projectPath: r.suggestedProject });
        }
      }).catch(() => {});
    }
  }, [currentMessages, currentStreaming, topic.id, topic.name, topic.projectPath, autoNameTriggered, onUpdateTopic]);

  const sendTyping = useCallback((text?: string) => sendWS({ type: 'typing', topicId: topic.id, text: text || '' }), [sendWS, topic.id]);

  useEffect(() => {
    const unsub = onWSMessage((msg: any) => {
      if (msg.type === 'typing' && msg.topicId === topic.id) {
        setOthersTyping(true); setOthersTypingText(msg.text || '');
        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = setTimeout(() => { setOthersTyping(false); setOthersTypingText(''); }, 2000);
      }
      if (msg.type === 'browser:navigate' && msg.topicId === topic.id && msg.url) {
        setBrowserNavigateUrl(msg.url);
        setActiveTab('browser');
      }
    });
    return () => { unsub(); if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current); };
  }, [onWSMessage, topic.id]);

  const resizeTextarea = useCallback(() => { const ta = textareaRef.current; if (!ta) return; ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; }, []);
  useEffect(() => { resizeTextarea(); }, [message, resizeTextarea]);

  const uploadFiles = useCallback(async (files: File[]) => { const paths: string[] = []; for (const f of files) { try { const r = await uploadApi.uploadFile(f); paths.push(r.path); } catch {} } return paths; }, []);

  const handleSlashCommand = useCallback(async (text: string): Promise<boolean> => {
    const cmd = text.toLowerCase().trim();
    if (cmd === '/status') { setCommandLoading(true); try { const r = await commandApi.status(topic.sessionKey); setCommandResult({ type: 'success', message: r.output || 'Status retrieved' }); } catch (e: any) { setCommandResult({ type: 'error', message: e.message }); } finally { setCommandLoading(false); } return true; }
    if (cmd === '/clear') { if (!window.confirm('Clear conversation? A backup will be saved.')) return true; setCommandLoading(true); try { await commandApi.clear(topic.sessionKey); loadHistory(topic.sessionKey); setCommandResult({ type: 'success', message: 'Conversation cleared' }); } catch (e: any) { setCommandResult({ type: 'error', message: e.message }); } finally { setCommandLoading(false); } return true; }
    if (cmd === '/reasoning') { setCommandLoading(true); try { const r = await commandApi.toggleReasoning(topic.sessionKey); setCommandResult({ type: 'success', message: r.message || 'Reasoning toggled' }); } catch (e: any) { setCommandResult({ type: 'error', message: e.message }); } finally { setCommandLoading(false); } return true; }
    if (cmd === '/help') { setCommandResult({ type: 'success', message: SLASH_COMMANDS.map(c => `${c.cmd} — ${c.description}`).join('\n') }); return true; }
    if (cmd.startsWith('/model ')) { const m = text.slice(7).trim(); if (!m) return false; setCommandLoading(true); try { await commandApi.setModel(topic.sessionKey, m); setCommandResult({ type: 'success', message: `Model set to: ${m}` }); } catch (e: any) { setCommandResult({ type: 'error', message: e.message }); } finally { setCommandLoading(false); } return true; }
    return false;
  }, [topic.sessionKey, loadHistory]);

  const addSystemMessage = useCallback((content: string) => { fetch(`/api/topics/${topic.id}/system-message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) }).then(() => loadHistory(topic.sessionKey)); }, [topic.id, topic.sessionKey, loadHistory]);
  const handleCommandStatus = useCallback(async () => { setCommandLoading(true); try { const r = await commandApi.status(topic.sessionKey); addSystemMessage(r.output || 'Status retrieved'); } catch (e: any) { setCommandResult({ type: 'error', message: e.message }); } finally { setCommandLoading(false); } }, [topic.sessionKey, addSystemMessage]);
  const handleCommandClear = useCallback(async () => { if (!window.confirm('Clear conversation? A backup will be saved.')) return; setCommandLoading(true); try { await commandApi.clear(topic.sessionKey); loadHistory(topic.sessionKey); } catch (e: any) { setCommandResult({ type: 'error', message: e.message }); } finally { setCommandLoading(false); } }, [topic.sessionKey, loadHistory]);
  const handleCommandModel = useCallback(async (model: string) => { setCommandLoading(true); try { await commandApi.setModel(topic.sessionKey, model); addSystemMessage(`✅ Model set to: ${model}`); } catch (e: any) { setCommandResult({ type: 'error', message: e.message }); } finally { setCommandLoading(false); } }, [topic.sessionKey, addSystemMessage]);
  const handleCommandReasoning = useCallback(async () => { setCommandLoading(true); try { const r = await commandApi.toggleReasoning(topic.sessionKey); setCommandResult({ type: 'success', message: r.message || 'Reasoning toggled' }); } catch (e: any) { setCommandResult({ type: 'error', message: e.message }); } finally { setCommandLoading(false); } }, [topic.sessionKey]);
  useEffect(() => { if (commandResult) { const t = setTimeout(() => setCommandResult(null), 5000); return () => clearTimeout(t); } }, [commandResult]);

  useEffect(() => { if (!isFocused) return; const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 'u') { e.preventDefault(); fileInputRef.current?.click(); } }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [isFocused]);

  const resizeImageToBase64 = useCallback((file: File, maxDim = 1568): Promise<{ dataUrl: string; mimeType: string }> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => { const s = Math.min(1, maxDim / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s); const ctx = c.getContext('2d'); if (!ctx) { reject(new Error('No canvas context')); return; } ctx.drawImage(img, 0, 0, c.width, c.height); const mt = file.type === 'image/png' ? 'image/png' : 'image/jpeg'; resolve({ dataUrl: c.toDataURL(mt, mt === 'image/jpeg' ? 0.85 : undefined), mimeType: mt }); URL.revokeObjectURL(img.src); };
      img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error('Failed to load image')); };
      img.src = URL.createObjectURL(file);
    });
  }, []);

  const handleSendMessage = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!message.trim() && pendingFiles.length === 0 && pendingImages.length === 0) return;
    if (currentStreaming) { if (message.trim()) { setMessageQueue(prev => [...prev, message.trim()]); setMessage(''); } return; }
    let finalMessage = message.trim();
    if (finalMessage.startsWith('/')) { if (await handleSlashCommand(finalMessage)) { setMessage(''); return; } }
    const curFiles = [...pendingFiles], curImages = [...pendingImages], curReply = replyingTo, curMentioned = [...mentionedFiles];
    setMessage(''); setPendingFiles([]); setPendingImages([]); setMentionedFiles([]); setReplyingTo(null);
    if (curFiles.length > 0 || curImages.length > 0) {
      setUploading(true);
      try {
        if (curFiles.length > 0) { const paths = await uploadFiles(curFiles); finalMessage = paths.map(p => `[Attached file: ${p}]`).join('\n') + (finalMessage ? '\n' + finalMessage : ''); }
        if (curImages.length > 0) { const urls: string[] = []; for (const img of curImages) { try { const res = await fetch('/api/upload-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: img.dataUrl, mimeType: img.mimeType }) }); if (res.ok) urls.push((await res.json()).url); } catch {} } if (urls.length > 0) finalMessage = urls.map(u => `[Attached file: ${u}]`).join('\n') + (finalMessage ? '\n' + finalMessage : ''); }
      } finally { setUploading(false); }
    }
    if (curMentioned.length > 0) {
      const parts: string[] = [];
      for (const mf of curMentioned) { try { const c = await filesApi.content(mf.path); parts.push(`<file path="${mf.path}">\n${c.length > 10000 ? c.slice(0, 10000) + '\n...(truncated)' : c}\n</file>`); } catch { parts.push(`<file path="${mf.path}">\n(Error reading file)\n</file>`); } }
      finalMessage = `[Context files]\n${parts.join('\n\n')}\n[/Context files]\n\n${finalMessage}`;
    }
    if (curReply) { const qt = curReply.content.length > 120 ? curReply.content.slice(0, 120) + '…' : curReply.content; finalMessage = qt.split('\n').map(l => `> ${l}`).join('\n') + '\n\n' + finalMessage; }
    if (finalMessage) await sendMessage(topic.sessionKey, finalMessage);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); } sendTyping(message); };
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => { const f = Array.from(e.target.files || []); if (f.length > 0) setPendingFiles(prev => [...prev, ...f]); if (fileInputRef.current) fileInputRef.current.value = ''; };
  const removePendingFile = (i: number) => setPendingFiles(prev => prev.filter((_, idx) => idx !== i));

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items); const imgs: File[] = [], others: File[] = [];
    for (const item of items) { if (item.kind === 'file') { const f = item.getAsFile(); if (f) { f.type.startsWith('image/') ? imgs.push(f) : others.push(f); } } }
    if (imgs.length > 0) { e.preventDefault(); Promise.all(imgs.map(f => resizeImageToBase64(f))).then(r => setPendingImages(prev => [...prev, ...r])).catch(() => {}); }
    if (others.length > 0) { e.preventDefault(); setPendingFiles(prev => [...prev, ...others]); }
  }, [resizeImageToBase64]);

  const handleFileDragOver = useCallback((e: React.DragEvent) => { if (e.dataTransfer.types.includes('application/x-panel-id')) return; e.preventDefault(); e.stopPropagation(); setFileDragOver(true); }, []);
  const handleFileDragLeave = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); if (!e.currentTarget.contains(e.relatedTarget as Node)) setFileDragOver(false); }, []);
  const handleFileDrop = useCallback((e: React.DragEvent) => { if (e.dataTransfer.types.includes('application/x-panel-id')) return; e.preventDefault(); e.stopPropagation(); setFileDragOver(false); const f = Array.from(e.dataTransfer.files); if (f.length > 0) setPendingFiles(prev => [...prev, ...f]); }, []);

  const handleCopyMessage = (msg: ChatMessage) => { navigator.clipboard.writeText(msg.content).then(() => { setCopiedMsgId(msg.id); setTimeout(() => setCopiedMsgId(null), 2000); }); };
  const handleTogglePin = async (msg: ChatMessage) => { const pinned = topic.pinnedMessages || []; const newPinned = pinned.includes(msg.id) ? pinned.filter(id => id !== msg.id) : [...pinned, msg.id]; await onUpdateTopic(topic.id, { pinnedMessages: newPinned }); };
  const isImageFile = (f: File) => f.type.startsWith('image/');
  const pinnedMessages = currentMessages.filter(m => (topic.pinnedMessages || []).includes(m.id));

  const tabs: { id: PanelTab; label: string; icon: React.ReactNode; projectOnly?: boolean }[] = [
    { id: 'chat', label: 'Chat', icon: <MessageSquare size={13} /> },
    { id: 'files', label: 'Files', icon: <FolderTree size={13} />, projectOnly: true },
    { id: 'changes', label: 'Changes', icon: <GitBranch size={13} />, projectOnly: true },
    { id: 'processes', label: 'Processes', icon: <Zap size={13} />, projectOnly: true },
    { id: 'browser', label: 'Browser', icon: <Globe size={13} /> },
    { id: 'terminal', label: 'Terminal', icon: <TerminalSquare size={13} /> },
  ];
  const visibleTabs = tabs.filter(t => !t.projectOnly || hasProject || t.id === activeTab);
  const LazySpinner = <div className="flex items-center justify-center h-full"><div className="w-4 h-4 border-2 border-[#ccc] dark:border-[#555] border-t-[var(--primary)] rounded-full animate-spin" /></div>;

  return (
    <>
      <div role="region" aria-label={`${topic.name} panel`} className={`flex flex-col flex-1 min-h-0 bg-white dark:bg-[#1a1a1a] overflow-hidden transition-all duration-100 ${isDragOver ? 'bg-[var(--primary)]/3' : ''} ${isFocused ? 'ring-1 ring-[var(--primary)]/30 ring-inset' : ''}`} onClick={onFocus}>
        {/* Header */}
        <div className="flex items-center gap-1.5 px-2 h-11 border-b border-[#e8e8e8] dark:border-[#2a2a2a] select-none flex-shrink-0 bg-white dark:bg-[#1a1a1a] app-drag-region">
          {onToggleSidebar && <button onClick={(e) => { e.stopPropagation(); onToggleSidebar(); }} className="w-8 h-8 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-[#666] dark:text-[#999] transition-colors app-no-drag flex-shrink-0" title="Toggle sidebar" aria-label="Toggle sidebar"><Menu size={18} /></button>}
          <div className="flex items-center gap-1.5 min-w-0 cursor-grab active:cursor-grabbing app-no-drag" draggable onDragStart={onDragStart}>
            <span className="text-[16px] leading-none flex items-center justify-center w-6 h-6 flex-shrink-0">{topic.icon}</span>
            <span className="text-[14px] font-medium truncate text-[#1a1a1a] dark:text-[#e5e5e5]" style={{ maxWidth: 'min(200px, 40vw)' }}>{topic.name}</span>
          </div>
          {hasProject && <span className="text-[10px] bg-blue-100/60 dark:bg-blue-900/20 text-blue-500 dark:text-blue-400 px-1.5 py-0.5 rounded leading-none flex-shrink-0" title={`Project: ${topic.projectPath}`}>{topic.projectPath?.split('/').pop()}</span>}
          <Suspense fallback={null}><ContextPieChart sessionKey={topic.sessionKey} compact /></Suspense>
          <div className="flex-1" />
          {topic.systemPrompt && <span className="text-[10px] bg-purple-100/60 dark:bg-purple-900/20 text-purple-500 dark:text-purple-400 px-1 py-0.5 rounded leading-none flex-shrink-0" title="Has system prompt">✨</span>}
          <button onClick={(e) => { e.stopPropagation(); setShowSettings(true); }} className="w-7 h-7 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-[#8b8b8b] hover:text-[#555] dark:hover:text-[#ccc] transition-colors app-no-drag" title="Topic settings" aria-label="Topic settings"><Settings size={14} /></button>
          {!isMobile && <CommandMenu onStatus={handleCommandStatus} onClear={handleCommandClear} onModel={handleCommandModel} onReasoning={handleCommandReasoning} isLoading={commandLoading} />}
          {pinnedMessages.length > 0 && <button onClick={(e) => { e.stopPropagation(); setShowPinned(!showPinned); }} className="w-7 h-7 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-yellow-500/70 hover:text-yellow-500 transition-colors app-no-drag" title={`${pinnedMessages.length} pinned`} aria-label={`${pinnedMessages.length} pinned messages`}><Pin size={14} /></button>}
          {!isMobile && <button onClick={(e) => { e.stopPropagation(); const url = `${window.location.origin}?topic=${topic.id}`; isNativeApp ? window.open(url, `topic-${topic.id}`, 'width=900,height=700') : window.open(url, `topic-${topic.id}`); onClose(); }} className="w-7 h-7 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-[#8b8b8b] hover:text-[#555] dark:hover:text-[#ccc] transition-colors app-no-drag" title="Pop out to new window" aria-label="Pop out to new window"><ExternalLink size={13} /></button>}
          <button onClick={(e) => { e.stopPropagation(); onClose(); }} className="w-7 h-7 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-[#8b8b8b] hover:text-[#555] dark:hover:text-[#ccc] transition-colors app-no-drag" title="Close panel" aria-label="Close panel"><X size={14} strokeWidth={1.5} /></button>
        </div>

        {/* Tab Bar — always show when multiple tabs available */}
        {visibleTabs.length > 1 && (
          <div className="flex items-center border-b border-[#e8e8e8] dark:border-[#2a2a2a] bg-[#fafafa] dark:bg-[#1e1e1e] flex-shrink-0 px-1">
            {visibleTabs.map(tab => (
              <button key={tab.id} onClick={(e) => { e.stopPropagation(); setActiveTab(tab.id); if (tab.id === 'browser') { setRightPanelType('browser'); setRightPanelOpen(true); } else if (tab.id === 'chat') { setRightPanelOpen(false); } }} className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium transition-colors relative app-no-drag ${activeTab === tab.id ? 'text-[var(--primary)] dark:text-[#4d94ff]' : 'text-[#8b8b8b] hover:text-[#555] dark:hover:text-[#ccc]'}`}>
                {tab.icon}<span>{tab.label}</span>
                {activeTab === tab.id && <div className="absolute bottom-0 left-1 right-1 h-[2px] bg-[var(--primary)] dark:bg-[#4d94ff] rounded-t" />}
              </button>
            ))}
          </div>
        )}

        {/* Banners */}
        {suggestedProject && (
          <div className="px-3 py-2 bg-[var(--primary)]/10 border-b border-[var(--primary)]/20 flex items-center gap-3 flex-shrink-0">
            <div className="flex-1 min-w-0"><div className="text-[12px] font-medium text-[var(--primary)]">Link to a project?</div><div className="text-[11px] text-[#666] dark:text-[#999] truncate">{suggestedProject}</div></div>
            <button onClick={() => { onUpdateTopic(topic.id, { projectPath: suggestedProject }); setSuggestedProject(null); }} className="px-3 py-1 text-[11px] bg-[var(--primary)] text-white rounded-md hover:bg-[#0055dd] transition-colors">Link</button>
            <button onClick={() => setSuggestedProject(null)} className="px-2 py-1 text-[11px] text-[#888] hover:text-[#555] dark:hover:text-[#ccc] transition-colors">Skip</button>
          </div>
        )}
        {commandResult && (
          <div className={`px-3 py-2 border-b flex items-center gap-2 flex-shrink-0 transition-all ${commandResult.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-red-500/10 border-red-500/20'}`}>
            <div className={`text-[12px] flex-1 whitespace-pre-wrap font-mono ${commandResult.type === 'success' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>{commandResult.message}</div>
            <button onClick={() => setCommandResult(null)} className="text-[#888] hover:text-[#555] dark:hover:text-[#ccc] p-1"><X size={12} /></button>
          </div>
        )}

        {/* Main Content */}
        <div className="flex-1 flex min-h-0 overflow-hidden">
          {hasProject && <ProjectSidebar projectPath={topic.projectPath!} topicId={topic.id} collapsed={sidebarCollapsed} onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)} onOpenFile={(path) => { setOpenFilePath(path); setRightPanelType('file'); setRightPanelOpen(true); }} onWSMessage={onWSMessage} />}
          <div className="flex-1 flex min-w-0 overflow-hidden">
            {activeTab === 'browser' ? (
              <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
                <Suspense fallback={LazySpinner}><RemoteBrowserPanel contextId={topic.id} navigateUrl={browserNavigateUrl || undefined} onNavigateConsumed={() => setBrowserNavigateUrl(null)} /></Suspense>
              </div>
            ) : activeTab === 'terminal' ? (
              <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
                <Suspense fallback={LazySpinner}><TerminalPanel projectPath={topic.projectPath} /></Suspense>
              </div>
            ) : (
              <>
                <div className="flex flex-col min-w-0 overflow-hidden flex-1">
                  <PinnedMessages show={showPinned} pinnedMessages={pinnedMessages} />
                  <MessageList isMobile={isMobile} topic={topic} currentMessages={currentMessages} currentLoading={currentLoading} currentStreaming={currentStreaming} copiedMsgId={copiedMsgId} fileDragOver={fileDragOver} chatContainerRef={chatContainerRef} messagesEndRef={messagesEndRef} textareaRef={textareaRef} onReply={setReplyingTo} onCopy={handleCopyMessage} onTogglePin={handleTogglePin} onFileDragOver={handleFileDragOver} onFileDragLeave={handleFileDragLeave} onFileDrop={handleFileDrop} setMessage={setMessage} />
                  <ChatInput isMobile={isMobile} topic={topic} currentMessages={currentMessages} currentStreaming={currentStreaming} message={message} setMessage={setMessage} pendingFiles={pendingFiles} pendingImages={pendingImages} setPendingImages={setPendingImages} uploading={isUploading} replyingTo={replyingTo} setReplyingTo={setReplyingTo} isRecording={isRecording} recordingTime={recordingTime} fileInputRef={fileInputRef} textareaRef={textareaRef} onSubmit={handleSendMessage} onKeyDown={handleKeyDown} onFileSelect={handleFileSelect} removePendingFile={removePendingFile} onPaste={handlePaste} startRecording={startRecording} stopRecording={stopRecording} formatRecordingTime={formatRecordingTime} isImageFile={isImageFile} chatError={chatError} sendMessageDirect={(c: string) => sendMessage(topic.sessionKey, c)} messageQueue={messageQueue} othersTyping={othersTyping} othersTypingText={othersTypingText} mentionedFiles={mentionedFiles} setMentionedFiles={setMentionedFiles} />
                </div>
                {rightPanelOpen && !isMobile && (
                  <div className="w-1/2 border-l border-[var(--border)] flex flex-col min-w-0 overflow-hidden">
                    <div className="flex items-center justify-between px-2 py-1.5 border-b border-[var(--border)] bg-[var(--bg-surface)]">
                      <span className="text-[11px] font-medium text-[var(--text-secondary)]">{rightPanelType === 'browser' ? '🌐 Browser' : `📄 ${openFilePath?.split('/').pop() || 'File'}`}</span>
                      <button onClick={() => setRightPanelOpen(false)} className="w-5 h-5 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-[#888] hover:text-[#555] dark:hover:text-[#ccc]"><X size={12} /></button>
                    </div>
                    <div className="flex-1 overflow-hidden">
                      {rightPanelType === 'browser' && <Suspense fallback={LazySpinner}><RemoteBrowserPanel contextId={topic.id} navigateUrl={browserNavigateUrl || undefined} onNavigateConsumed={() => setBrowserNavigateUrl(null)} /></Suspense>}
                      {rightPanelType === 'file' && openFilePath && <div className="h-full overflow-hidden">{fileLoading ? LazySpinner : <Suspense fallback={LazySpinner}><CodeEditor content={fileContent} filename={openFilePath.split('/').pop() || 'file'} readOnly darkMode={darkMode} /></Suspense>}</div>}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      {showSettings && <Suspense fallback={null}><TopicSettingsModal topic={topic} isOpen={showSettings} onClose={() => setShowSettings(false)} onUpdate={onUpdateTopic} /></Suspense>}
    </>
  );
}
