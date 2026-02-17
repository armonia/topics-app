import { useState, useEffect, useRef, useCallback } from 'react';
import type { Topic, ChatMessage, WSMessage, UpdateTopicRequest } from '../../types';
import { uploadApi, filesApi, autoNameApi, commandApi, memoryApi } from '../../lib/api';
import type { MentionedFile } from './FileMentionMenu';
import { PinnedMessages } from './PinnedMessages';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { CheckpointTimeline } from './CheckpointTimeline';
import { useVoiceRecording } from './useVoiceRecording';

const SLASH_COMMANDS_HELP = [
  '/status — Show session status',
  '/clear — Clear conversation',
  '/model — Change model (e.g. /model claude-opus-4-5)',
  '/reasoning — Toggle reasoning mode',
  '/help — Show available commands',
];

export interface ChatPaneProps {
  topic: Topic;
  isFocused: boolean;
  getSessionMessages: (sk: string) => ChatMessage[];
  isSessionLoading: (sk: string) => boolean;
  isSessionStreaming: (sk: string) => boolean;
  sendMessage: (sk: string, content: string, options?: { planMode?: boolean }) => Promise<boolean>;
  loadHistory: (sk: string) => Promise<boolean>;
  chatError: string | null;
  sendWS: (msg: WSMessage) => void;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  onUpdateTopic: (id: string, data: UpdateTopicRequest) => Promise<Topic | null>;
  // Interaction with adjacent panes
  onOpenFile?: (path: string) => void;
  onNavigateBrowser?: (url: string) => void;
}

export function ChatPane({
  topic, isFocused,
  getSessionMessages, isSessionLoading, isSessionStreaming, sendMessage, loadHistory,
  chatError, sendWS, onWSMessage, onUpdateTopic,
  onOpenFile: _onOpenFile, onNavigateBrowser: _onNavigateBrowser,
}: ChatPaneProps) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => { const h = () => setIsMobile(window.innerWidth < 768); window.addEventListener('resize', h); return () => window.removeEventListener('resize', h); }, []);

  const [message, setMessage] = useState('');
  const [pendingImages, setPendingImages] = useState<{ dataUrl: string; mimeType: string }[]>([]);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [mentionedFiles, setMentionedFiles] = useState<MentionedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [fileDragOver, setFileDragOver] = useState(false);
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [showPinned, _setShowPinned] = useState(false);
  const [autoNameTriggered, setAutoNameTriggered] = useState(false);
  const [_commandLoading, setCommandLoading] = useState(false);
  const [commandResult, setCommandResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [messageQueue, setMessageQueue] = useState<string[]>([]);
  const [planMode, setPlanMode] = useState(() => {
    try { const stored = localStorage.getItem(`planMode:${topic.id}`); return stored === 'true'; } catch { return false; }
  });
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

  const { isRecording, recordingTime, voiceUploading, startRecording, stopRecording, formatRecordingTime } = useVoiceRecording(sendMessage, topic.sessionKey, currentStreaming);
  const isUploading = uploading || voiceUploading;

  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  useEffect(() => { if (!isUserScrolledUp) messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [currentMessages, currentStreaming, isUserScrolledUp]);
  useEffect(() => { const c = chatContainerRef.current; if (!c) return; const h = () => { setIsUserScrolledUp(c.scrollHeight - c.scrollTop - c.clientHeight > 200); }; c.addEventListener('scroll', h, { passive: true }); return () => c.removeEventListener('scroll', h); }, []);
  useEffect(() => { if (!currentStreaming && messageQueue.length > 0) { const next = messageQueue[0]; setMessageQueue(prev => prev.slice(1)); sendMessage(topic.sessionKey, next); } }, [currentStreaming, messageQueue, sendMessage, topic.sessionKey]);
  useEffect(() => { loadHistory(topic.sessionKey); setReplyingTo(null); setAutoNameTriggered(false); }, [topic.sessionKey, loadHistory]);
  useEffect(() => { if (isFocused) setTimeout(() => textareaRef.current?.focus(), 50); }, [isFocused]);

  // After first assistant response, call server auto-name for project path detection
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
      }).catch((err) => console.warn('[AutoName] failed for topic', topic.id, err));
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
    if (cmd === '/help') { setCommandResult({ type: 'success', message: SLASH_COMMANDS_HELP.join('\n') }); return true; }
    if (cmd.startsWith('/model ')) { const m = text.slice(7).trim(); if (!m) return false; setCommandLoading(true); try { await commandApi.setModel(topic.sessionKey, m); setCommandResult({ type: 'success', message: `Model set to: ${m}` }); } catch (e: any) { setCommandResult({ type: 'error', message: e.message }); } finally { setCommandLoading(false); } return true; }
    return false;
  }, [topic.sessionKey, loadHistory]);

  const togglePlanMode = useCallback(() => {
    setPlanMode(prev => {
      const next = !prev;
      try { localStorage.setItem(`planMode:${topic.id}`, String(next)); } catch {}
      return next;
    });
  }, [topic.id]);

  const handlePlanApprove = useCallback(() => {
    sendMessage(topic.sessionKey, 'Execute the approved plan.');
  }, [sendMessage, topic.sessionKey]);

  const handlePlanReject = useCallback(() => {
    sendMessage(topic.sessionKey, 'Plan rejected. Please propose an alternative approach.');
  }, [sendMessage, topic.sessionKey]);

  const handleRememberMessage = useCallback(async (msg: ChatMessage) => {
    const snippet = msg.content.length > 300 ? msg.content.slice(0, 300) + '...' : msg.content;
    try { await memoryApi.appendToTopic(topic.id, snippet); } catch {}
  }, [topic.id]);

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
    if (curReply) { const qt = curReply.content.length > 120 ? curReply.content.slice(0, 120) + '...' : curReply.content; finalMessage = qt.split('\n').map(l => `> ${l}`).join('\n') + '\n\n' + finalMessage; }

    // Instant auto-name: set title from first message text immediately
    if (finalMessage && currentMessages.length === 0 && (topic.name === 'New Chat' || topic.name.startsWith('New '))) {
      const raw = message.trim().replace(/https?:\/\/\S+/g, '').replace(/[#*_`~\[\]()]/g, '').replace(/\s+/g, ' ').trim();
      if (raw.length > 0) {
        const words = raw.split(' ').filter(w => w.length > 0);
        let autoTitle = words.slice(0, 5).join(' ');
        if (autoTitle.length > 40) autoTitle = autoTitle.slice(0, 40).trim() + '…';
        autoTitle = autoTitle.charAt(0).toUpperCase() + autoTitle.slice(1);
        onUpdateTopic(topic.id, { name: autoTitle });
      }
    }

    if (finalMessage) await sendMessage(topic.sessionKey, finalMessage, planMode ? { planMode: true } : undefined);
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

  return (
    <div className="flex flex-col min-w-0 overflow-hidden flex-1">
      {/* Command result banner */}
      {commandResult && (
        <div className={`px-3 py-2 border-b flex items-center gap-2 flex-shrink-0 transition-all ${commandResult.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-red-500/10 border-red-500/20'}`}>
          <div className={`text-[12px] flex-1 whitespace-pre-wrap font-mono ${commandResult.type === 'success' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>{commandResult.message}</div>
          <button onClick={() => setCommandResult(null)} className="text-app-text-muted hover:text-app-text p-1">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      )}
      <PinnedMessages show={showPinned} pinnedMessages={pinnedMessages} />
      <MessageList isMobile={isMobile} topic={topic} currentMessages={currentMessages} currentLoading={currentLoading} currentStreaming={currentStreaming} copiedMsgId={copiedMsgId} fileDragOver={fileDragOver} chatContainerRef={chatContainerRef} messagesEndRef={messagesEndRef} textareaRef={textareaRef} onReply={setReplyingTo} onCopy={handleCopyMessage} onTogglePin={handleTogglePin} onFileDragOver={handleFileDragOver} onFileDragLeave={handleFileDragLeave} onFileDrop={handleFileDrop} setMessage={setMessage} onPlanApprove={handlePlanApprove} onPlanReject={handlePlanReject} onRemember={handleRememberMessage} />
      <CheckpointTimeline topicId={topic.id} onRollback={() => loadHistory(topic.sessionKey)} />
      <ChatInput isMobile={isMobile} topic={topic} currentMessages={currentMessages} currentStreaming={currentStreaming} message={message} setMessage={setMessage} pendingFiles={pendingFiles} pendingImages={pendingImages} setPendingImages={setPendingImages} uploading={isUploading} replyingTo={replyingTo} setReplyingTo={setReplyingTo} isRecording={isRecording} recordingTime={recordingTime} fileInputRef={fileInputRef} textareaRef={textareaRef} onSubmit={handleSendMessage} onKeyDown={handleKeyDown} onFileSelect={handleFileSelect} removePendingFile={removePendingFile} onPaste={handlePaste} startRecording={startRecording} stopRecording={stopRecording} formatRecordingTime={formatRecordingTime} isImageFile={isImageFile} chatError={chatError} sendMessageDirect={(c: string) => sendMessage(topic.sessionKey, c)} messageQueue={messageQueue} othersTyping={othersTyping} othersTypingText={othersTypingText} mentionedFiles={mentionedFiles} setMentionedFiles={setMentionedFiles} planMode={planMode} onTogglePlanMode={togglePlanMode} />
    </div>
  );
}
