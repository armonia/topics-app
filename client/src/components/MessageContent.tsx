// VoiceMessagePlayer v2 - custom player for voice messages
import React, { createContext, useContext, useDeferredValue, useEffect, useMemo, useState, useCallback, useRef, useSyncExternalStore, memo } from 'react';
import { useT } from '../hooks/useT';
import { type Components } from 'react-markdown';
import { ChatMarkdown } from './ChatMarkdown';
import { highlightCode, subscribeHighlighter, highlighterReady } from '../lib/syntaxHighlight';
import { Copy, Check, CheckCheck, Download, Layers, ChevronRight } from 'lucide-react';
import { splitCompactionSummary } from '../lib/compactionSummary';
import { CompactionHoistContext } from './Chat/compactionHoist';
import { getFileIconDef } from '../lib/fileIcons';
import { getMediaUrl } from '../lib/api';
import { basename } from '../lib/path-utils';
import { TurnActivityIndicator } from './MessageParts';
import { ToolCallRow } from './Chat/ToolCallRow';
import { GroupedToolRows } from './Chat/ToolGroupRow';
import { ReasoningRow } from './Chat/ReasoningRow';
import { Spinner } from './Shared/Spinner';
import { SlashCommandChip } from './Chat/SlashCommandChip';
import type { ToolCall } from '../types';
import { LEGACY_ERROR_PREFIX, turnErrorOf } from './Chat/turnError';
import { releaseAudio } from '../lib/releaseAudio';
import { ImageLightbox, ZoomableImage } from './Shared/ImageLightbox';
import { hasDiffBlocks, parseMessageWithDiffs, type MessageSegment } from '../lib/diffParser';
import { DiffBlock, type DiffBlockHandle } from './Chat/DiffBlock';
import { parseSlashInvocation } from '../../../shared/slash-invocation';
import { isAwaitingHuman } from '../../../shared/types';
import { extractMediaPaths, splitBlockMedia } from './messageMedia';

/**
 * Directory of the markdown file currently being previewed. Used by
 * `markdownComponents.img` to resolve relative image srcs (e.g. `./foo.png`,
 * `images/bar.png`, `../sibling/baz.png`) into absolute filesystem paths that
 * the /api/media endpoint can serve. Null in chat-message contexts where
 * markdown has no on-disk "home" — in that case relative srcs fall through
 * to the existing plain-<img> fallback (preserving current behavior).
 */
// eslint-disable-next-line react-refresh/only-export-components -- context is consumed by markdownComponents.img in THIS file (idiomatic Provider+consumer colocation); splitting it out would orphan that coupling for dev-only HMR
export const MarkdownBaseDirContext = createContext<string | null>(null);

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
  return basename(path) || path;
}

function FileIcon({ path, size = 24 }: { path: string; size?: number }) {
  const def = getFileIconDef(getFileName(path));
  const I = def.icon;
  return <I size={size} style={{ color: def.color }} />;
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
  const tr = useT();
  const src = getMediaUrl(path);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [error, setError] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onMeta = () => { if (audio.duration && isFinite(audio.duration)) setDuration(audio.duration); };
    const onTime = () => {
      setCurrentTime(audio.currentTime);
      // Safari sometimes only reports duration after playback starts. Read the
      // current value via the functional updater (not the closed-over `duration`)
      // so this mount-once effect needn't depend on it / rebind listeners.
      if (audio.duration && isFinite(audio.duration)) {
        setDuration(prev => (prev === 0 ? audio.duration : prev));
      }
    };
    const onEnded = () => { setPlaying(false); setCurrentTime(0); };
    const onError = (e: Event) => { console.error('Audio error:', (e.target as HTMLAudioElement)?.error); setError(true); };
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
      // Togliere i listener non basta: un media element con una sorgente
      // caricata resta agganciato al proprio renderer audio, che in WebKit e'
      // un thread vivo nel processo WebContent. Con le chat che si smontano
      // (tetto di residenza), ogni messaggio vocale ascoltato ne lasciava uno.
      // Vedi lib/releaseAudio.ts per la misura che ha portato qui.
      releaseAudio(audio);
    };
  }, []);

  if (error) {
    return (
      <div data-testid="voice-player-error" className="inline-flex items-center gap-2 bg-app-hover dark:bg-elevated rounded-lg p-2 text-sm text-app-text-muted">
        🎙️ Voice message failed to load
      </div>
    );
  }

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) { audio.pause(); setPlaying(false); }
    else { audio.play(); setPlaying(true); }
  };

  /** The one place the position is written, so the pointer and the keyboard
   *  cannot drift apart. Seconds, clamped to the track. */
  const seekTo = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    audio.currentTime = Math.max(0, Math.min(seconds, duration));
    setCurrentTime(audio.currentTime);
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seekTo(pct * duration);
  };

  /* THE BAR WAS A `div` WITH AN `onClick`: no role, no tab stop, no key. To
   * anyone not holding a mouse the position of a voice message was not just
   * hard to change, it was not announced at all -- and the element still looked
   * clickable, so it read as broken rather than absent. `role="slider"` plus
   * these keys is the contract that name implies: five seconds per arrow, the
   * ends on Home/End. */
  const onBarKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!duration) return;
    const step = 5;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); seekTo(currentTime + step); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); seekTo(currentTime - step); }
    else if (e.key === 'Home') { e.preventDefault(); seekTo(0); }
    else if (e.key === 'End') { e.preventDefault(); seekTo(duration); }
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
      {/* The button was an icon and nothing else: `toHaveAccessibleName` had
          nothing to read, and a screen reader announced «button». The name
          follows the STATE, because that is what pressing it will do. */}
      <button
        onClick={toggle}
        aria-label={tr(playing ? 'chat.voice.pause' : 'chat.voice.play')}
        data-testid="voice-player-toggle"
        className={`w-9 h-9 flex-shrink-0 flex items-center justify-center rounded-full transition-colors ${
          // Bolla utente = bg-primary (blu saturo) in ENTRAMBI i temi: qui
          // `bg-white/N` è il rialzo corretto sopra fondo scuro garantito,
          // l'eccezione alla regola in index.css. Fuori dalla bolla si usa il
          // token accent (bg-primary/N) che si adatta al tema.
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
        {/* `tap-expand-y`: the bar is 6px tall and spans the bubble's width, so
            the axis that is missing is the vertical one -- and it has room,
            since nothing else is stacked against it inside the player. */}
        <div
          className="tap-expand-y h-1.5 rounded-full cursor-pointer relative overflow-hidden"
          style={{ backgroundColor: isUserMessage ? 'rgba(255,255,255,0.2)' : 'rgba(var(--primary-rgb, 59,130,246),0.15)' }}
          onClick={seek}
          onKeyDown={onBarKey}
          role="slider"
          tabIndex={0}
          aria-label={tr('chat.voice.progress')}
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(currentTime)}
          aria-valuetext={`${fmt(currentTime)} / ${fmt(duration)}`}
          data-testid="voice-player-progress"
        >
          <div
            className="absolute inset-y-0 left-0 rounded-full transition-all"
            style={{
              width: `${progress}%`,
              backgroundColor: isUserMessage ? 'rgba(255,255,255,0.8)' : 'var(--primary, #3b82f6)',
            }}
          />
        </div>
        <div className={`flex justify-between text-[11px] tabular-nums ${isUserMessage ? 'text-white/60' : 'text-app-text-muted'}`}>
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
    const props = (node as { props?: { children?: React.ReactNode } }).props;
    return getTextContent(props?.children);
  }
  return '';
}

// chat-rendering-parity CHAT-RND-03 — ```mermaid fences render as SVG diagrams.
// The library (~1.3MB) loads lazily on the FIRST mermaid block only. parse()
// runs before render() so invalid syntax (including still-streaming partial
// blocks) degrades to the plain CodeBlock instead of injecting mermaid's own
// error DOM. The 300ms debounce keeps streaming deltas from thrashing the
// renderer; once the block stabilizes the diagram appears.
const MermaidBlock = memo(function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const idRef = useRef(`mermaid-${Math.random().toString(36).slice(2, 10)}`);
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        const dark = document.documentElement.classList.contains('dark');
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
        await mermaid.parse(code);
        const { svg: rendered } = await mermaid.render(idRef.current, code);
        if (!cancelled) setSvg(rendered);
      } catch {
        if (!cancelled) setSvg(null);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [code]);
  if (svg) {
    return (
      // XSS posture: the SVG comes from mermaid.render under
      // securityLevel:'strict' — mermaid sanitizes internally (bundled
      // DOMPurify, escaped labels, scripts/links disabled) and parse() ran
      // first, so raw chat text never reaches this innerHTML.
      <div
        className="mermaid-block my-2 overflow-x-auto rounded-md bg-app-code-bg p-3 [&_svg]:max-w-full [&_svg]:h-auto"
        data-testid="mermaid-diagram"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }
  return <CodeBlock className="language-mermaid">{code}</CodeBlock>;
});

// Code block with copy button, language badge, line numbers, collapsible, word wrap
const CodeBlock = memo(function CodeBlock({ children, className }: { children: React.ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const [collapsed, setCollapsed] = useState(true); // collapsed by default if >20 lines
  const [showLineNumbers, setShowLineNumbers] = useState(false);
  const [wordWrap, setWordWrap] = useState(false);
  const language = className?.replace('language-', '') || '';
  
  const textContent = useMemo(() => getTextContent(children), [children]);
  const lines = useMemo(() => textContent.split('\n'), [textContent]);
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

  // chat-rendering-parity CHAT-RND-01 — syntax colors. Safe innerHTML by
  // construction: hljs ESCAPES the source and only wraps tokens in class-only
  // <span>s. null (unknown lang / oversize / tokenizer error) falls back to
  // the plain text render below. Line-numbers mode stays plain (per-row table).
  // hljs is lazy (first code block kicks off the chunk): hljsReady flips once
  // when the tokenizers land so already-rendered plain blocks re-highlight.
  const hljsReady = useSyncExternalStore(subscribeHighlighter, highlighterReady);
  // Highlighting a growing code block on EVERY streaming delta re-tokenizes the
  // whole block each time (bounded by MAX_HIGHLIGHT_CHARS but still costly on big
  // blocks). Feed hljs a DEFERRED copy of the content: React coalesces the
  // intermediate values under load, so the tokenizer runs a handful of times
  // instead of once per delta. While the deferred input trails the live text we
  // render PLAIN (the `shownHtml` consistency guard below), so the block never
  // shows a stale/truncated highlighted snapshot — it snaps to colour once the
  // stream settles and the deferred value catches up.
  const deferredContent = useDeferredValue(displayContent);
  const highlightedHtml = useMemo(
    () => (showLineNumbers ? null : highlightCode(deferredContent, language)),
    // hljsReady looks unused to the linter but is a deliberate cache-bust: the
    // memo body calls highlightCode, which only produces colours once the async
    // hljs chunk has loaded and flipped this flag — without the dep, blocks
    // rendered before the load would stay plain forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deferredContent, language, showLineNumbers, hljsReady],
  );
  // Only trust the highlighted HTML when it was built from exactly what we're
  // about to render; otherwise fall back to plain current text. (highlightedHtml
  // may itself be null before hljs loads — passing it straight through is fine,
  // the consumer treats a null shownHtml as "render plain".)
  const shownHtml = deferredContent === displayContent ? highlightedHtml : null;

  return (
    <div className="code-block-wrapper">
      {/* Header with language + controls */}
      <div className="flex items-center justify-between bg-app-code-bg rounded-t-md px-2.5 py-1 border-b border-white/5">
        <div className="flex items-center gap-2">
          {language && <span className="text-[11px] uppercase tracking-wider text-indigo-300/70 font-medium">{language}</span>}
          <span className="text-[11px] text-gray-400">{lineCount} lines</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowLineNumbers(p => !p)}
            className={`text-[11px] px-1.5 py-0.5 rounded transition-colors inline-flex items-center justify-center min-w-6 min-h-6 ${showLineNumbers ? 'bg-indigo-500/20 text-indigo-300' : 'text-gray-400 hover:text-gray-200'}`}
            title="Toggle line numbers"
          >
            #
          </button>
          <button
            onClick={() => setWordWrap(p => !p)}
            className={`text-[11px] px-1.5 py-0.5 rounded transition-colors inline-flex items-center justify-center min-w-6 min-h-6 ${wordWrap ? 'bg-indigo-500/20 text-indigo-300' : 'text-gray-400 hover:text-gray-200'}`}
            title="Toggle word wrap"
          >
            ↩
          </button>
          <button
            onClick={handleCopy}
            className="text-gray-400 hover:text-gray-200 rounded px-1.5 py-0.5 text-[11px] flex items-center justify-center gap-1 min-h-6 transition-colors"
          >
            {copied ? <><Check size={10} /> Copied</> : <><Copy size={10} /> Copy</>}
          </button>
        </div>
      </div>
      {/* `tabIndex` quando il blocco scorre in orizzontale: una regione che
          scorre e non è raggiungibile da tastiera è una riga di codice che con
          la sola tastiera non si può leggere fino in fondo (axe:
          scrollable-region-focusable). Prima non si vedeva perché senza tetto
          di larghezza il codice quasi non traboccava mai; con la colonna capata
          trabocca spesso, ed è lo stesso difetto di prima, solo visibile. */}
      <pre
        {...(wordWrap ? {} : { tabIndex: 0 })}
        className={`bg-app-code-bg text-gray-100 ${isLong && collapsed ? '' : 'rounded-b-md'} p-2.5 text-[12.5px] leading-[1.5] ${wordWrap ? 'whitespace-pre-wrap break-words' : 'overflow-x-auto'}`}
        style={{ margin: 0 }}
      >
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
          ) : shownHtml ? (
            <span dangerouslySetInnerHTML={{ __html: shownHtml }} />
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

// Shared markdown components config (exported for reuse in the editor panes)
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

// eslint-disable-next-line react-refresh/only-export-components -- a react-markdown Components map of inline renderers tightly coupled to this file's helpers (highlightMentionsInChildren, MarkdownBaseDirContext, getMediaUrl); not a standalone constant — extracting it is a large, risky refactor for dev-only HMR
export const markdownComponents: Components = {
  p: ({ children }) => (
    <p>{highlightMentionsInChildren(children)}</p>
  ),
  li: ({ children, node: _node, ...rest }) => (
    <li {...rest}>{highlightMentionsInChildren(children)}</li>
  ),
  img: ({ src, alt }) => {
    // react-markdown invokes this override as a real component, so useContext
    // is valid here; the rule misfires only because the key is lowercase `img`.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const baseDir = useContext(MarkdownBaseDirContext);
    if (!src || typeof src !== 'string') return null;

    // Pass-through for data/blob/http(s) — no rewriting, no MediaImage.
    if (/^(data|blob|https?):/i.test(src)) {
      return <img src={src} alt={alt || ''} className="max-w-full max-h-80 rounded-lg my-1" loading="lazy" />;
    }

    // Normalize upload paths (handle both /uploads/x.png and topics-app/uploads/x.png)
    let normalizedSrc = src;
    if (src.includes('uploads/') && !src.startsWith('/') && !src.startsWith('http')) {
      normalizedSrc = '/uploads/' + src.split('uploads/').pop();
    }

    // Resolve relative srcs against the active markdown file's directory (MD preview).
    // `baseDir` is null in chat-message contexts, preserving today's behavior there.
    if (baseDir && !normalizedSrc.startsWith('/')) {
      try {
        normalizedSrc = new URL(normalizedSrc, 'file://' + baseDir + '/').pathname;
      } catch {
        // Leave normalizedSrc unchanged on malformed URL input.
      }
    }

    // Serve /uploads/ paths directly (screenshots, attachments hosted by Topics server)
    if (normalizedSrc.startsWith('/uploads/')) return <MediaImage path={normalizedSrc} />;
    const isMediaPath = normalizedSrc.startsWith('/Users/') || normalizedSrc.startsWith('/tmp/');
    if (isMediaPath) return <MediaImage path={normalizedSrc} />;
    return <img src={normalizedSrc} alt={alt || ''} className="max-w-full max-h-80 rounded-lg my-1" loading="lazy" />;
  },
  // `a` NON è qui: il renderer dei link è il default di ChatMarkdown, che ogni
  // superficie markdown eredita (i commenti della board e i piani non avevano
  // link cliccabili proprio perché la regola viveva solo in questo file).
  pre: ({ children }) => {
    if (children && typeof children === 'object' && 'props' in children) {
      const codeProps = (children as { props: { className?: string; children?: React.ReactNode } }).props;
      // ```mermaid → diagram (CHAT-RND-03); everything else stays a CodeBlock.
      if (codeProps.className?.includes('language-mermaid')) {
        return <MermaidBlock code={getTextContent(codeProps.children).replace(/\n$/, '')} />;
      }
      return <CodeBlock className={codeProps.className}>{codeProps.children}</CodeBlock>;
    }
    return <CodeBlock>{children}</CodeBlock>;
  },
  code: ({ children, className }) => {
    const isBlock = className?.includes('language-');
    if (isBlock) return <code className="text-[12.5px]">{children}</code>;
    return <code className="bg-app-hover text-app-text-secondary px-1 py-0.5 rounded text-[12.5px] font-mono">{children}</code>;
  },
  table: ({ children }) => (
    <div className="overflow-x-auto my-2">
      <table className="min-w-full border-collapse border border-app-border-light text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-app-border-light bg-app-hover dark:bg-elevated px-3 py-1.5 text-left font-semibold">{children}</th>
  ),
  td: ({ children }) => (
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
            <div className="flex items-center gap-2 text-emerald-500">
              {/* `current`: il verde lo porta la riga, l'anello lo eredita —
                  l'ultima copia a mano del cerchietto è finita qui. */}
              <Spinner size="sm" tone="current" />
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
            <ChatMarkdown components={markdownComponents}>
              {segment.content || ''}
            </ChatMarkdown>
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

/** Split content into segments interleaved with inline tool call rows */
function renderContentWithInlineTools(
  cleanText: string,
  toolCalls: ToolCall[],
  markdownComponents: Components,
  sessionKey?: string,
  /**
   * Serve a `ToolCallRow` per chiedere il DETTAGLIO del tool a richiesta:
   * `GET /api/messages/:messageId/tool/:toolCallId/detail`. Da quando il testo
   * dei tool non viaggia piu' nel payload di apertura (-52%), senza questo la
   * riga non ha come andarselo a prendere e il dettaglio resta vuoto.
   */
  messageId?: string
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
          <ChatMarkdown components={markdownComponents}>
            {segment}
          </ChatMarkdown>
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
        elements.push(<ToolCallRow key={`tc-${tc.id}`} toolCall={tc} sessionKey={sessionKey} messageId={messageId} />);
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
        <ChatMarkdown components={markdownComponents}>
          {remaining}
        </ChatMarkdown>
      </div>
    );
  }

  // Any remaining tool calls (shouldn't happen, but safety)
  while (toolIdx < inlineTools.length) {
    elements.push(<ToolCallRow key={`tc-${inlineTools[toolIdx].id}`} toolCall={inlineTools[toolIdx]} sessionKey={sessionKey} messageId={messageId} />);
    toolIdx++;
  }

  return elements;
}

/** Fold for the CLI's auto-compaction summary — collapsed by default so a
 *  ~24 KB context recap doesn't dominate the transcript; expandable on demand.
 *  Echoes the CompactionDivider ("Contesto compattato") styling. */
type MarkdownComponents = React.ComponentProps<typeof ChatMarkdown>['components'];

function CompactionSummaryFold({ summary, components }: { summary: string; components: MarkdownComponents }) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const approxK = Math.max(1, Math.round(summary.length / 4 / 1000));
  return (
    <div className="my-2 not-prose" data-testid="compaction-summary-fold">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-full border border-app-border/60 bg-app-hover/40 px-2.5 py-0.5 text-[11px] text-app-text-muted hover:bg-app-hover transition-colors"
      >
        <Layers size={12} className="flex-shrink-0" />
        <span className="font-medium">{tr('compaction.summaryTitle')}</span>
        <span className="text-app-text-muted/70">· ~{approxK}k token</span>
        <ChevronRight size={12} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="mt-1.5 prose prose-sm max-w-none opacity-70 prose-p:my-0.5 prose-headings:my-1.5 prose-ul:my-0.5 prose-ol:my-0.5 prose-li:my-0 prose-pre:my-1.5">
          <ChatMarkdown components={components}>{summary}</ChatMarkdown>
        </div>
      )}
    </div>
  );
}

/** Assistant prose that folds away a trailing auto-compaction summary
 *  (interface-level handling — the CLI's recap otherwise leaks in as a wall of
 *  text). Drop-in for `<ChatMarkdown components={…}>{text}</ChatMarkdown>`. */
function ProseBlock({ text, components }: { text: string; components: MarkdownComponents }) {
  const { before, summary } = splitCompactionSummary(text);
  // The divider right above this message already hoisted the recap into its own
  // expander — rendering the fold too would announce the same boundary twice.
  const hoisted = useContext(CompactionHoistContext);
  return (
    <>
      {before ? <ChatMarkdown components={components}>{before}</ChatMarkdown> : null}
      {summary && !hoisted ? <CompactionSummaryFold summary={summary} components={components} /> : null}
    </>
  );
}

interface MessageContentProps {
  content: string;
  role: 'user' | 'assistant' | 'system';
  // Enhanced message fields
  thinking?: string;
  toolCalls?: import('../types').ToolCall[];
  /**
   * Chronological timeline. When present and non-empty, takes precedence
   * over the legacy thinking/toolCalls/content bucket rendering — restoring
   * the actual order in which the model produced each piece of content.
   */
  blocks?: import('../types').ContentBlock[];
  media?: string[];
  partial?: boolean;
  /** Whether this is the last row in the transcript. The live turn indicator is
   *  gated on it so a stale/ghost partial can't render a second indicator. */
  isLast?: boolean;
  /**
   * Turn start (ms epoch), from the streaming message's `timestamp`. Anchors
   * the live turn timer inside <TurnActivityIndicator>. Only read while
   * `partial`; undefined/NaN degrades gracefully (elapsed from mount).
   */
  turnStartedAt?: number;
  // Consumo del turno — serve alla striscia VIVA (TurnActivityIndicator). La
  // striscia di chiusura è salita in <MessageBubble>, che legge `msg` da sé:
  // per questo `latencyMs` e `model` non passano più di qui.
  usagePromptTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  cacheCreation1hTokens?: number | null;
  usageCompletionTokens?: number | null;
  costCents?: number | null;
  /** La decisione presa su un piano proposto — vedi <ToolCallRow>. */
  onPlanDecision?: (approved: boolean) => void;
  // Session viewer
  /**
   * The session key this message belongs to. Threaded down to
   * `<ToolCallRow>` so the inline `ToolInputForm` (rendered when a tool
   * pauses on AskUserQuestion / MCP elicitation) can POST the answer
   * via `chatApi.toolResponse(sessionKey, ...)`. Without it the form
   * downgrades to a read-only "reload to answer" hint.
   */
  sessionKey?: string;
  /**
   * The DB id of this message. Threaded down to `<ToolCallRow>` so that
   * rows with stripped detail (`toolCall.detailBytes > 0`) can fetch the
   * full text lazily on first open via
   * `GET /api/messages/:messageId/tool/:toolCallId/detail`. Absent for
   * streaming messages (they never have stripped detail).
   */
  messageId?: string;
  // WebSocket message subscription
  onMessage?: (handler: (msg: import('../types').WSMessage) => void) => () => void;
}

/** Una tratta della timeline di un messaggio assistant: testo, ragionamento, o
 *  una corsa di tool call consecutive resa come un'unica lista verticale. */
type BlockGroup =
  | { kind: 'thinking'; idx: number; text: string }
  | { kind: 'text'; idx: number; text: string }
  | { kind: 'media'; idx: number; path: string; seq: number }
  | { kind: 'tools'; startIdx: number; tools: ToolCall[] };

/**
 * Il verdetto sul turno, come elemento SUO.
 *
 * Prima era il contenitore di tutta la bolla a diventare giallo — e con lui la
 * prosa, la cronologia dei tool, i media. Un turno riuscito che inciampa alla
 * fine veniva incorniciato per intero come se fosse tutto sbagliato, e il testo
 * che spiegava il perché non si vedeva nemmeno. Qui la riga d'errore sta in
 * cima e basta: quello che il turno ha prodotto le sta sotto, reso come sempre.
 */
function TurnErrorBanner({ text }: { text: string }) {
  return (
    <div
      data-testid="turn-error"
      className="mb-1.5 flex items-start gap-1.5 rounded-lg border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 px-2.5 py-1.5 text-[12px] leading-snug text-amber-900 dark:text-amber-200"
    >
      <span aria-hidden className="flex-shrink-0 leading-snug">⚠️</span>
      <span className="min-w-0 break-words">{text}</span>
    </div>
  );
}

/**
 * DA DOVE VIENE QUESTA RISPOSTA.
 *
 * Un `Monitor` armato consegna il suo evento risvegliando la sessione: la
 * risposta compare in chat minuti dopo, sotto un messaggio che non c'entra e
 * senza che nessuno l'abbia chiesta. Senza un cartello è indistinguibile da una
 * risposta qualunque — osservato il 20/08: «Risveglio arrivato: …» apparso da
 * solo, con l'utente che ha dovuto domandare cosa fosse.
 *
 * Gemello di `TurnErrorBanner`: stessa forma, stesso posto (in cima alla bolla,
 * non nella cronologia), colore diverso. Blu e non ambra perché non è un
 * problema: è una consegna, ed è la cosa che si stava aspettando.
 */
function WokenBanner({ label }: { label?: string }) {
  const tr = useT();
  return (
    <div
      data-testid="woken-banner"
      className="mb-1.5 flex items-start gap-1.5 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/25 px-2.5 py-1.5 text-[12px] leading-snug text-blue-900 dark:text-blue-200"
    >
      <span aria-hidden className="flex-shrink-0 leading-snug">🔔</span>
      <span className="min-w-0 break-words">
        {label ? tr('woken.arrivedFor', { what: label }) : tr('woken.arrived')}
      </span>
    </div>
  );
}

/**
 * QUESTA RISPOSTA È UNA RIPRESA, e chi legge deve saperlo.
 *
 * Il server ha ucciso il turno precedente riavviandosi, e l'ha rimandato da sé
 * (`lib/ripresa-boot.ts`). Senza questo cartello sembrerebbe che l'agente abbia
 * risposto due volte alla stessa domanda — e chi legge cercherebbe la
 * differenza fra le due invece di leggere quella buona.
 *
 * Gemello di `WokenBanner`, stesso posto e stessa forma. Blu come lui: non è un
 * problema, è un recupero già avvenuto.
 */
function RipresoBanner() {
  const tr = useT();
  return (
    <div
      data-testid="ripreso-banner"
      className="mb-1.5 flex items-start gap-1.5 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/25 px-2.5 py-1.5 text-[12px] leading-snug text-blue-900 dark:text-blue-200"
    >
      <span aria-hidden className="flex-shrink-0 leading-snug">↻</span>
      <span className="min-w-0 break-words">{tr('ripreso.banner')}</span>
    </div>
  );
}

export const MessageContent = memo(function MessageContent({ content, role, thinking, toolCalls, blocks, media, partial, isLast, turnStartedAt, usagePromptTokens, usageCompletionTokens, costCents, cacheReadTokens, cacheCreationTokens, cacheCreation1hTokens, onPlanDecision, sessionKey, messageId, onMessage }: MessageContentProps) {
  const { cleanText: rawCleanText, mediaPaths: extractedMediaPaths, voicePaths } = useMemo(() => {
    const result = extractMediaPaths(content);
    return result;
  }, [content]);

  // Il verdetto e il testo, separati una volta sola. `turnError` sale in cima
  // alla bolla; `cleanText` non deve ristamparlo come se fosse prosa. Solo per
  // l'assistente: un messaggio dell'utente che comincia con ⚠️ è testo suo.
  // Il testo passa da `rawCleanText`, non da `content`: i marcatori dei media
  // (`MEDIA:/percorso/…`) sono già stati estratti là, e prenderli da `content`
  // li stampava in chiaro dentro il banner.
  const turnError = useMemo(
    () => (role === 'assistant' ? turnErrorOf({ content: rawCleanText, blocks }) : null),
    [role, rawCleanText, blocks],
  );
  const isLegacyErrorOnlyText = turnError !== null && rawCleanText.trim().startsWith(LEGACY_ERROR_PREFIX);
  // Il cartello del risveglio: c'è solo se questo turno è nato da un Monitor.
  const ripreso = useMemo(() => blocks?.some((b) => b.kind === 'ripreso') ?? false, [blocks]);
  const woken = useMemo(
    () => blocks?.find((b) => b.kind === 'woken') as { kind: 'woken'; label?: string } | undefined,
    [blocks],
  );

  // During streaming, close any incomplete markdown tokens to prevent rendering glitches
  const streamSafeText = useMemo(
    () => (partial && rawCleanText) ? completePartialMarkdown(rawCleanText) : rawCleanText,
    [rawCleanText, partial],
  );
  // Sulle righe vecchie il cartello sta DENTRO il contenuto: è salito nel
  // banner, e qui va tolto — altrimenti si legge due volte. Si toglie solo il
  // primo capoverso, non tutto: una riadozione appende alla stessa colonna il
  // contenuto rifuso, e buttarlo via cancellerebbe il turno per far posto alla
  // sua etichetta.
  const cleanText = useMemo(() => {
    if (!isLegacyErrorOnlyText) return streamSafeText;
    const resto = streamSafeText.trim().slice(LEGACY_ERROR_PREFIX.length);
    const sep = resto.search(/\n\s*\n/);
    return sep === -1 ? '' : resto.slice(sep).trim();
  }, [isLegacyErrorOnlyText, streamSafeText]);
  
  // Combine extracted media paths with explicit media array


  // Il messaggio è un comando? Vale solo per il ramo `user`; memoizzato qui
  // perché gli hook non possono stare dopo un `return` condizionale.
  const slashInvocation = useMemo(
    () => (role === 'user' ? parseSlashInvocation(cleanText) : null),
    [role, cleanText],
  );

  // Il turno è fermo su una domanda a schermo? Guarda entrambe le sorgenti: la
  // timeline `blocks` (percorso attuale) e il vecchio secchio `toolCalls`, così
  // l'indicatore dice la verità in tutti e due i rami di render.
  const awaitingInput = useMemo(() => {
    const inBlocks = (blocks ?? []).some(
      (b) => b.kind === 'tool' && isAwaitingHuman(b.toolCall.status),
    );
    return inBlocks || (toolCalls ?? []).some((tc) => isAwaitingHuman(tc.status));
  }, [blocks, toolCalls]);

  // Raggruppamento della timeline dei blocchi, calcolato UNA volta per `blocks`.
  //
  // Stava dentro il ramo di render, quindi si rifaceva a ogni render — e con
  // esso `g.tools.map((b) => b.toolCall)`, che restituiva un array NUOVO. Quello
  // è l'array che `GroupedToolRows` e `ToolGroupRow` passano ai loro `useMemo`
  // (`partitionToolGroup`, `summarizeToolGroup`): con un riferimento nuovo a ogni
  // giro quei memo non hanno mai fatto centro, e ogni riga di tool attiva si
  // ri-renderizzava a ogni token dello streaming.
  //
  // Qui in cima perché un hook non può stare dopo un `return` condizionale.
  // Ritorna un array vuoto quando non c'è la timeline: il ramo legacy sotto non
  // lo guarda.
  const { groups: blockGroups, mediaFromBlocks } = useMemo(() => {
    const out: BlockGroup[] = [];
    const found: string[] = [];
    if (!blocks) return { groups: out, mediaFromBlocks: found };
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      // Il blocco `error` non è una tratta della cronologia: è il verdetto, e
      // si rende in cima. Qui si salta.
      if (b.kind === 'error') continue;
      // Nemmeno `woken`: dice DA DOVE viene la risposta, non cosa è successo
      // dentro il turno. Si rende come intestazione della bolla, sopra.
      if (b.kind === 'woken') continue;
      // Nemmeno `ripreso`: dice da dove viene il turno, non cosa è successo
      // dentro. Si rende in cima, come gli altri due cartelli.
      if (b.kind === 'ripreso') continue;
      // Nor the two blocks of the goal loop: they say WHY this row exists, not
      // what happened inside the turn, and the one that draws them is
      // `MessageBubble` (one compact system line instead of a bubble).
      if (b.kind === 'goal-nudge' || b.kind === 'goal-stop') continue;
      if (b.kind === 'tool') {
        const last = out[out.length - 1];
        if (last && last.kind === 'tools') last.tools.push(b.toolCall);
        else out.push({ kind: 'tools', startIdx: i, tools: [b.toolCall] });
      } else if (b.kind === 'thinking') {
        out.push({ kind: 'thinking', idx: i, text: b.text });
      } else {
        // Split HERE and not at the source: this is the last point before the
        // text reaches the screen, and it is the one the markers were slipping
        // through. Each part becomes its own group, so an image drawn in the
        // middle of the prose stays in the middle (see `splitBlockMedia`).
        let seq = 0;
        for (const part of splitBlockMedia(b.text)) {
          if (part.kind === 'text') out.push({ kind: 'text', idx: i, text: part.text });
          else { out.push({ kind: 'media', idx: i, path: part.path, seq: seq++ }); found.push(part.path); }
        }
      }
    }
    return { groups: out, mediaFromBlocks: found };
  }, [blocks]);

  // AFTER the groups, because it subtracts from them: `mediaFromBlocks` is
  // declared by that memo and a `const` cannot be read above its own line.
  const allMediaPaths = useMemo(() => {
    // MINUS what the blocks already drew IN PLACE. `content` and `blocks` are
    // two stores of the same turn and they carry the same markers, so without
    // this every inline image would be painted a second time down here. What
    // stays is the legacy path: a message with no timeline, where `content` is
    // all there is.
    const paths = extractedMediaPaths.filter((p) => !mediaFromBlocks.includes(p));
    if (media) {
      for (const p of media) {
        if (!paths.includes(p)) paths.push(p);
      }
    }
    return paths;
  }, [extractedMediaPaths, mediaFromBlocks, media]);

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
            // Bordo NEUTRO: era `border-blue-300`, cioè un azzurro scelto per
            // stare su una bolla blu. Su un grigio di sistema quello stesso
            // azzurro diventa una barra colorata a caso — la stessa ragione per
            // cui la selezione in quest'app non si colora.
            <div key={i} className="border-l-3 border-app-border-light pl-2 mb-1 text-sm opacity-75 italic">
              {block.content}
            </div>
          );
        }
        return <div key={i} className="whitespace-pre-wrap">{highlightMentions(block.content)}</div>;
      });
    };

    return (
      <div data-testid="message-content-user">
        {allMediaPaths.map((path, i) => <div key={i} className="mb-2"><MediaRenderer path={path} isVoice={voicePaths.has(path)} isUserMessage /></div>)}
        {/* Un messaggio che È un comando si legge come un comando.
            Quando lanci `/recap`, Topics lo manda verbatim e la CLI lo espande
            PRIMA del turno: sul filo non torna nessun tool e nessun testo
            iniettato — verificato. L'unico che sa cosa hai lanciato è questo
            messaggio, e finché il corpo del comando colava nella risposta il
            segnale c'era per sbaglio. Qui è al suo posto, e non inventa una
            chiamata a un tool che non c'è stata. */}
        {cleanText && slashInvocation ? (
          <SlashCommandChip command={slashInvocation.command} args={slashInvocation.args} />
        ) : (
          cleanText && renderUserText(cleanText)
        )}
      </div>
    );
  }

  // Assistant message — render either the chronological blocks timeline
  // (preferred when present) OR the legacy bucket layout (thinking → tools
  // → text). The blocks path preserves the actual order the model produced
  // each piece of content so reasoning that happens *between* tool calls
  // appears where it occurred, not lifted to the top.
  if (blocks && blocks.length > 0) {
    // Group consecutive tool blocks so we can render them as a single
    // vertical timeline (connected by a left border line) instead of N
    // unrelated rows. Visually lighter, easier to scan.
    return (
      <div data-testid="message-content-assistant">
        {ripreso && <RipresoBanner />}
        {woken && <WokenBanner label={woken.label} />}
        {turnError && <TurnErrorBanner text={turnError} />}
        {blockGroups.map((g) => {
          if (g.kind === 'thinking') {
            return (
              <ReasoningRow
                key={`g-th-${g.idx}`}
                content={g.text}
                partial={partial && g.idx === blocks.length - 1}
              />
            );
          }
          if (g.kind === 'media') {
            // Drawn IN PLACE, in the middle of the timeline. What the server
            // appended sits at the end of the last block, so it still comes out
            // at the end: same rule, no special case.
            return (
              <div key={`g-md-${g.idx}-${g.seq}`} className="mb-2">
                <MediaRenderer path={g.path} isVoice={voicePaths.has(g.path)} isUserMessage={false} />
              </div>
            );
          }
          if (g.kind === 'tools') {
            // Consecutive runs of ≥3 aggregatable calls collapse into a
            // single summary row with per-tool counts (CHAT-TOOL-02);
            // waiting_for_input / sub-agent rows stay standalone, short
            // runs keep the classic per-call rows.
            return (
              <div
                key={`g-tools-${g.startIdx}`}
                // Niente margine attorno alla corsa: la riga ha gia' il suo
                // `py-1`, e i due sommati facevano 16px di aria attorno a una
                // riga di testo alta 20 — misurato, il riquadro del gruppo era
                // 36px per 20px di contenuto. Lo stacco dalla prosa lo da' gia'
                // il margine del messaggio.
                className="space-y-px"
              >
                <GroupedToolRows tools={g.tools} sessionKey={sessionKey} messageId={messageId} onPlanDecision={onPlanDecision} />
              </div>
            );
          }
          // text block — close partial markdown tokens while streaming the
          // last block so half-emitted ``` or ** don't break rendering.
          const isLastBlock = g.idx === blocks.length - 1;
          const text = (partial && isLastBlock) ? completePartialMarkdown(g.text) : g.text;
          if (!text) return null;
          if (hasDiffBlocks(text)) {
            return <DiffBlocksWithApplyAll key={`g-tx-${g.idx}`} segments={parseMessageWithDiffs(text)} />;
          }
          return (
            <div key={`g-tx-${g.idx}`} className="prose prose-sm max-w-none prose-p:my-0.5 prose-headings:my-1.5 prose-ul:my-0.5 prose-ol:my-0.5 prose-li:my-0 prose-pre:my-1.5 prose-blockquote:my-1">
              <ProseBlock text={text} components={markdownComponents} />
            </div>
          );
        })}

        {/* Media — rendered after content blocks */}
        {allMediaPaths.map((path, i) => (
          <div key={`m-${i}`} className="mb-2">
            <MediaRenderer path={path} isVoice={voicePaths.has(path)} isUserMessage={false} />
          </div>
        ))}

        {partial && isLast !== false && <TurnActivityIndicator since={turnStartedAt} sessionKey={sessionKey} onMessage={onMessage} awaitingInput={awaitingInput}
          promptTokens={usagePromptTokens} completionTokens={usageCompletionTokens} costCents={costCents}
          cacheReadTokens={cacheReadTokens} cacheCreationTokens={cacheCreationTokens} cacheCreation1hTokens={cacheCreation1hTokens} />}

        {/* La striscia di chiusura non sta più qui. A messaggio finito vive
            nella riga che <MessageBubble> apre sotto la bolla, insieme all'ora
            e rivelata dal passaggio del mouse: erano DUE righe impilate — una
            fissa coi numeri, che su pane strette andava pure a capo, e una
            sotto per la sola ora. */}
      </div>
    );
  }

  // Legacy fallback — render reasoning row + tool rows + prose + footer.
  // The pre-content rows (reasoning + legacy tool calls) form a single
  // vertical list of inline rows (no boxed cards) so the assistant message
  // reads top-to-bottom as: what I was thinking → what I did → what I'm
  // saying → meta. Inline tool calls (with contentOffset) still interleave
  // inside the prose via renderContentWithInlineTools.
  return (
    <div data-testid="message-content-assistant">
      {turnError && <TurnErrorBanner text={turnError} />}
      {(() => {
        // When there's no prose, the inline-tools-with-contentOffset path
        // would render NOTHING (it only fires inside `cleanText && ...`),
        // making tool-only assistant messages invisible. Promote inline
        // tools to legacy pre-content rows in that case so they still
        // display while we wait for the migration to fully populate
        // `blocks` on every row.
        const noProse = !cleanText || cleanText.trim().length === 0;
        const allTools = toolCalls ?? [];
        const legacyTools = noProse
          ? allTools
          : allTools.filter(tc => typeof tc.contentOffset !== 'number');
        const inlineTools = noProse
          ? []
          : allTools.filter(tc => typeof tc.contentOffset === 'number');
        const hasInline = inlineTools.length > 0;
        const hasPreContentRows = !!thinking || legacyTools.length > 0;

        return (
          <>
            {hasPreContentRows && (
              // Il margine sotto serve a STACCARE le righe dalla prosa che
              // segue. Quando prosa non ce n'è — un turno che ha solo agito, che
              // è la forma di gran lunga più comune — quei 6px sono vuoto
              // aggiunto sotto ogni riga di azione, e basta.
              <div className={`space-y-0 ${cleanText ? 'mb-1.5' : ''}`}>
                {thinking && <ReasoningRow content={thinking} partial={partial} />}
                <GroupedToolRows tools={legacyTools} sessionKey={sessionKey} messageId={messageId} onPlanDecision={onPlanDecision} />
              </div>
            )}

            {/* Main content - inline tool calls or plain */}
            {/* Il piano NON ha più una vista sua qui. Quando un turno propone e
                aspetta, la decisione sta in due posti che dicono la stessa cosa:
                il pannello sulla riga del tool e la barra sopra il composer
                (`PlanApprovalBar`). Una terza superficie — che si accendeva a
                fiuto su qualunque prosa con «## Plan» e due passi numerati, e
                approvando NON alzava l'autonomia — rimandava il turno nella
                stessa plan mode da cui non poteva uscire. Vedi
                `shared/plan-decision.ts`. */}
            {cleanText && (
              hasDiffBlocks(cleanText) ? (
                <DiffBlocksWithApplyAll segments={parseMessageWithDiffs(cleanText)} />
              ) : hasInline ? (
                <div>{renderContentWithInlineTools(cleanText, inlineTools, markdownComponents, sessionKey, messageId)}</div>
              ) : (
                <div className="prose prose-sm max-w-none prose-p:my-0.5 prose-headings:my-1.5 prose-ul:my-0.5 prose-ol:my-0.5 prose-li:my-0 prose-pre:my-1.5 prose-blockquote:my-1">
                  <ProseBlock text={cleanText} components={markdownComponents} />
                </div>
              )
            )}
          </>
        );
      })()}

      {/* Media — rendered after content so images appear inline */}
      {allMediaPaths.map((path, i) => <div key={i} className="mb-2"><MediaRenderer path={path} isVoice={voicePaths.has(path)} isUserMessage={false} /></div>)}

      {/* Live turn-activity indicator (playful phrase + timer) — covers empty
          placeholder and mid-stream alike. */}
      {partial && isLast !== false && <TurnActivityIndicator since={turnStartedAt} sessionKey={sessionKey} onMessage={onMessage} awaitingInput={awaitingInput}
          promptTokens={usagePromptTokens} completionTokens={usageCompletionTokens} costCents={costCents}
          cacheReadTokens={cacheReadTokens} cacheCreationTokens={cacheCreationTokens} cacheCreation1hTokens={cacheCreation1hTokens} />}

      {/* Vedi sopra: la striscia di chiusura è salita in <MessageBubble>, sulla
          riga dell'ora. */}
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
      <ZoomableImage src={src} alt={file.name} className="w-16 h-16 object-cover rounded-lg border border-app-border-light" />
      <button type="button" onClick={onRemove} className="absolute -top-1.5 -right-1.5 bg-red-500 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs hover:bg-red-600">×</button>
    </div>
  );
}
