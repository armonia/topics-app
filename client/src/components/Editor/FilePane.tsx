import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { GitBranch, Download, ZoomIn, ZoomOut, WrapText, Eye, Code, Copy, Check } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { filesApi, gitApi } from '../../lib/api';
import { markdownComponents } from '../MessageContent';
import { BreadcrumbNav } from './BreadcrumbNav';

const CodeEditor = lazy(() => import('./CodeEditor').then(m => ({ default: m.CodeEditor })));
const DiffViewer = lazy(() => import('./DiffViewer').then(m => ({ default: m.DiffViewer })));

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'avi', 'mkv', 'ogv']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'aac', 'flac', 'm4a', 'opus', 'wma']);
const PDF_EXTS = new Set(['pdf']);

function getFileExt(filename: string): string {
  return (filename.split('.').pop() || '').toLowerCase();
}

type MediaType = 'image' | 'video' | 'audio' | 'pdf' | 'text';

function getMediaType(filename: string): MediaType {
  const ext = getFileExt(filename);
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (PDF_EXTS.has(ext)) return 'pdf';
  return 'text';
}

interface FilePaneProps {
  filePath: string;
  projectPath: string;
  diff?: boolean;
  diffProjectPath?: string;
  onPin?: () => void;
}

export function FilePane({ filePath, projectPath, diff, diffProjectPath, onPin }: FilePaneProps) {
  const [content, setContent] = useState('');
  const [, setOriginalContent] = useState('');
  const [diffOriginal, setDiffOriginal] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [darkMode, setDarkMode] = useState(false);

  const handleBreadcrumbOpen = useCallback((path: string, _name: string) => {
    window.dispatchEvent(new CustomEvent('open-file', { detail: { path } }));
  }, []);

  const [wordWrap, setWordWrap] = useState(() => localStorage.getItem('editor-word-wrap') === '1');
  const [mdPreview, setMdPreview] = useState(false);
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });

  const filename = filePath.split('/').pop() || filePath;
  const mediaType = getMediaType(filename);
  const isMedia = mediaType !== 'text';
  const isMd = /\.(md|mdx|markdown)$/i.test(filename);

  const toggleWrap = useCallback(() => {
    setWordWrap(prev => {
      const next = !prev;
      localStorage.setItem('editor-word-wrap', next ? '1' : '0');
      return next;
    });
  }, []);

  const togglePreview = useCallback(() => setMdPreview(prev => !prev), []);

  // Dark mode observer
  useEffect(() => {
    const check = () => setDarkMode(document.documentElement.classList.contains('dark'));
    check();
    const obs = new MutationObserver(check);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  // Load file content (skip for media files)
  useEffect(() => {
    if (isMedia) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    if (diff && diffProjectPath) {
      const gitRelPath = filePath.replace(diffProjectPath + '/', '');
      Promise.all([
        gitApi.show(diffProjectPath, gitRelPath).catch(() => ''),
        filesApi.content(filePath).catch(() => ''),
      ]).then(([original, modified]) => {
        if (cancelled) return;
        setDiffOriginal(original);
        setContent(modified);
        setOriginalContent(modified);
        setLoading(false);
      }).catch((err: any) => {
        if (cancelled) return;
        setError(err.message || 'Failed to load diff');
        setLoading(false);
      });
    } else {
      filesApi.content(filePath).then(text => {
        if (cancelled) return;
        setContent(text);
        setOriginalContent(text);
        setLoading(false);
      }).catch((err: any) => {
        if (cancelled) return;
        setError(err.message || 'Failed to load file');
        setLoading(false);
      });
    }
    return () => { cancelled = true; };
  }, [filePath, diff, diffProjectPath, isMedia]);

  const pinnedRef = useRef(false);
  const handleChange = useCallback((newContent: string) => {
    setContent(newContent);
    if (!pinnedRef.current && onPin) {
      pinnedRef.current = true;
      onPin();
    }
  }, [onPin]);

  const handleSave = useCallback(async (text: string) => {
    try {
      await filesApi.save(filePath, text);
      setContent(text);
      setOriginalContent(text);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch {
      setSaveStatus('error');
    }
  }, [filePath]);


  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-4 h-4 border-2 border-app-spinner border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-[13px]">
        <p className="text-red-500">{error}</p>
        <button
          onClick={() => { setLoading(true); setError(null); filesApi.content(filePath).then(t => { setContent(t); setOriginalContent(t); setLoading(false); }).catch((e: any) => { setError(e.message); setLoading(false); }); }}
          className="text-primary hover:underline"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Breadcrumb path bar */}
      <BreadcrumbNav filePath={filePath} projectPath={projectPath} openFile={handleBreadcrumbOpen} actions={
        <>
          {!isMedia && !mdPreview && <span className="text-[10px] text-app-text-muted tabular-nums">Ln {cursorPos.line}, Col {cursorPos.col}</span>}
          {!isMedia && <WrapBtn active={wordWrap} onClick={toggleWrap} />}
          {isMd && <PreviewBtn previewing={mdPreview} onClick={togglePreview} />}
          <CopyPathBtn filePath={filePath} projectPath={projectPath} />
        </>
      } />

      {diff && (
        <div className="flex items-center gap-2 px-3 py-1 border-b border-app-border bg-elevated flex-shrink-0 text-[10px] text-app-text-muted">
          <GitBranch size={12} className="text-amber-500 flex-shrink-0" />
          <span>Original (HEAD)</span>
          <span>|</span>
          <span>Modified (Working)</span>
        </div>
      )}

      {/* Content area */}
      <div className="flex-1 overflow-hidden">
        {isMedia ? (
          <MediaViewer filePath={filePath} mediaType={mediaType} filename={filename} />
        ) : diff ? (
          <Suspense fallback={<div className="flex items-center justify-center h-full"><div className="w-4 h-4 border-2 border-app-spinner border-t-primary rounded-full animate-spin" /></div>}>
            <DiffViewer
              originalContent={diffOriginal}
              modifiedContent={content}
              filename={filename}
              darkMode={darkMode}
            />
          </Suspense>
        ) : mdPreview && isMd ? (
          <div className="h-full overflow-auto px-6 py-4 prose dark:prose-invert prose-sm max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {content}
            </ReactMarkdown>
          </div>
        ) : (
          <Suspense fallback={<div className="flex items-center justify-center h-full"><div className="w-4 h-4 border-2 border-app-spinner border-t-primary rounded-full animate-spin" /></div>}>
            <CodeEditor
              content={content}
              filename={filename}
              readOnly={false}
              darkMode={darkMode}
              onSave={handleSave}
              onChange={handleChange}
              wordWrap={wordWrap}
              onCursorChange={(l, c) => setCursorPos(prev => prev.line === l && prev.col === c ? prev : { line: l, col: c })}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}

// ── Toolbar Buttons ──

function CopyPathBtn({ filePath, projectPath }: { filePath: string; projectPath: string }) {
  const [copied, setCopied] = useState(false);
  const copyPath = () => {
    const rel = filePath.replace(projectPath, '').replace(/^\//, '');
    navigator.clipboard.writeText(rel);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button onClick={copyPath} title="Copy Path" className="p-0.5 rounded hover:bg-app-hover transition-colors text-app-text-muted">
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

function WrapBtn({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} title="Word Wrap" className={`p-0.5 rounded hover:bg-app-hover transition-colors ${active ? 'text-primary' : 'text-app-text-muted'}`}>
      <WrapText size={13} />
    </button>
  );
}

function PreviewBtn({ previewing, onClick }: { previewing: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} title={previewing ? 'Show Editor' : 'Preview Markdown'} className="p-0.5 rounded hover:bg-app-hover transition-colors text-app-text-muted">
      {previewing ? <Code size={13} /> : <Eye size={13} />}
    </button>
  );
}

// ── Media Viewer ──

function MediaViewer({ filePath, mediaType, filename }: { filePath: string; mediaType: MediaType; filename: string }) {
  // Use /preview/ endpoint which serves any absolute path with correct MIME type
  const mediaUrl = `/preview${filePath}`;
  const [zoom, setZoom] = useState(1);
  const [imageError, setImageError] = useState(false);

  const resetZoom = () => setZoom(1);

  if (mediaType === 'image') {
    return (
      <div className="flex flex-col h-full">
        {/* Toolbar */}
        <div className="flex items-center gap-1 px-2 py-1 border-b border-app-border bg-elevated flex-shrink-0">
          <button onClick={() => setZoom(z => Math.max(0.1, z - 0.25))} className="w-6 h-6 flex items-center justify-center rounded hover:bg-app-hover text-app-text-muted" title="Zoom out">
            <ZoomOut size={14} />
          </button>
          <button onClick={resetZoom} className="px-1.5 h-6 flex items-center justify-center rounded hover:bg-app-hover text-[10px] text-app-text-muted tabular-nums min-w-[40px]" title="Reset zoom">
            {Math.round(zoom * 100)}%
          </button>
          <button onClick={() => setZoom(z => Math.min(5, z + 0.25))} className="w-6 h-6 flex items-center justify-center rounded hover:bg-app-hover text-app-text-muted" title="Zoom in">
            <ZoomIn size={14} />
          </button>
          <div className="flex-1" />
          <a href={mediaUrl} download={filename} className="w-6 h-6 flex items-center justify-center rounded hover:bg-app-hover text-app-text-muted" title="Download">
            <Download size={14} />
          </a>
        </div>
        {/* Image */}
        <div className="flex-1 overflow-auto flex items-center justify-center bg-[repeating-conic-gradient(#80808015_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]">
          {imageError ? (
            <p className="text-[13px] text-app-text-muted">Unable to load image</p>
          ) : (
            <img
              src={mediaUrl}
              alt={filename}
              style={{ transform: `scale(${zoom})`, transformOrigin: 'center', maxWidth: zoom <= 1 ? '100%' : 'none', maxHeight: zoom <= 1 ? '100%' : 'none' }}
              className="object-contain transition-transform duration-100"
              onError={() => setImageError(true)}
              draggable={false}
            />
          )}
        </div>
      </div>
    );
  }

  if (mediaType === 'video') {
    return (
      <div className="flex-1 flex items-center justify-center bg-black h-full">
        <video
          src={mediaUrl}
          controls
          className="max-w-full max-h-full"
          preload="metadata"
        >
          Your browser does not support video playback.
        </video>
      </div>
    );
  }

  if (mediaType === 'audio') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 h-full">
        <div className="text-[48px] opacity-30">&#9835;</div>
        <span className="text-[13px] text-app-text-muted">{filename}</span>
        <audio src={mediaUrl} controls preload="metadata" className="w-[320px] max-w-full" />
        <a href={mediaUrl} download={filename} className="text-[12px] text-primary hover:underline flex items-center gap-1">
          <Download size={12} /> Download
        </a>
      </div>
    );
  }

  if (mediaType === 'pdf') {
    return (
      <div className="flex-1 h-full">
        <iframe
          src={mediaUrl}
          title={filename}
          className="w-full h-full border-0"
        />
      </div>
    );
  }

  return null;
}
