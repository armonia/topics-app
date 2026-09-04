import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { GitBranch, WrapText, Eye, Code, Copy, Check } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { filesApi, gitApi } from '../../lib/api';
import { HunkActions } from '../Git/HunkActions';
import { basename } from '../../lib/path-utils';
import { markdownComponents, MarkdownBaseDirContext } from '../MessageContent';
import { BreadcrumbNav } from './BreadcrumbNav';
import { getMediaType, isHtmlFile, MediaViewer, HtmlPreview } from './fileMedia';
import { createPaneId } from '../../state/pane/adapters';
import { Spinner, SpinnerFallback } from '../Shared/Spinner';
import { readFileContentCache, writeFileContentCache } from '../../lib/fileContentCache';

const CodeEditor = lazy(() => import('./CodeEditor').then(m => ({ default: m.CodeEditor })));
const DiffViewer = lazy(() => import('./DiffViewer').then(m => ({ default: m.DiffViewer })));

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface FilePaneProps {
  filePath: string;
  projectPath: string;
  diff?: boolean;
  diffProjectPath?: string;
  onPin?: () => void;
}

export function FilePane({ filePath, projectPath, diff, diffProjectPath, onPin }: FilePaneProps) {
  // THE SEED: the text of this file as it was the last time it was open, read
  // synchronously so the first frame draws the editor instead of a spinner in
  // an empty pane. The fetch below leaves anyway and replaces it; what the seed
  // removes is the flash between the two (a spinner is centred, text is not, so
  // on a reload the swap was also a layout shift).
  const [content, setContent] = useState(() => readFileContentCache(filePath) ?? '');
  const [, setOriginalContent] = useState('');
  const [diffOriginal, setDiffOriginal] = useState('');
  // Sale quando si mette in stage (o si scarta) un blocco: il diff mostrato
  // non e' piu' quello vero, e va riletto.
  const [diffTick, setDiffTick] = useState(0);
  // A pane with a cached copy in hand is not loading: it has something to draw.
  const [loading, setLoading] = useState(() => readFileContentCache(filePath) === null);
  const [error, setError] = useState<string | null>(null);
  const [, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [darkMode, setDarkMode] = useState(false);

  const handleBreadcrumbOpen = useCallback((path: string, _name: string) => {
    // Tag with the OWNING project so breadcrumb navigation opens the file in
    // THIS project window, not every project in split view (see the 'open-file'
    // scoping in useProjectLayout). projectPath is always set for a file pane.
    window.dispatchEvent(new CustomEvent('open-file', {
      detail: { path, topicId: createPaneId('project', projectPath) },
    }));
  }, [projectPath]);

  const [wordWrap, setWordWrap] = useState(() => localStorage.getItem('editor-word-wrap') === '1');
  const [mdPreview, setMdPreview] = useState(false);
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });

  const filename = basename(filePath) || filePath;
  const mdBaseDir = filePath.substring(0, filePath.lastIndexOf('/'));
  const mediaType = getMediaType(filename);
  const isMedia = mediaType !== 'text';
  const isMd = /\.(md|mdx|markdown)$/i.test(filename);
  const isHtml = isHtmlFile(filename);
  const [htmlPreview, setHtmlPreview] = useState(true);

  const toggleWrap = useCallback(() => {
    setWordWrap(prev => {
      const next = !prev;
      localStorage.setItem('editor-word-wrap', next ? '1' : '0');
      return next;
    });
  }, []);

  const togglePreview = useCallback(() => setMdPreview(prev => !prev), []);
  const toggleHtmlPreview = useCallback(() => setHtmlPreview(prev => !prev), []);

  // Dark mode observer
  useEffect(() => {
    const check = () => setDarkMode(document.documentElement.classList.contains('dark'));
    check();
    const obs = new MutationObserver(check);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  // Load file content (skip for media files and HTML preview — both render via iframe)
  useEffect(() => {
    if (isMedia || (isHtml && htmlPreview)) {
      // No fetch for iframe-rendered content: converge loading→false once.
      // Deps exclude `loading`, so this cannot cascade/loop.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot convergence for the no-fetch (media/html-preview) path; safe, no loop
      setLoading(false);
      return;
    }

    let cancelled = false;
    // Only when there is nothing to show: raising the curtain over a cached
    // copy would put the spinner back exactly where the seed removed it. And
    // when the pane switches to ANOTHER file, the seed has to be re-read here:
    // the initial state only runs on mount, so without this line switching tab
    // would keep the previous file's text on screen until the fetch answers.
    const cached = readFileContentCache(filePath);
    if (cached === null) setLoading(true);
    else { setContent(cached); setLoading(false); }
    setError(null);

    // HTML source view: fetch via /preview/ (no 100KB limit, unlike /api/files/content)
    if (isHtml) {
      fetch(`/preview${filePath}`)
        .then(r => r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)))
        .then(text => {
          if (cancelled) return;
          setContent(text);
          setOriginalContent(text);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(errorMessage(err) || 'Failed to load file');
          setLoading(false);
        });
      return () => { cancelled = true; };
    }

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
      }).catch((err: unknown) => {
        if (cancelled) return;
        setError(errorMessage(err) || 'Failed to load diff');
        setLoading(false);
      });
    } else {
      filesApi.content(filePath).then(text => {
        if (cancelled) return;
        setContent(text);
        setOriginalContent(text);
        writeFileContentCache(filePath, text);
        setLoading(false);
      }).catch((err: unknown) => {
        if (cancelled) return;
        setError(errorMessage(err) || 'Failed to load file');
        setLoading(false);
      });
    }
    return () => { cancelled = true; };
  }, [filePath, diff, diffProjectPath, isMedia, isHtml, htmlPreview, diffTick]);

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
        <Spinner size="md" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-[13px]">
        <p className="text-red-500">{error}</p>
        <button
          onClick={() => { setLoading(true); setError(null); filesApi.content(filePath).then(t => { setContent(t); setOriginalContent(t); setLoading(false); }).catch((e: unknown) => { setError(errorMessage(e)); setLoading(false); }); }}
          className="text-primary hover:underline"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full" data-testid="file-pane">
      {/* Breadcrumb path bar */}
      <BreadcrumbNav filePath={filePath} projectPath={projectPath} openFile={handleBreadcrumbOpen} actions={
        <>
          {!isMedia && !mdPreview && !(isHtml && htmlPreview) && <span className="text-[11px] text-app-text-muted tabular-nums">Ln {cursorPos.line}, Col {cursorPos.col}</span>}
          {!isMedia && !(isHtml && htmlPreview) && <WrapBtn active={wordWrap} onClick={toggleWrap} />}
          {isMd && <PreviewBtn previewing={mdPreview} onClick={togglePreview} />}
          {isHtml && <PreviewBtn previewing={htmlPreview} onClick={toggleHtmlPreview} label="HTML" />}
          <CopyPathBtn filePath={filePath} projectPath={projectPath} />
        </>
      } />

      {diff && (
        <div className="flex items-center gap-2 px-3 py-1 border-b border-app-border bg-elevated flex-shrink-0 text-[11px] text-app-text-muted">
          <GitBranch size={12} className="text-amber-500 flex-shrink-0" />
          <span>Original (HEAD)</span>
          <span>|</span>
          <span>Modified (Working)</span>
        </div>
      )}

      {/* I blocchi, con le loro azioni. Stanno anche QUI e non solo nel
          pannello Git perche' dalla sidebar il diff si apre proprio come questa
          tab: se ci fossero solo la', lo staging per blocco sarebbe una cosa
          che esiste e che non si incontra mai. */}
      {diff && diffProjectPath && (
        <HunkActions
          projectPath={diffProjectPath}
          file={filePath.replace(diffProjectPath + '/', '')}
          reloadKey={diffTick}
          onApplied={() => setDiffTick(t => t + 1)}
        />
      )}

      {/* Content area */}
      <div className="flex-1 overflow-hidden">
        {isMedia ? (
          <MediaViewer filePath={filePath} mediaType={mediaType} filename={filename} />
        ) : diff ? (
          <Suspense fallback={<SpinnerFallback />}>
            <DiffViewer
              originalContent={diffOriginal}
              modifiedContent={content}
              filename={filename}
              darkMode={darkMode}
            />
          </Suspense>
        ) : mdPreview && isMd ? (
          <MarkdownBaseDirContext.Provider value={mdBaseDir}>
            <div className="h-full overflow-auto px-6 py-4 prose dark:prose-invert prose-sm max-w-none prose-img:inline-block prose-img:my-1 prose-p:my-2">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeRaw]}
                components={markdownComponents}
              >
                {content}
              </ReactMarkdown>
            </div>
          </MarkdownBaseDirContext.Provider>
        ) : htmlPreview && isHtml ? (
          <HtmlPreview filePath={filePath} filename={filename} />
        ) : (
          <Suspense fallback={<SpinnerFallback />}>
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
    // `aria-pressed` e non solo la tinta: acceso e spento si distinguevano solo
    // per il colore dell'icona, cioe' per niente che un lettore di schermo (o
    // una spec) possa leggere.
    <button onClick={onClick} title="Word Wrap" aria-pressed={active} data-testid="editor-wrap-toggle" className={`p-0.5 rounded hover:bg-app-hover transition-colors ${active ? 'text-primary' : 'text-app-text-muted'}`}>
      <WrapText size={13} />
    </button>
  );
}

function PreviewBtn({ previewing, onClick, label = 'Markdown' }: { previewing: boolean; onClick: () => void; label?: string }) {
  return (
    <button onClick={onClick} title={previewing ? 'Show Source' : `Preview ${label}`} className={`p-0.5 rounded hover:bg-app-hover transition-colors ${previewing ? 'text-primary' : 'text-app-text-muted'}`}>
      {previewing ? <Code size={13} /> : <Eye size={13} />}
    </button>
  );
}

