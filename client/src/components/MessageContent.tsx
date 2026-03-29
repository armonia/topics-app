// VoiceMessagePlayer v2 - custom player for voice messages
import React, { useEffect, useMemo, useState, useCallback, useRef, memo } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, Check, CheckCheck, Download } from 'lucide-react';
import { getFileIconDef } from '../lib/fileIcons';
import { getMediaUrl } from '../lib/api';
import { ThinkingBlock, ToolCallsList, ToolCallBadge, PartialIndicator } from './MessageParts';
import type { ToolCall } from '../types';
import { hasDiffBlocks, parseMessageWithDiffs, type MessageSegment } from '../lib/diffParser';
import { DiffBlock, type DiffBlockHandle } from './Chat/DiffBlock';
import { isPlanResponse, PlanView } from './Chat/PlanView';
import { AgentSpawnCard } from './Chat/AgentSpawnCard';

/**
 * Close any open/incomplete markdown tokens so ReactMarkdown doesn't flicker
 * during streaming. Only called when partial === true.
 */
function completePartialMarkdown(text: string): string {
  // 1. Close open fenced code blocks (``` or ~~~)
  const fenceRegex = /^(`{3,}|~{3,})/gm;
  let fenceCount = 0;
  while (fenceRegex.exec(text) !== null) fenceCount++;
  if (fenceCount % 2 !== 0) {
    text += '\n```';
  }

  // If inside a code block, don't try to fix inline formatting
  if (fenceCount % 2 !== 0) return text;

  // 2. Close open inline code spans (backticks)
  //    Count unescaped backticks outside of code blocks
  let backticks = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '`' && (i === 0 || text[i - 1] !== '\\')) backticks++;
  }
  if (backticks % 2 !== 0) {
    text += '`';
  }

  // 3. Close open bold markers (**)
  const boldMatches = text.match(/\*\*/g);
  if (boldMatches && boldMatches.length % 2 !== 0) {
    text += '**';
  }

  // 4. Close open italic markers (single * not part of **)
  const withoutBold = text.replace(/\*\*/g, '');
  const italicMatches = withoutBold.match(/\*/g);
  if (italicMatches && italicMatches.length % 2 !== 0) {
    text += '*';
  }

  // 5. Remove trailing incomplete link/image syntax: [text without ]
  text = text.replace(/!?\[([^\]]*)$/, '$1');
  // [text](incomplete url
  text = text.replace(/(\[[^\]]*\])\([^)]*$/, '$1');

  return text;
}

// File extension helpers
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
const AUDIO_EXTS = ['ogg', 'mp3', 'wav', 'm4a', 'aac', 'opus', 'webm'];
const DOC_EXTS = ['pdf', 'zip', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt', 'md', 'json'];

function getExtension(path: string): string {
  const match = path.match(/\.([a-zA-Z0-9]+)$/);
  return match ? match[1].toLowerCase() : '';
}

function isImage(path: string): boolean {
  return IMAGE_EXTS.includes(getExtension(path));
}

function isAudio(path: string): boolean {
  return AUDIO_EXTS.includes(getExtension(path));
}

function isDocument(path: string): boolean {
  return DOC_EXTS.includes(getExtension(path));
}

function getFileName(path: string): string {
  return path.split('/').pop() || path;
}

function FileIcon({ path, size = 24 }: { path: string; size?: number }) {
  const def = getFileIconDef(getFileName(path));
  const I = def.icon;
  return <I size={size} style={{ color: def.color }} />;
}

function extractMediaPaths(text: string): { cleanText: string; mediaPaths: string[]; voicePaths: Set<string> } {
  const mediaPaths: string[] = [];
  const voicePaths = new Set<string>();
  const mediaPattern = /MEDIA:([^\s\n]+)/g;
  let match;
  while ((match = mediaPattern.exec(text)) !== null) mediaPaths.push(match[1]);

  const attachedPattern = /\[Attached file:\s*([^\]]+)\]/g;
  while ((match = attachedPattern.exec(text)) !== null) mediaPaths.push(match[1].trim());

  const voicePattern = /\[Voice message:\s*([^\]]+)\]/g;
  while ((match = voicePattern.exec(text)) !== null) { const p = match[1].trim(); mediaPaths.push(p); voicePaths.add(p); }

  const cleanText = text
    .replace(/MEDIA:([^\s\n]+)/g, '')
    .replace(/\[Attached file:\s*[^\]]+\]/g, '')
    .replace(/\[Voice message:\s*[^\]]+\]/g, '')
    .trim();

  return { cleanText, mediaPaths, voicePaths };
}

function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const lastTouchDist = useRef<number | null>(null);
  const lastTouchMid = useRef<{ x: number; y: number } | null>(null);
  const isDragging = useRef(false);
  const lastSingleTouch = useRef<{ x: number; y: number } | null>(null);

  const getTouchDist = (t: React.TouchList) =>
    Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      lastTouchDist.current = getTouchDist(e.touches);
      lastTouchMid.current = {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
      };
    } else if (e.touches.length === 1 && scale > 1) {
      isDragging.current = true;
      lastSingleTouch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    e.stopPropagation();
    if (e.touches.length === 2 && lastTouchDist.current !== null) {
      const newDist = getTouchDist(e.touches);
      const ratio = newDist / lastTouchDist.current;
      setScale(s => Math.min(Math.max(s * ratio, 1), 5));
      lastTouchDist.current = newDist;
    } else if (e.touches.length === 1 && isDragging.current && lastSingleTouch.current) {
      const dx = e.touches[0].clientX - lastSingleTouch.current.x;
      const dy = e.touches[0].clientY - lastSingleTouch.current.y;
      setOffset(o => ({ x: o.x + dx, y: o.y + dy }));
      lastSingleTouch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  };

  const handleTouchEnd = () => {
    lastTouchDist.current = null;
    lastTouchMid.current = null;
    isDragging.current = false;
    lastSingleTouch.current = null;
    if (scale < 1.05) { setScale(1); setOffset({ x: 0, y: 0 }); }
  };

  const handleBackdropClick = () => {
    if (scale > 1) { setScale(1); setOffset({ x: 0, y: 0 }); }
    else onClose();
  };

  return createPortal(
    <div
      data-testid="image-lightbox"
      className="fixed inset-0 bg-black/90 z-[9999] flex items-center justify-center overflow-hidden"
      style={{ touchAction: 'none' }}
      onClick={handleBackdropClick}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <img
        src={src}
        alt={alt}
        className="max-w-full max-h-full object-contain rounded-lg select-none"
        style={{ transform: `scale(${scale}) translate(${offset.x / scale}px, ${offset.y / scale}px)`, transformOrigin: 'center', transition: scale === 1 ? 'transform 0.2s' : 'none', cursor: scale > 1 ? 'grab' : 'zoom-in' }}
        onClick={(e) => e.stopPropagation()}
        draggable={false}
      />
      <button
        data-testid="lightbox-close"
        className="absolute top-4 right-4 text-white text-2xl bg-black/50 rounded-full w-10 h-10 flex items-center justify-center"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
      >×</button>
      {scale > 1 && (
        <button
          className="absolute bottom-8 left-1/2 -translate-x-1/2 text-white text-xs bg-black/50 rounded-full px-3 py-1"
          onClick={(e) => { e.stopPropagation(); setScale(1); setOffset({ x: 0, y: 0 }); }}
        >Reset zoom</button>
      )}
    </div>,
    document.body
  );
}

function MediaImage({ path }: { path: string }) {
  const [lightbox, setLightbox] = useState(false);
  const [error, setError] = useState(false);
  const src = getMediaUrl(path);

  if (error) {
    return (
      <div data-testid="media-image-error" className="inline-flex items-center gap-2 bg-app-hover dark:bg-elevated rounded-lg p-2 text-sm text-app-text-muted">
        🖼️ Image failed to load: {getFileName(path)}
      </div>
    );
  }

  return (
    <>
      <img data-testid="media-image" src={src} alt={getFileName(path)} className="max-w-full max-h-80 rounded-lg cursor-pointer hover:opacity-90 transition-opacity my-1" onClick={() => setLightbox(true)} onError={() => setError(true)} loading="lazy" />
      {lightbox && <ImageLightbox src={src} alt={getFileName(path)} onClose={() => setLightbox(false)} />}
    </>
  );
}

function VoiceMessagePlayer({ path, isUserMessage }: { path: string; isUserMessage?: boolean }) {
  const src = getMediaUrl(path);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onMeta = () => { if (audio.duration && isFinite(audio.duration)) setDuration(audio.duration); };
    const onTime = () => {
      setCurrentTime(audio.currentTime);
      // Safari sometimes only reports duration after playback starts
      if (audio.duration && isFinite(audio.duration) && duration === 0) setDuration(audio.duration);
    };
    const onEnded = () => { setPlaying(false); setCurrentTime(0); };
    const onError = (e: Event) => console.error('Audio error:', (e.target as HTMLAudioElement)?.error);
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('durationchange', onMeta);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    return () => {
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('durationchange', onMeta);
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
    };
  }, []);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) { audio.pause(); setPlaying(false); }
    else { audio.play(); setPlaying(true); }
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = pct * duration;
    setCurrentTime(audio.currentTime);
  };

  const fmt = (s: number) => {
    if (!s || !isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div data-testid="voice-player" className="flex items-center gap-2.5 py-1 min-w-[180px] max-w-[260px]">
      <audio ref={audioRef} src={src} preload="auto" />
      <button
        onClick={toggle}
        className={`w-9 h-9 flex-shrink-0 flex items-center justify-center rounded-full transition-colors ${
          isUserMessage
            ? 'bg-white/20 hover:bg-white/30 text-white'
            : 'bg-primary/15 hover:bg-primary/25 text-primary'
        }`}
      >
        {playing ? (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="2" y="1" width="4" height="12" rx="1" /><rect x="8" y="1" width="4" height="12" rx="1" /></svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M3 1.5v11l9-5.5z" /></svg>
        )}
      </button>
      <div className="flex-1 flex flex-col gap-1 min-w-0">
        <div
          className="h-1.5 rounded-full cursor-pointer relative overflow-hidden"
          style={{ backgroundColor: isUserMessage ? 'rgba(255,255,255,0.2)' : 'rgba(var(--primary-rgb, 59,130,246),0.15)' }}
          onClick={seek}
        >
          <div
            className="absolute inset-y-0 left-0 rounded-full transition-all"
            style={{
              width: `${progress}%`,
              backgroundColor: isUserMessage ? 'rgba(255,255,255,0.8)' : 'var(--primary, #3b82f6)',
            }}
          />
        </div>
        <div className={`flex justify-between text-[10px] tabular-nums ${isUserMessage ? 'text-white/60' : 'text-app-text-muted'}`}>
          <span>{fmt(currentTime)}</span>
          <span>{fmt(duration)}</span>
        </div>
      </div>
    </div>
  );
}

function MediaAudio({ path, isVoice, isUserMessage }: { path: string; isVoice?: boolean; isUserMessage?: boolean }) {
  if (isVoice) return <VoiceMessagePlayer path={path} isUserMessage={isUserMessage} />;
  const src = getMediaUrl(path);
  return (
    <div data-testid="media-audio" className="my-2 bg-elevated dark:bg-elevated rounded-lg p-3 border border-app-border-light">
      <div className="flex items-center gap-2 mb-2 text-sm text-app-text-secondary">🎵 {getFileName(path)}</div>
      <audio controls className="w-full" preload="metadata">
        <source src={src} />
        Your browser does not support audio playback.
      </audio>
    </div>
  );
}

function MediaFile({ path }: { path: string }) {
  const src = getMediaUrl(path);
  return (
    <a
      data-testid="media-file"
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      download={getFileName(path)}
      className="my-1 flex items-center gap-3 bg-elevated hover:bg-app-hover rounded-lg p-3 border border-app-border-light transition-colors no-underline text-inherit"
    >
      <FileIcon path={path} size={24} />
      <div className="flex-1 min-w-0">
        <div data-testid="media-file-name" className="text-sm font-medium truncate">{getFileName(path)}</div>
        <div className="text-xs text-app-text-muted uppercase">{getExtension(path)} file</div>
      </div>
      <Download size={16} className="text-app-text-muted flex-shrink-0" />
    </a>
  );
}

function MediaRenderer({ path, isVoice, isUserMessage }: { path: string; isVoice?: boolean; isUserMessage?: boolean }) {
  if (isImage(path)) return <MediaImage path={path} />;
  if (isAudio(path) || isVoice) return <MediaAudio path={path} isVoice={isVoice} isUserMessage={isUserMessage} />;
  if (isDocument(path)) return <MediaFile path={path} />;
  return <MediaFile path={path} />;
}

// Helper to extract text content from React nodes
function getTextContent(node: React.ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(getTextContent).join('');
  if (node && typeof node === 'object' && 'props' in node) {
    return getTextContent((node as any).props.children);
  }
  return '';
}

// Code block with copy button, language badge, line numbers, collapsible, word wrap
const CodeBlock = memo(function CodeBlock({ children, className }: { children: React.ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const [collapsed, setCollapsed] = useState(true); // collapsed by default if >20 lines
  const [showLineNumbers, setShowLineNumbers] = useState(false);
  const [wordWrap, setWordWrap] = useState(false);
  const language = className?.replace('language-', '') || '';
  
  const textContent = getTextContent(children);
  const lines = textContent.split('\n');
  const lineCount = lines.length;
  const isLong = lineCount > 20;
  const PREVIEW_LINES = 10;

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(textContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [textContent]);

  const displayContent = isLong && collapsed
    ? lines.slice(0, PREVIEW_LINES).join('\n')
    : textContent;

  const displayLines = displayContent.split('\n');

  return (
    <div className="code-block-wrapper">
      {/* Header with language + controls */}
      <div className="flex items-center justify-between bg-app-code-bg rounded-t-md px-2.5 py-1 border-b border-white/5">
        <div className="flex items-center gap-2">
          {language && <span className="text-[10px] uppercase tracking-wider text-indigo-300/70 font-medium">{language}</span>}
          <span className="text-[10px] text-gray-500">{lineCount} lines</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowLineNumbers(p => !p)}
            className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${showLineNumbers ? 'bg-indigo-500/20 text-indigo-300' : 'text-gray-500 hover:text-gray-300'}`}
            title="Toggle line numbers"
          >
            #
          </button>
          <button
            onClick={() => setWordWrap(p => !p)}
            className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${wordWrap ? 'bg-indigo-500/20 text-indigo-300' : 'text-gray-500 hover:text-gray-300'}`}
            title="Toggle word wrap"
          >
            ↩
          </button>
          <button
            onClick={handleCopy}
            className="text-gray-400 hover:text-gray-200 rounded px-1.5 py-0.5 text-[10px] flex items-center gap-1 transition-colors"
          >
            {copied ? <><Check size={10} /> Copied</> : <><Copy size={10} /> Copy</>}
          </button>
        </div>
      </div>
      <pre className={`bg-app-code-bg text-gray-100 ${isLong && collapsed ? '' : 'rounded-b-md'} p-2.5 text-[12.5px] leading-[1.5] ${wordWrap ? 'whitespace-pre-wrap break-words' : 'overflow-x-auto'}`} style={{ margin: 0 }}>
        <code className="text-[12.5px]">
          {showLineNumbers ? (
            <table className="border-collapse w-full">
              <tbody>
                {displayLines.map((line, i) => (
                  <tr key={i}>
                    <td className="text-right pr-3 text-gray-600 select-none w-[1%] whitespace-nowrap text-[11px] align-top">{i + 1}</td>
                    <td className={wordWrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'}>{line}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            displayContent
          )}
        </code>
      </pre>
      {/* Collapse/expand for long blocks */}
      {isLong && (
        <button
          onClick={() => setCollapsed(p => !p)}
          className="w-full bg-app-code-bg hover:bg-app-code-bg text-indigo-300/70 hover:text-indigo-300 text-[11px] py-1.5 rounded-b-md border-t border-white/5 transition-colors"
        >
          {collapsed ? `Show all ${lineCount} lines ↓` : 'Show less ↑'}
        </button>
      )}
    </div>
  );
});

// Shared markdown components config (exported for reuse in PlanView)
/**
 * Process React children to highlight @mentions in text nodes.
 */
function highlightMentionsInChildren(children: React.ReactNode): React.ReactNode {
  if (typeof children === 'string') {
    const parts = highlightMentions(children);
    if (parts.length === 1 && typeof parts[0] === 'string') return children;
    return <>{parts}</>;
  }
  if (Array.isArray(children)) {
    return children.map((child, i) => {
      if (typeof child === 'string') {
        const parts = highlightMentions(child);
        if (parts.length === 1 && typeof parts[0] === 'string') return child;
        return <span key={i}>{parts}</span>;
      }
      return child;
    });
  }
  return children;
}

export const markdownComponents = {
  p: ({ children }: any) => (
    <p>{highlightMentionsInChildren(children)}</p>
  ),
  li: ({ children, ...rest }: any) => (
    <li {...rest}>{highlightMentionsInChildren(children)}</li>
  ),
  img: ({ src, alt }: any) => {
    if (!src) return null;
    // Normalize upload paths (handle both /uploads/x.png and topics-app/uploads/x.png)
    let normalizedSrc = src;
    if (src.includes('uploads/') && !src.startsWith('/') && !src.startsWith('http')) {
      normalizedSrc = '/uploads/' + src.split('uploads/').pop();
    }
    // Serve /uploads/ paths directly (screenshots, attachments hosted by Topics server)
    if (normalizedSrc.startsWith('/uploads/')) return <MediaImage path={normalizedSrc} />;
    const isMediaPath = normalizedSrc.startsWith('/Users/') || normalizedSrc.startsWith('/tmp/');
    if (isMediaPath) return <MediaImage path={normalizedSrc} />;
    return <img src={normalizedSrc} alt={alt || ''} className="max-w-full max-h-80 rounded-lg my-1" loading="lazy" />;
  },
  a: ({ href, children }: any) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-600 underline">{children}</a>
  ),
  pre: ({ children }: any) => {
    if (children && typeof children === 'object' && 'props' in children) {
      const codeProps = children.props;
      return <CodeBlock className={codeProps.className}>{codeProps.children}</CodeBlock>;
    }
    return <CodeBlock>{children}</CodeBlock>;
  },
  code: ({ children, className }: any) => {
    const isBlock = className?.includes('language-');
    if (isBlock) return <code className="text-[12.5px]">{children}</code>;
    return <code className="bg-app-hover text-app-text-secondary px-1 py-0.5 rounded text-[12.5px] font-mono">{children}</code>;
  },
  table: ({ children }: any) => (
    <div className="overflow-x-auto my-2">
      <table className="min-w-full border-collapse border border-app-border-light text-sm">{children}</table>
    </div>
  ),
  th: ({ children }: any) => (
    <th className="border border-app-border-light bg-app-hover dark:bg-elevated px-3 py-1.5 text-left font-semibold">{children}</th>
  ),
  td: ({ children }: any) => (
    <td className="border border-app-border-light px-3 py-1.5">{children}</td>
  ),
};

// Component to render diff blocks with "Apply All" button
function DiffBlocksWithApplyAll({ segments }: { segments: MessageSegment[] }) {
  const diffRefs = useRef<Map<number, DiffBlockHandle>>(new Map());
  const [applyAllState, setApplyAllState] = useState<'idle' | 'applying' | 'done'>('idle');
  const [applyProgress, setApplyProgress] = useState({ applied: 0, total: 0, failed: 0 });

  const diffIndices = useMemo(() =>
    segments.map((s, i) => s.type === 'diff' && s.edit ? i : -1).filter(i => i !== -1),
    [segments]
  );

  const handleApplyAll = useCallback(async () => {
    const total = diffIndices.length;
    setApplyAllState('applying');
    setApplyProgress({ applied: 0, total, failed: 0 });

    let applied = 0;
    let failed = 0;

    for (const idx of diffIndices) {
      const handle = diffRefs.current.get(idx);
      if (!handle) continue;
      const state = handle.getState();
      if (state !== 'pending') {
        // Already applied, rejected, or errored - skip
        applied++;
        setApplyProgress({ applied, total, failed });
        continue;
      }
      const success = await handle.apply();
      if (success) {
        applied++;
      } else {
        failed++;
      }
      setApplyProgress({ applied, total, failed });
    }

    setApplyAllState('done');
  }, [diffIndices]);

  const setRef = useCallback((idx: number, handle: DiffBlockHandle | null) => {
    if (handle) {
      diffRefs.current.set(idx, handle);
    } else {
      diffRefs.current.delete(idx);
    }
  }, []);

  return (
    <div>
      {/* Apply All button - only show when there are 2+ diffs */}
      {diffIndices.length >= 2 && (
        <div className="flex items-center gap-2 my-2 py-1.5 px-3 rounded-lg bg-elevated border border-app-border-light">
          {applyAllState === 'idle' && (
            <button
              onClick={handleApplyAll}
              className="flex items-center gap-1.5 px-3 py-1 rounded text-[12px] font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20 transition-colors"
            >
              <CheckCheck size={14} /> Apply All ({diffIndices.length} edits)
            </button>
          )}
          {applyAllState === 'applying' && (
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-[12px] text-app-text-secondary">
                Applying {applyProgress.applied}/{applyProgress.total}...
                {applyProgress.failed > 0 && <span className="text-red-500 ml-1">({applyProgress.failed} failed)</span>}
              </span>
            </div>
          )}
          {applyAllState === 'done' && (
            <div className="flex items-center gap-2">
              <CheckCheck size={14} className="text-emerald-500" />
              <span className="text-[12px] text-emerald-600 dark:text-emerald-400 font-medium">
                {applyProgress.applied} applied
                {applyProgress.failed > 0 && <span className="text-red-500 ml-1">({applyProgress.failed} failed)</span>}
              </span>
            </div>
          )}
        </div>
      )}

      {segments.map((segment, i) =>
        segment.type === 'diff' && segment.edit ? (
          <DiffBlock key={i} ref={(handle) => setRef(i, handle)} edit={segment.edit} />
        ) : (
          <div key={i} className="prose prose-sm max-w-none prose-p:my-0.5 prose-headings:my-1.5 prose-ul:my-0.5 prose-ol:my-0.5 prose-li:my-0 prose-pre:my-1.5 prose-blockquote:my-1">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {segment.content || ''}
            </ReactMarkdown>
          </div>
        )
      )}
    </div>
  );
}

/**
 * Highlight @mentions in text by wrapping them in styled spans.
 * Returns an array of string and JSX elements.
 */
function highlightMentions(text: string): (string | React.JSX.Element)[] {
  // Match @name at start of string or after whitespace (without lookbehind for Safari compat)
  const mentionRegex = /(^|\s)(@[a-zA-Z][a-zA-Z0-9_-]*)/gm;
  const parts: (string | React.JSX.Element)[] = [];
  let lastIdx = 0;
  let match;

  while ((match = mentionRegex.exec(text)) !== null) {
    const prefix = match[1]; // whitespace or empty at start
    const mention = match[2]; // the @name
    const beforeText = text.slice(lastIdx, match.index);
    if (beforeText) parts.push(beforeText);
    if (prefix) parts.push(prefix);
    parts.push(
      <span key={match.index} className="text-primary font-medium">{mention}</span>
    );
    lastIdx = match.index + match[0].length;
  }

  const remaining = text.slice(lastIdx);
  if (remaining) parts.push(remaining);

  return parts.length > 0 ? parts : [text];
}

/** Split content into segments interleaved with inline tool call badges */
function renderContentWithInlineTools(
  cleanText: string,
  toolCalls: ToolCall[],
  markdownComponents: any
): React.ReactNode[] {
  // Separate tool calls with contentOffset (inline) from those without (legacy)
  const inlineTools = toolCalls
    .filter(tc => typeof tc.contentOffset === 'number')
    .sort((a, b) => (a.contentOffset ?? 0) - (b.contentOffset ?? 0));

  if (inlineTools.length === 0) return [];

  // Find nearest paragraph boundary (\n\n) for each offset
  const splitPoints: number[] = [];
  for (const tc of inlineTools) {
    const offset = tc.contentOffset!;
    // Search for nearest \n\n at or after offset
    const afterIdx = cleanText.indexOf('\n\n', offset);
    // Search for nearest \n\n before offset
    const beforeIdx = cleanText.lastIndexOf('\n\n', offset);
    let splitAt: number;
    if (afterIdx === -1 && beforeIdx === -1) {
      splitAt = offset;
    } else if (afterIdx === -1) {
      splitAt = beforeIdx + 2; // after the \n\n
    } else if (beforeIdx === -1) {
      splitAt = afterIdx + 2;
    } else {
      // Pick the closest boundary
      splitAt = (offset - beforeIdx <= afterIdx - offset) ? beforeIdx + 2 : afterIdx + 2;
    }
    // Avoid duplicate split points
    if (splitPoints.length === 0 || splitAt > splitPoints[splitPoints.length - 1]) {
      splitPoints.push(splitAt);
    }
  }

  // Build segments: content → badge → content → badge → ...
  const elements: React.ReactNode[] = [];
  let lastIdx = 0;
  let toolIdx = 0;

  for (let i = 0; i < splitPoints.length; i++) {
    const splitAt = splitPoints[i];
    const segment = cleanText.slice(lastIdx, splitAt).trim();
    if (segment) {
      elements.push(
        <div key={`seg-${i}`} className="prose prose-sm max-w-none prose-p:my-0.5 prose-headings:my-1.5 prose-ul:my-0.5 prose-ol:my-0.5 prose-li:my-0 prose-pre:my-1.5 prose-blockquote:my-1">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {segment}
          </ReactMarkdown>
        </div>
      );
    }
    // Add tool call badges that map to this split point
    // Multiple tool calls might share the same split point
    while (toolIdx < inlineTools.length) {
      const tc = inlineTools[toolIdx];
      const tcOffset = tc.contentOffset!;
      // This tool call belongs at or before this split point
      if (i + 1 >= splitPoints.length || tcOffset < splitPoints[i + 1]) {
        elements.push(<ToolCallBadge key={`tc-${tc.id}`} toolCall={tc} compact />);
        toolIdx++;
      } else {
        break;
      }
    }
    lastIdx = splitAt;
  }

  // Remaining content after last split
  const remaining = cleanText.slice(lastIdx).trim();
  if (remaining) {
    elements.push(
      <div key="seg-last" className="prose prose-sm max-w-none prose-p:my-0.5 prose-headings:my-1.5 prose-ul:my-0.5 prose-ol:my-0.5 prose-li:my-0 prose-pre:my-1.5 prose-blockquote:my-1">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {remaining}
        </ReactMarkdown>
      </div>
    );
  }

  // Any remaining tool calls (shouldn't happen, but safety)
  while (toolIdx < inlineTools.length) {
    elements.push(<ToolCallBadge key={`tc-${inlineTools[toolIdx].id}`} toolCall={inlineTools[toolIdx]} compact />);
    toolIdx++;
  }

  return elements;
}

interface MessageContentProps {
  content: string;
  role: 'user' | 'assistant' | 'system';
  // Enhanced message fields
  thinking?: string;
  toolCalls?: import('../types').ToolCall[];
  media?: string[];
  partial?: boolean;
  // Plan mode
  onPlanApprove?: () => void;
  onPlanReject?: () => void;
  // Session viewer
  onOpenSessionViewer?: (sessionKey: string) => void;
  // WebSocket message subscription (for AgentSpawnCard real-time updates)
  onMessage?: (handler: (msg: any) => void) => () => void;
}

export const MessageContent = memo(function MessageContent({ content, role, thinking, toolCalls, media, partial, onPlanApprove, onPlanReject, onOpenSessionViewer, onMessage }: MessageContentProps) {
  const { cleanText: rawCleanText, mediaPaths: extractedMediaPaths, voicePaths } = useMemo(() => {
    const result = extractMediaPaths(content);
    return result;
  }, [content]);

  // During streaming, close any incomplete markdown tokens to prevent rendering glitches
  const cleanText = useMemo(
    () => (partial && rawCleanText) ? completePartialMarkdown(rawCleanText) : rawCleanText,
    [rawCleanText, partial],
  );
  
  // Combine extracted media paths with explicit media array
  const allMediaPaths = useMemo(() => {
    const paths = [...extractedMediaPaths];
    if (media) {
      for (const p of media) {
        if (!paths.includes(p)) paths.push(p);
      }
    }
    return paths;
  }, [extractedMediaPaths, media]);

  if (role === 'user') {
    const renderUserText = (text: string) => {
      const lines = text.split('\n');
      const blocks: { type: 'quote' | 'text'; content: string }[] = [];
      let currentQuote: string[] = [];
      let currentText: string[] = [];

      const flushQuote = () => { if (currentQuote.length > 0) { blocks.push({ type: 'quote', content: currentQuote.join('\n') }); currentQuote = []; } };
      const flushText = () => { if (currentText.length > 0) { blocks.push({ type: 'text', content: currentText.join('\n') }); currentText = []; } };

      for (const line of lines) {
        if (line.startsWith('> ')) {
          flushText();
          currentQuote.push(line.slice(2));
        } else {
          flushQuote();
          currentText.push(line);
        }
      }
      flushQuote();
      flushText();

      return blocks.map((block, i) => {
        if (block.type === 'quote') {
          return (
            <div key={i} className="border-l-3 border-blue-300 pl-2 mb-1 text-sm opacity-75 italic">
              {block.content}
            </div>
          );
        }
        return <div key={i} className="whitespace-pre-wrap">{highlightMentions(block.content)}</div>;
      });
    };

    return (
      <div data-testid="message-content-user">
        {allMediaPaths.map((path, i) => <div key={i} className="mb-2"><MediaRenderer path={path} isVoice={voicePaths.has(path)} isUserMessage={role === "user"} /></div>)}
        {cleanText && renderUserText(cleanText)}
      </div>
    );
  }

  // Agent spawn card — detect marker format {{AGENT_SPAWN:sessionKey|label}}
  const spawnMatch = content.match(/^\{\{AGENT_SPAWN:(.+?)\|(.+)\}\}$/);
  if (spawnMatch) {
    return <AgentSpawnCard sessionKey={spawnMatch[1]} label={spawnMatch[2]} onOpenInPane={onOpenSessionViewer} onMessage={onMessage} />;
  }

  // Assistant message - render thinking, tool calls, content, and media
  return (
    <div data-testid="message-content-assistant">
      {/* Thinking block - always show if present */}
      {thinking && <ThinkingBlock content={thinking} />}

      {/* Tool calls - split into legacy (no offset) and inline (with offset) */}
      {(() => {
        const legacyTools = toolCalls?.filter(tc => typeof tc.contentOffset !== 'number') ?? [];
        const inlineTools = toolCalls?.filter(tc => typeof tc.contentOffset === 'number') ?? [];
        const hasInline = inlineTools.length > 0;

        return (
          <>
            {/* Legacy tool calls (no contentOffset) shown above content */}
            {legacyTools.length > 0 && <ToolCallsList toolCalls={legacyTools} />}

            {/* Inline typing indicator for empty streaming message */}
            {!cleanText && !thinking && partial && (
              <div className="flex gap-1.5 items-center py-0.5">
                <div className="w-1.5 h-1.5 bg-app-text-muted rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="w-1.5 h-1.5 bg-app-text-muted rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="w-1.5 h-1.5 bg-app-text-muted rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            )}

            {/* Plan view - detect plan-format responses */}
            {cleanText && !partial && isPlanResponse(cleanText) && onPlanApprove && (
              <PlanView
                content={cleanText}
                onApprove={onPlanApprove}
                onReject={onPlanReject || (() => {})}
                isStreaming={partial}
              />
            )}

            {/* Main content - inline tool calls or plain */}
            {cleanText && (!isPlanResponse(cleanText) || !onPlanApprove || partial) && (
              hasDiffBlocks(cleanText) ? (
                <DiffBlocksWithApplyAll segments={parseMessageWithDiffs(cleanText)} />
              ) : hasInline ? (
                <div>{renderContentWithInlineTools(cleanText, inlineTools, markdownComponents)}</div>
              ) : (
                <div className="prose prose-sm max-w-none prose-p:my-0.5 prose-headings:my-1.5 prose-ul:my-0.5 prose-ol:my-0.5 prose-li:my-0 prose-pre:my-1.5 prose-blockquote:my-1">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {cleanText}
                  </ReactMarkdown>
                </div>
              )
            )}
          </>
        );
      })()}

      {/* Media — rendered after content so images appear inline */}
      {allMediaPaths.map((path, i) => <div key={i} className="mb-2"><MediaRenderer path={path} isVoice={voicePaths.has(path)} isUserMessage={false} /></div>)}

      {/* Streaming indicator - only when content has started */}
      {partial && (cleanText || thinking) && <PartialIndicator />}
    </div>
  );
});

export function ImageThumbnail({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [src] = useState(() => URL.createObjectURL(file));

  useEffect(() => {
    return () => { URL.revokeObjectURL(src); };
  }, [src]);

  return (
    <div className="relative inline-block">
      <img src={src} alt={file.name} className="w-16 h-16 object-cover rounded-lg border border-app-border-light" />
      <button onClick={onRemove} className="absolute -top-1.5 -right-1.5 bg-red-500 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs hover:bg-red-600">×</button>
    </div>
  );
}

export function UploadedImagePreview({ path }: { path: string }) {
  const [lightbox, setLightbox] = useState(false);
  const src = getMediaUrl(path);

  if (!isImage(path)) return null;

  return (
    <>
      <img src={src} alt={getFileName(path)} className="max-w-48 max-h-32 rounded-lg cursor-pointer hover:opacity-90 transition-opacity my-1" onClick={() => setLightbox(true)} loading="lazy" />
      {lightbox && <ImageLightbox src={src} alt={getFileName(path)} onClose={() => setLightbox(false)} />}
    </>
  );
}
