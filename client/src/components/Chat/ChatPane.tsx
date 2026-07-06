import { useState, useEffect, useRef, useCallback } from 'react';
import { X } from 'lucide-react';
import type { Topic, ChatMessage, WSMessage, UpdateTopicRequest } from '../../types';
import type { SendMessageOptions } from '../../hooks/useChat';
import { uploadApi, filesApi, autoNameApi, commandApi, memoryApi, topicsApi } from '../../lib/api';
import { DND_TYPES } from '../../lib/dndTypes';
import { sendFocusTopic } from '../../lib/focusMessaging';
import type { MentionedFile } from './FileMentionMenu';
import { PinnedMessages } from './PinnedMessages';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { CheckpointTimeline } from './CheckpointTimeline';
import { useVoiceRecording } from './useVoiceRecording';
import { usePaneStore } from '../../state/pane/store';
import { createPaneId } from '../../state/pane/adapters';
import { useToast } from '../Shared/Toast';

const SLASH_COMMANDS_HELP = [
  '/status — Show session status',
  '/clear — Clear conversation',
  '/model — Change model (e.g. /model claude-opus-4-5)',
  '/reasoning — Toggle reasoning mode',
  '/agents — List all agent profiles',
  '/pause @name — Pause an agent',
  '/resume @name — Resume a paused agent',
  '/assign @name task — Create and assign a task to an agent',
  '/help — Show available commands',
];

/** Extract a human-readable message from an unknown thrown value. */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err);
}

export interface ChatPaneProps {
  topic: Topic;
  isFocused: boolean;
  getSessionMessages: (sk: string) => ChatMessage[];
  isSessionLoading: (sk: string) => boolean;
  isSessionStreaming: (sk: string) => boolean;
  /**
   * Stop the in-flight assistant turn for this session. Threaded down to
   * `ChatInput` so the unified composer button can present "Stop" when the
   * agent owns the turn. See `composerAction.ts` for the decision rules
   * and `stopSessionPolicy.ts` for the wipe-safety guard.
   */
  stopSession: (sk: string) => boolean;
  sendMessage: (sk: string, content: string, options?: SendMessageOptions) => Promise<boolean>;
  loadHistory: (sk: string) => Promise<boolean>;
  chatError: string | null;
  sendWS: (msg: WSMessage) => void;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  onUpdateTopic: (id: string, data: UpdateTopicRequest) => Promise<Topic | null>;
  // Interaction with adjacent panes
  onOpenFile?: (path: string) => void;
  onNavigateBrowser?: (url: string) => void;
  // Branching
  editMessage?: (sk: string, messageId: string, newContent: string) => Promise<boolean>;
  switchBranch?: (sk: string, messageId: string, branchIndex: number) => Promise<boolean>;
  // Session viewer
  onOpenSessionViewer?: (sessionKey: string) => void;
  /** Optional content rendered inside the floating input bar, just above
   *  CheckpointTimeline + ChatInput. Used by Master Topic panes to mount
   *  the board strip so it stays visible while typing. */
  aboveInputSlot?: React.ReactNode;
}

export function ChatPane({
  topic, isFocused,
  getSessionMessages, isSessionLoading, isSessionStreaming, stopSession, sendMessage, loadHistory,
  chatError, sendWS, onWSMessage, onUpdateTopic,
  onOpenFile: _onOpenFile, onNavigateBrowser: _onNavigateBrowser,
  editMessage, switchBranch, onOpenSessionViewer,
  aboveInputSlot,
}: ChatPaneProps) {
  const toast = useToast();
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => { const h = () => setIsMobile(window.innerWidth < 768); window.addEventListener('resize', h); return () => window.removeEventListener('resize', h); }, []);

  const draftKey = `draft:${topic.id}`;
  const queueKey = `msgQueue:${topic.id}`;

  const [message, setMessage] = useState(() => {
    try { return localStorage.getItem(draftKey) || ''; } catch { return ''; }
  });
  // Restore draft on topic switch
  useEffect(() => {
    try { setMessage(localStorage.getItem(`draft:${topic.id}`) || ''); } catch { setMessage(''); }
  }, [topic.id]);
  // Persist draft to localStorage
  useEffect(() => {
    try { if (message) localStorage.setItem(draftKey, message); else localStorage.removeItem(draftKey); } catch {}
  }, [message, draftKey]);
  const [pendingImages, setPendingImages] = useState<{ dataUrl: string; mimeType: string }[]>([]);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [mentionedFiles, setMentionedFiles] = useState<MentionedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [fileDragOver, setFileDragOver] = useState(false);
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [showPinned] = useState(false);
  const [autoNameTriggered, setAutoNameTriggered] = useState(false);
  const [, setCommandLoading] = useState(false);
  const [commandResult, setCommandResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [messageQueue, setMessageQueue] = useState<string[]>(() => {
    try { const s = localStorage.getItem(queueKey); return s ? JSON.parse(s) : []; } catch { return []; }
  });
  // Restore queue on topic switch
  useEffect(() => {
    try { const s = localStorage.getItem(`msgQueue:${topic.id}`); setMessageQueue(s ? JSON.parse(s) : []); } catch { setMessageQueue([]); }
  }, [topic.id]);
  // Persist queue to localStorage
  useEffect(() => {
    try { if (messageQueue.length) localStorage.setItem(queueKey, JSON.stringify(messageQueue)); else localStorage.removeItem(queueKey); } catch {}
  }, [messageQueue, queueKey]);
  // Cross-tab sync: listen for storage changes from other tabs
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === draftKey) setMessage(e.newValue || '');
      if (e.key === queueKey) { try { setMessageQueue(e.newValue ? JSON.parse(e.newValue) : []); } catch {} }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, [draftKey, queueKey]);
  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null);
  const [planMode, setPlanMode] = useState(() => {
    try { const stored = localStorage.getItem(`planMode:${topic.id}`); return stored === 'true'; } catch { return false; }
  });
  // planMode is localStorage-only (no server field). ChatPane is NOT keyed by
  // topic.id, so on an in-place topic switch (StandaloneChatGroup re-renders this
  // instance) the useState seed above stays stale — same class as the scroll and
  // fastMode reconciles below/above. Without this, Plan Mode enabled on topic A
  // leaks into topic B and its next message silently ships planMode:true.
  useEffect(() => {
    try { setPlanMode(localStorage.getItem(`planMode:${topic.id}`) === 'true'); }
    catch { setPlanMode(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic.id]);
  // Fast Mode toggle (openspec change `chat-fast-mode`). Two sources of truth:
  //   1. `topic.fastMode` (server, persisted, synced cross-window via WS).
  //   2. `localStorage["fastMode:<topic.id>"]` — used purely to avoid a flash
  //      of the OFF state during the first render before the topic prop
  //      hydrates from the API.
  // On mount we prefer the server value when present; otherwise localStorage.
  // On every toggle we write both AND optimistically POST to the server.
  const [fastMode, setFastMode] = useState<boolean>(() => {
    if (typeof topic.fastMode === 'boolean') return topic.fastMode;
    try { return localStorage.getItem(`fastMode:${topic.id}`) === 'true'; } catch { return false; }
  });
  // Reconcile if the server-pushed topic.fastMode diverges (cross-window sync,
  // or app boot order where topic arrives after first paint).
  useEffect(() => {
    if (typeof topic.fastMode === 'boolean' && topic.fastMode !== fastMode) {
      setFastMode(topic.fastMode);
      try { localStorage.setItem(`fastMode:${topic.id}`, String(topic.fastMode)); } catch {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic.fastMode, topic.id]);
  const [othersTyping, setOthersTyping] = useState(false);
  const [othersTypingText, setOthersTypingText] = useState('');
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputAreaRef = useRef<HTMLDivElement>(null);
  const [inputAreaHeight, setInputAreaHeight] = useState(0);

  // PANE-03 scroll-restore wiring (review I1). The pane id mirrors the
  // convention used by createPaneId('chat', topic.id) = `chat:${topic.id}`;
  // we read the undo-captured scrollOffset at mount (and on topic switch),
  // then persist scroll updates via the device-local setter that bypasses
  // lastSeq (no sync write per scroll tick).
  const paneId = createPaneId('chat', topic.id);
  // Seeds synchronously at mount AND on paneId change; subscribes if the pane
  // entity hasn't hydrated yet (round-7 audit fix). The previous version only
  // seeded via useState initializer, so on topic switch within the same
  // component instance (StandaloneChatGroup re-renders ChatPane without
  // remount), initialScrollOffset stayed populated with the FIRST topic's
  // value. The stale read short-circuited the subscribe effect and silently
  // broke scroll-restore for the new topic. Now we re-read from the store at
  // the top of the effect whenever paneId changes, then only subscribe if the
  // new pane entity hasn't arrived yet.
  const [initialScrollOffset, setInitialScrollOffset] = useState<number | undefined>(
    () => usePaneStore.getState().panes[paneId]?.scrollOffset,
  );
  useEffect(() => {
    // On paneId change: re-seed synchronously from the store. If the new pane
    // entity is already present, we use its value and skip the subscription.
    const current = usePaneStore.getState().panes[paneId]?.scrollOffset;
    setInitialScrollOffset(current);
    if (current !== undefined) return;
    const unsub = usePaneStore.subscribe(
      (s) => s.panes[paneId]?.scrollOffset,
      (offset) => {
        if (offset !== undefined) {
          setInitialScrollOffset(offset);
          unsub();
        }
      },
    );
    return unsub;
  }, [paneId]);
  const handleScrollOffsetChange = useCallback((top: number) => {
    usePaneStore.getState().setPaneScrollOffset(paneId, top);
  }, [paneId]);

  // Track input area height dynamically (adapts to multiline, file attachments, etc.)
  useEffect(() => {
    const el = inputAreaRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setInputAreaHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const currentMessages = getSessionMessages(topic.sessionKey);
  const currentLoading = isSessionLoading(topic.sessionKey);
  const currentStreaming = isSessionStreaming(topic.sessionKey);

  // Picker keeps a simple local override per pane. On first paint we seed it
  // from the topic's persisted `provider`/`model` (set previously via PATCH);
  // after that, picking a model is purely local — we no longer auto-PATCH on
  // every click. This avoids the draft→real promotion flash where the topic
  // id changes mid-flight and async state updates raced the chat submit.
  //
  // Cross-window sync stays available via the read path (next page load picks
  // up `topic.model` from the server). A future revisit can add per-window
  // live sync when we have a deliberate UX for it.
  const [providerOverride, setProviderOverride] = useState<{ provider: string; model: string } | null>(() => {
    if (topic.provider && topic.model) return { provider: topic.provider, model: topic.model };
    // Draft topics never hit the server PATCH (the pick is gated in
    // handleProviderOverrideChange), so a draft's provider/model lives ONLY in
    // localStorage — mirror the Fast Mode pattern below so picking e.g. Codex on
    // a NEW chat survives a refresh before the first message is sent. Without
    // this the pick silently reverts to the global default on reload (the draft
    // pane itself survives, but the synthetic draft topic carries no
    // provider/model to reseed from).
    if (topic.id.startsWith('draft:')) {
      try {
        const raw = localStorage.getItem(`providerOverride:${topic.id}`);
        if (raw) {
          const p = JSON.parse(raw);
          if (p && typeof p.provider === 'string' && typeof p.model === 'string') return { provider: p.provider, model: p.model };
        }
      } catch {}
    }
    return null;
  });
  // Mirror state into a ref so the session-switch effect can read the latest
  // override without listing it as a dep (which would re-run the reseed every
  // time the user picks a model — the opposite of what we want).
  const providerOverrideRef = useRef(providerOverride);
  useEffect(() => { providerOverrideRef.current = providerOverride; }, [providerOverride]);
  // Track the previous topic id so we can detect a draft → real promotion vs
  // a genuine session switch.
  const prevTopicIdRef = useRef(topic.id);
  // Latest fastMode read by the promotion effect below. Captured in a ref so
  // we don't have to put `fastMode` in the effect deps (it'd refire on every
  // toggle and re-PUT the same value). The ref is updated by another effect.
  const fastModeRef = useRef(false);
  useEffect(() => { fastModeRef.current = fastMode; }, [fastMode]);

  useEffect(() => {
    const prevId = prevTopicIdRef.current;
    prevTopicIdRef.current = topic.id;
    const wasDraft = prevId.startsWith('draft:');
    const isNowReal = !topic.id.startsWith('draft:');
    if (wasDraft && isNowReal && prevId !== topic.id) {
      // Draft → real promotion: the user's pick from the draft phase must
      // survive (server just created the real topic with NULL provider/model
      // because the PATCH was gated while still a draft). Keep the override
      // in local state AND persist it to the new topic id now.
      const pick = providerOverrideRef.current;
      if (pick) {
        void onUpdateTopic(topic.id, { provider: pick.provider, model: pick.model });
      }
      // The draft pick was persisted under the draft id (see
      // handleProviderOverrideChange); the real topic now carries it on the
      // server, so drop the stale draft key (mirrors the fastMode migration
      // below).
      try { localStorage.removeItem(`providerOverride:${prevId}`); } catch {}
      // Same story for Fast Mode (openspec change `chat-fast-mode`). The
      // composer toggle wrote to `fastMode:draft:abc` and skipped the PUT
      // (drafts have no server-side row to PUT to). Now that the real topic
      // exists, persist the bit to its id, migrate the localStorage key
      // (old key kept for one render in case another component still reads
      // it; cleaned up on next mount), and broadcast via PUT for
      // cross-window sync.
      if (fastModeRef.current) {
        void onUpdateTopic(topic.id, { fastMode: true });
        try {
          localStorage.setItem(`fastMode:${topic.id}`, 'true');
          localStorage.removeItem(`fastMode:${prevId}`);
        } catch {}
      }
      return;
    }
    // Genuine session switch — reseed from whatever the new topic persists.
    setProviderOverride(
      topic.provider && topic.model ? { provider: topic.provider, model: topic.model } : null,
    );
  }, [topic.sessionKey, topic.id, topic.provider, topic.model, onUpdateTopic]);

  const isDraftTopic = topic.id.startsWith('draft:');
  const handleProviderOverrideChange = useCallback((next: { provider: string; model: string } | null) => {
    setProviderOverride(next);
    if (isDraftTopic) {
      // No server row to PATCH yet — persist the pick device-locally (same
      // approach as Fast Mode for drafts) so it survives a reload before the
      // draft is promoted on send. The promotion effect above migrates it to
      // the real topic id + the server and clears this key.
      try {
        if (next) localStorage.setItem(`providerOverride:${topic.id}`, JSON.stringify(next));
        else localStorage.removeItem(`providerOverride:${topic.id}`);
      } catch {}
      return;
    }
    // Best-effort persist so a reload (or another pane on the same topic) sees
    // the same selection. Failures are non-fatal — the local state still
    // drives the next chat request.
    void onUpdateTopic(topic.id, {
      provider: next?.provider ?? null,
      model: next?.model ?? null,
    });
  }, [isDraftTopic, onUpdateTopic, topic.id]);

  const defaultProviderLabel = topic.provider ?? undefined;

  const { isRecording, recordingTime, voiceUploading, startRecording, stopRecording, formatRecordingTime } = useVoiceRecording(sendMessage, topic.sessionKey, currentStreaming);
  const isUploading = uploading || voiceUploading;

  // Scroll management is handled entirely by Virtuoso in MessageList
  // (followOutput="smooth" for new items, explicit scrollToIndex for streaming updates)
  useEffect(() => { if (!currentStreaming && messageQueue.length > 0) { const next = messageQueue[0]; setMessageQueue(prev => prev.slice(1)); sendMessage(topic.sessionKey, next); } }, [currentStreaming, messageQueue, sendMessage, topic.sessionKey]);
  useEffect(() => { loadHistory(topic.sessionKey); setReplyingTo(null); setAutoNameTriggered(false); }, [topic.sessionKey, loadHistory]);
  useEffect(() => { if (isFocused) setTimeout(() => textareaRef.current?.focus(), 50); }, [isFocused]);
  // Mark topic as read when this chat pane gains focus (covers ProjectWindow usage)
  useEffect(() => { if (isFocused && topic.id) { topicsApi.markRead(topic.id).catch(() => {}); sendFocusTopic(sendWS, topic.id); } }, [isFocused, topic.id, sendWS]);

  // After first assistant response, call server auto-name for project path detection
  // Skip for draft topics (not yet persisted on server)
  const isDraft = topic.id.startsWith('draft:');
  useEffect(() => {
    if (isDraft || autoNameTriggered || currentStreaming) return;
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
  }, [isDraft, currentMessages, currentStreaming, topic.id, topic.name, topic.projectPath, autoNameTriggered, onUpdateTopic]);

  const sendTyping = useCallback((text?: string) => sendWS({ type: 'typing', topicId: topic.id, text: text || '' }), [sendWS, topic.id]);

  useEffect(() => {
    const unsub = onWSMessage((msg: WSMessage) => {
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

  const uploadFiles = useCallback(async (files: File[]) => {
    const paths: string[] = []; const failed: string[] = [];
    for (const f of files) { try { const r = await uploadApi.uploadFile(f); paths.push(r.path); } catch (e) { console.error('[ChatPane] file upload failed:', f.name, e); failed.push(f.name); } }
    if (failed.length > 0) toast.error(`Upload failed: ${failed.join(', ')}`);
    return paths;
  }, [toast]);

  const handleSlashCommand = useCallback(async (text: string): Promise<boolean> => {
    const cmd = text.toLowerCase().trim();
    if (cmd === '/status') { setCommandLoading(true); try { const r = await commandApi.status(topic.sessionKey); setCommandResult({ type: 'success', message: r.output || 'Status retrieved' }); } catch (e) { setCommandResult({ type: 'error', message: errMessage(e) }); } finally { setCommandLoading(false); } return true; }
    if (cmd === '/clear') { if (!window.confirm('Clear conversation? A backup will be saved.')) return true; setCommandLoading(true); try { await commandApi.clear(topic.sessionKey); loadHistory(topic.sessionKey); setCommandResult({ type: 'success', message: 'Conversation cleared' }); } catch (e) { setCommandResult({ type: 'error', message: errMessage(e) }); } finally { setCommandLoading(false); } return true; }
    if (cmd === '/reasoning') { setCommandLoading(true); try { const r = await commandApi.toggleReasoning(topic.sessionKey); setCommandResult({ type: 'success', message: r.message || 'Reasoning toggled' }); } catch (e) { setCommandResult({ type: 'error', message: errMessage(e) }); } finally { setCommandLoading(false); } return true; }
    if (cmd === '/help') { setCommandResult({ type: 'success', message: SLASH_COMMANDS_HELP.join('\n') }); return true; }
    if (cmd.startsWith('/model ')) { const m = text.slice(7).trim(); if (!m) return false; setCommandLoading(true); try { await commandApi.setModel(topic.sessionKey, m); setCommandResult({ type: 'success', message: `Model set to: ${m}` }); } catch (e) { setCommandResult({ type: 'error', message: errMessage(e) }); } finally { setCommandLoading(false); } return true; }

    // /project — info / create <name> / open <path-or-name>
    if (cmd === '/project' || cmd.startsWith('/project ')) {
      const rest = text.slice('/project'.length).trim();
      let sub: 'create' | 'open' | 'info' = 'info';
      let value = '';
      if (rest.startsWith('create ')) { sub = 'create'; value = rest.slice(7).trim(); }
      else if (rest === 'create') { setCommandResult({ type: 'error', message: 'Usage: /project create <name>' }); return true; }
      else if (rest.startsWith('open ')) { sub = 'open'; value = rest.slice(5).trim(); }
      else if (rest === 'open') { setCommandResult({ type: 'error', message: 'Usage: /project open <name-or-path>' }); return true; }
      setCommandLoading(true);
      try {
        const r = await commandApi.project(topic.sessionKey, sub, value || undefined);
        setCommandResult({ type: 'success', message: r.output || 'Done' });
      } catch (e) {
        setCommandResult({ type: 'error', message: errMessage(e) });
      } finally { setCommandLoading(false); }
      return true;
    }

    // Phase 30 BROWSER-CHAT-04 — /browser <url> opens or focuses the topic's
    // browser pane and navigates. Intercepted BEFORE LLM dispatch.
    if (cmd.startsWith('/browser ')) {
      const url = text.slice('/browser '.length).trim();
      if (!url) {
        setCommandResult({ type: 'error', message: 'Usage: /browser <url>' });
        return true;
      }
      // Normalize: prepend https:// when no protocol given.
      const normalized = /^https?:\/\//.test(url) ? url : `https://${url}`;
      // Loosely-coupled signal: layout layer listens for browser:open-and-navigate
      // and ensureBrowserPane + navigates. Mirrors the existing browser:navigate
      // CustomEvent pattern used by server-driven detection.
      window.dispatchEvent(new CustomEvent('browser:open-and-navigate', {
        detail: { topicId: topic.id, url: normalized },
      }));
      setCommandResult({ type: 'success', message: `Opening browser → ${normalized}` });
      return true;
    }

    // Phase 30 BROWSER-CHAT-04 — @browser <prompt> is a user-side mnemonic.
    // No special parsing: the message flows to the LLM normally, and since
    // browserTools are registered for SDK providers (claude/openai), the model
    // sees them and decides when to call. Returning false lets sendMessage
    // dispatch the original text to the chat pipeline.

    return false;
  }, [topic.sessionKey, topic.id, loadHistory]);

  const togglePlanMode = useCallback(() => {
    setPlanMode(prev => {
      const next = !prev;
      try { localStorage.setItem(`planMode:${topic.id}`, String(next)); } catch {}
      return next;
    });
  }, [topic.id]);

  // Toggle Fast Mode. Updates: (1) local state for immediate UI feedback,
  // (2) localStorage for cold-boot hydration, (3) server via PUT so other
  // windows of the same topic sync via the `topic:updated` WS broadcast.
  // The PUT is fire-and-forget — UI doesn't wait. If it fails, the next
  // topic hydration corrects the divergence (see the reconciliation effect
  // above keyed on `topic.fastMode`).
  const toggleFastMode = useCallback(() => {
    // Side effects MUST live outside the setState callback — in React 18
    // Strict Mode the updater is invoked twice during development, which
    // would double-fire `onUpdateTopic` and double-write localStorage. The
    // setter itself is dedupe-safe (Object.is), but the side effects aren't.
    const next = !fastModeRef.current;
    setFastMode(next);
    fastModeRef.current = next;
    try { localStorage.setItem(`fastMode:${topic.id}`, String(next)); } catch {}
    // Draft topics aren't persisted yet — skip the PUT (would 404). Local
    // state is sufficient until the draft is promoted; the promotion effect
    // above migrates the bit to the new real topic id once it exists.
    if (!topic.id.startsWith('draft:')) {
      void onUpdateTopic(topic.id, { fastMode: next });
    }
  }, [topic.id, onUpdateTopic]);

  const handlePlanApprove = useCallback(() => {
    sendMessage(topic.sessionKey, 'Execute the approved plan.');
  }, [sendMessage, topic.sessionKey]);

  const handlePlanReject = useCallback(() => {
    sendMessage(topic.sessionKey, 'Plan rejected. Please propose an alternative approach.');
  }, [sendMessage, topic.sessionKey]);

  const handleRetry = useCallback(() => {
    const lastUserMsg = [...currentMessages].reverse().find(m => m.role === 'user');
    if (!lastUserMsg) return;
    const opts: { provider?: string; model?: string } = {};
    if (providerOverride) {
      opts.provider = providerOverride.provider;
      opts.model = providerOverride.model;
    }
    sendMessage(topic.sessionKey, lastUserMsg.content, Object.keys(opts).length ? opts : undefined);
  }, [currentMessages, sendMessage, topic.sessionKey, providerOverride]);

  const handleRememberMessage = useCallback(async (msg: ChatMessage) => {
    const snippet = msg.content.length > 300 ? msg.content.slice(0, 300) + '...' : msg.content;
    try { await memoryApi.appendToTopic(topic.id, snippet); } catch {}
  }, [topic.id]);

  const handleEditMessage = useCallback((msg: ChatMessage) => {
    setEditingMessage(msg);
    setMessage(msg.content);
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, [setMessage]);

  const handleCancelEdit = useCallback(() => {
    setEditingMessage(null);
    setMessage('');
  }, [setMessage]);

  const handleSubmitEdit = useCallback(async () => {
    if (!editingMessage || !editMessage || !message.trim()) return;
    const content = message.trim();
    setEditingMessage(null);
    setMessage('');
    await editMessage(topic.sessionKey, editingMessage.id, content);
  }, [editingMessage, editMessage, message, topic.sessionKey, setMessage]);

  const handleSwitchBranch = useCallback(async (messageId: string, branchIndex: number) => {
    if (!switchBranch) return;
    await switchBranch(topic.sessionKey, messageId, branchIndex);
  }, [switchBranch, topic.sessionKey]);

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
    // Edit mode: submit the edit
    if (editingMessage) {
      await handleSubmitEdit();
      return;
    }
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
        if (curImages.length > 0) {
          const urls: string[] = []; let imgFailCount = 0;
          for (const img of curImages) {
            try {
              const res = await fetch('/api/upload-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: img.dataUrl, mimeType: img.mimeType }) });
              if (res.ok) urls.push((await res.json()).url); else { imgFailCount++; console.error('[ChatPane] image upload failed:', res.status, res.statusText); }
            } catch (e) { imgFailCount++; console.error('[ChatPane] image upload failed:', e); }
          }
          if (imgFailCount > 0) toast.error(`${imgFailCount} image${imgFailCount > 1 ? 's' : ''} failed to upload`);
          if (urls.length > 0) finalMessage = urls.map(u => `[Attached file: ${u}]`).join('\n') + (finalMessage ? '\n' + finalMessage : '');
        }
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
      const raw = message.trim().replace(/https?:\/\/\S+/g, '').replace(/[#*_`~[\]()]/g, '').replace(/\s+/g, ' ').trim();
      if (raw.length > 0) {
        const words = raw.split(' ').filter(w => w.length > 0);
        let autoTitle = words.slice(0, 5).join(' ');
        if (autoTitle.length > 40) autoTitle = autoTitle.slice(0, 40).trim() + '…';
        autoTitle = autoTitle.charAt(0).toUpperCase() + autoTitle.slice(1);
        onUpdateTopic(topic.id, { name: autoTitle });
      }
    }

    if (finalMessage) {
      const opts: { planMode?: boolean; fastMode?: boolean; provider?: string; model?: string } = {};
      if (planMode) opts.planMode = true;
      // Fast Mode is the per-turn signal the server uses to pick the
      // provider's native fast model (see openspec `chat-fast-mode`). We send
      // it whenever the toggle is ON — picker (`opts.model`) and persisted
      // `topic.model` still win, the server enforces priority.
      if (fastMode) opts.fastMode = true;
      if (providerOverride) {
        opts.provider = providerOverride.provider;
        opts.model = providerOverride.model;
      }
      await sendMessage(topic.sessionKey, finalMessage, Object.keys(opts).length ? opts : undefined);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); } sendTyping(message); };
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => { const f = Array.from(e.target.files || []); if (f.length > 0) setPendingFiles(prev => [...prev, ...f]); if (fileInputRef.current) fileInputRef.current.value = ''; };
  const removePendingFile = (i: number) => setPendingFiles(prev => prev.filter((_, idx) => idx !== i));

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items); const imgs: File[] = [], others: File[] = [];
    for (const item of items) { if (item.kind === 'file') { const f = item.getAsFile(); if (f) { if (f.type.startsWith('image/')) { imgs.push(f); } else { others.push(f); } } } }
    if (imgs.length > 0) { e.preventDefault(); Promise.all(imgs.map(f => resizeImageToBase64(f))).then(r => setPendingImages(prev => [...prev, ...r])).catch(() => {}); }
    if (others.length > 0) { e.preventDefault(); setPendingFiles(prev => [...prev, ...others]); }
  }, [resizeImageToBase64]);

  const handleFileDragOver = useCallback((e: React.DragEvent) => { if (e.dataTransfer.types.includes(DND_TYPES.PANEL_ID)) return; e.preventDefault(); e.stopPropagation(); setFileDragOver(true); }, []);
  const handleFileDragLeave = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); if (!e.currentTarget.contains(e.relatedTarget as Node)) setFileDragOver(false); }, []);
  const handleFileDrop = useCallback((e: React.DragEvent) => { if (e.dataTransfer.types.includes(DND_TYPES.PANEL_ID)) return; e.preventDefault(); e.stopPropagation(); setFileDragOver(false); const f = Array.from(e.dataTransfer.files); if (f.length > 0) setPendingFiles(prev => [...prev, ...f]); }, []);

  const handleCopyMessage = (msg: ChatMessage) => { navigator.clipboard.writeText(msg.content).then(() => { setCopiedMsgId(msg.id); setTimeout(() => setCopiedMsgId(null), 2000); }); };
  const handleTogglePin = async (msg: ChatMessage) => { const pinned = topic.pinnedMessages || []; const newPinned = pinned.includes(msg.id) ? pinned.filter(id => id !== msg.id) : [...pinned, msg.id]; await onUpdateTopic(topic.id, { pinnedMessages: newPinned }); };
  const isImageFile = (f: File) => f.type.startsWith('image/');
  const pinnedMessages = currentMessages.filter(m => (topic.pinnedMessages || []).includes(m.id));

  return (
    <div className="relative flex flex-col min-w-0 min-h-0 overflow-hidden flex-1 w-full max-w-full">
      {commandResult && (
        <div className={`px-3 py-2 border-b flex items-center gap-2 flex-shrink-0 transition-all ${commandResult.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-red-500/10 border-red-500/20'}`}>
          <div className={`text-[12px] flex-1 whitespace-pre-wrap font-mono ${commandResult.type === 'success' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>{commandResult.message}</div>
          <button onClick={() => setCommandResult(null)} className="text-app-text-muted hover:text-app-text p-1">
            <X size={12} />
          </button>
        </div>
      )}
      <PinnedMessages show={showPinned} pinnedMessages={pinnedMessages} />
      <MessageList isMobile={isMobile} topic={topic} currentMessages={currentMessages} currentLoading={currentLoading} currentStreaming={currentStreaming} copiedMsgId={copiedMsgId} fileDragOver={fileDragOver} chatContainerRef={chatContainerRef} messagesEndRef={messagesEndRef} textareaRef={textareaRef} onReply={setReplyingTo} onCopy={handleCopyMessage} onTogglePin={handleTogglePin} onFileDragOver={handleFileDragOver} onFileDragLeave={handleFileDragLeave} onFileDrop={handleFileDrop} setMessage={setMessage} onPlanApprove={handlePlanApprove} onPlanReject={handlePlanReject} onRemember={handleRememberMessage} onEdit={editMessage ? handleEditMessage : undefined} onSwitchBranch={switchBranch ? handleSwitchBranch : undefined} onOpenSessionViewer={onOpenSessionViewer} onMessage={onWSMessage} onRetry={handleRetry} inputAreaHeight={inputAreaHeight} initialScrollOffset={initialScrollOffset} onScrollOffsetChange={handleScrollOffsetChange} />
      {/* The composer docks at the bottom with only its natural margin — no
          home-indicator reservation (the user wants minimal bottom space), so it
          reaches the bottom edge and the OS indicator simply overlays it. */}
      <div ref={inputAreaRef} className="absolute bottom-0 left-0 right-0">
        {aboveInputSlot}
        <CheckpointTimeline topicId={topic.id} onRollback={() => loadHistory(topic.sessionKey)} />
        <ChatInput isMobile={isMobile} topic={topic} currentMessages={currentMessages} currentStreaming={currentStreaming} message={message} setMessage={setMessage} pendingFiles={pendingFiles} pendingImages={pendingImages} setPendingImages={setPendingImages} uploading={isUploading} replyingTo={replyingTo} setReplyingTo={setReplyingTo} isRecording={isRecording} recordingTime={recordingTime} fileInputRef={fileInputRef} textareaRef={textareaRef} onSubmit={handleSendMessage} onStop={() => { stopSession(topic.sessionKey); }} onKeyDown={handleKeyDown} onFileSelect={handleFileSelect} removePendingFile={removePendingFile} onPaste={handlePaste} startRecording={startRecording} stopRecording={stopRecording} formatRecordingTime={formatRecordingTime} isImageFile={isImageFile} chatError={chatError} sendMessageDirect={(c: string) => sendMessage(topic.sessionKey, c)} messageQueue={messageQueue} onUpdateQueueItem={(idx, content) => setMessageQueue(prev => prev.map((m, i) => (i === idx ? content : m)))} onRemoveQueueItem={(idx) => setMessageQueue(prev => prev.filter((_, i) => i !== idx))} onClearQueue={() => setMessageQueue([])} othersTyping={othersTyping} othersTypingText={othersTypingText} mentionedFiles={mentionedFiles} setMentionedFiles={setMentionedFiles} planMode={planMode} onTogglePlanMode={togglePlanMode} fastMode={fastMode} onToggleFastMode={toggleFastMode} editingMessage={editingMessage} onCancelEdit={handleCancelEdit} providerOverride={providerOverride} onProviderOverrideChange={handleProviderOverrideChange} defaultProviderLabel={defaultProviderLabel} />
      </div>
    </div>
  );
}
