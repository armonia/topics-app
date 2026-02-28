import { useEffect, useMemo, useState, useCallback, useRef, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, Check, CheckCheck, Download } from 'lucide-react';
import { getFileIconDef } from '../lib/fileIcons';
import { getMediaUrl } from '../lib/api';
import { ThinkingBlock, ToolCallsList, PartialIndicator } from './MessageParts';
import { hasDiffBlocks, parseMessageWithDiffs, type MessageSegment } from '../lib/diffParser';
import { DiffBlock, type DiffBlockHandle } from './Chat/DiffBlock';
import { isPlanResponse, PlanView } from './Chat/PlanView';

/**
 * Close any open/incomplete markdown tokens so ReactMarkdown doesn't flicker
 * during streaming. Only called when partial === true.
 */
function completePartialMarkdown(text: string): string {
  // 1. Close open fenced code blocks (``` or ~~~)
  const fenceRegex = /^(`{3,}|~{3,})/gm;
  let fenceCount = 0;
  let m: RegExpExecArray | null;
  while ((m = fenceRegex.exec(text)) !== null) fenceCount++;
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

function extractMediaPaths(text: string): { cleanText: string; mediaPaths: string[] } {
  const mediaPaths: string[] = [];
  const mediaPattern = /MEDIA:([^\s\n]+)/g;
  let match;
  while ((match = mediaPattern.exec(text)) !== null) mediaPaths.push(match[1]);

  const attachedPattern = /\[Attached file:\s*([^\]]+)\]/g;
  while ((match = attachedPattern.exec(text)) !== null) mediaPaths.push(match[1].trim());

  const voicePattern = /\[Voice message:\s*([^\]]+)\]/g;
  while ((match = voicePattern.exec(text)) !== null) mediaPaths.push(match[1].trim());

  const cleanText = text
    .replace(/MEDIA:([^\s\n]+)/g, '')
    .replace(/\[Attached file:\s*[^\]]+\]/g, '')
    .replace(/\[Voice message:\s*[^\]]+\]/g, '')
    .trim();

  return { cleanText, mediaPaths };
}

function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4 cursor-pointer" onClick={onClose}>
      <img src={src} alt={alt} className="max-w-full max-h-full object-contain rounded-lg" onClick={(e) => e.stopPropagation()} />
      <button className="absolute top-4 right-4 text-white text-2xl bg-black/50 rounded-full w-10 h-10 flex items-center justify-center hover:bg-black/70" onClick={onClose}>×</button>
    </div>
  );
}

function MediaImage({ path }: { path: string }) {
  const [lightbox, setLightbox] = useState(false);
  const [error, setError] = useState(false);
  const src = getMediaUrl(path);

  if (error) {
    return (
      <div className="inline-flex items-center gap-2 bg-app-hover dark:bg-elevated rounded-lg p-2 text-sm text-app-text-muted">
        🖼️ Image failed to load: {getFileName(path)}
      </div>
    );
  }

  return (
    <>
      <img src={src} alt={getFileName(path)} className="max-w-full max-h-80 rounded-lg cursor-pointer hover:opacity-90 transition-opacity my-1" onClick={() => setLightbox(true)} onError={() => setError(true)} loading="lazy" />
      {lightbox && <ImageLightbox src={src} alt={getFileName(path)} onClose={() => setLightbox(false)} />}
    </>
  );
}

function MediaAudio({ path }: { path: string }) {
  const src = getMediaUrl(path);
  return (
    <div className="my-2 bg-elevated dark:bg-elevated rounded-lg p-3 border border-app-border-light">
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
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      download={getFileName(path)}
      className="my-1 flex items-center gap-3 bg-elevated hover:bg-app-hover rounded-lg p-3 border border-app-border-light transition-colors no-underline text-inherit"
    >
      <FileIcon path={path} size={24} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{getFileName(path)}</div>
        <div className="text-xs text-app-text-muted uppercase">{getExtension(path)} file</div>
      </div>
      <Download size={16} className="text-app-text-muted flex-shrink-0" />
    </a>
  );
}

function MediaRenderer({ path }: { path: string }) {
  if (isImage(path)) return <MediaImage path={path} />;
  if (isAudio(path)) return <MediaAudio path={path} />;
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
    const isAbsolute = src.startsWith('/');
    const isMediaPath = src.startsWith('/Users/') || src.startsWith('/tmp/');
    if (isAbsolute || isMediaPath) return <MediaImage path={src} />;
    return <img src={src} alt={alt || ''} className="max-w-full max-h-80 rounded-lg my-1" loading="lazy" />;
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
function highlightMentions(text: string): (string | JSX.Element)[] {
  // Match @name at start of string or after whitespace (without lookbehind for Safari compat)
  const mentionRegex = /(^|\s)(@[a-zA-Z][a-zA-Z0-9_-]*)/gm;
  const parts: (string | JSX.Element)[] = [];
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
}

export const MessageContent = memo(function MessageContent({ content, role, thinking, toolCalls, media, partial, onPlanApprove, onPlanReject }: MessageContentProps) {
  const { cleanText: rawCleanText, mediaPaths: extractedMediaPaths } = useMemo(() => extractMediaPaths(content), [content]);

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
      <div>
        {allMediaPaths.map((path, i) => <div key={i} className="mb-2"><MediaRenderer path={path} /></div>)}
        {cleanText && renderUserText(cleanText)}
      </div>
    );
  }

  // Assistant message - render thinking, tool calls, content, and media
  return (
    <div>
      {/* Thinking block - always show if present */}
      {thinking && <ThinkingBlock content={thinking} />}

      {/* Tool calls */}
      {toolCalls && toolCalls.length > 0 && <ToolCallsList toolCalls={toolCalls} />}

      {/* Media */}
      {allMediaPaths.map((path, i) => <div key={i} className="mb-2"><MediaRenderer path={path} /></div>)}

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

      {/* Main content */}
      {cleanText && (!isPlanResponse(cleanText) || !onPlanApprove || partial) && (
        hasDiffBlocks(cleanText) ? (
          <DiffBlocksWithApplyAll segments={parseMessageWithDiffs(cleanText)} />
        ) : (
          <div className="prose prose-sm max-w-none prose-p:my-0.5 prose-headings:my-1.5 prose-ul:my-0.5 prose-ol:my-0.5 prose-li:my-0 prose-pre:my-1.5 prose-blockquote:my-1">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {cleanText}
            </ReactMarkdown>
          </div>
        )
      )}

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
