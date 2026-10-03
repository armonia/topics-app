import { useState, useEffect, useLayoutEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { copyText } from '../../lib/clipboard';
import { GitBranch, WrapText, Eye, Code, Copy, Check } from 'lucide-react';
import { filesApi, gitApi } from '../../lib/api';
import { HunkActions } from '../Git/HunkActions';
import { fetchHunks, type HunkSeed } from '../Git/hunkSeed';
import { basename } from '../../lib/path-utils';
import { BreadcrumbNav } from './BreadcrumbNav';
import { getMediaType, isHtmlFile, MediaViewer, HtmlPreview } from './fileMedia';
import { createPaneId } from '../../state/pane/adapters';
import { FindBar } from '../Shared/FindBar';
import { useFindPaneId } from '../../state/findRegistry';
import { Spinner, SpinnerFallback } from '../Shared/Spinner';
import { EditorSkeleton } from '../Layout/PaneSkeletons';
import { readFileContentCache, writeFileContentCache } from '../../lib/fileContentCache';
import { lazyWarm, warm } from '../../lib/lazyWarm';
import { loadCodeEditor } from '../../state/pane/panePreload';

// `lazyWarm` and not `lazy`: this pane arrives warm at boot (`panePreload`
// asks for its chunk before React renders) and then stopped HERE, on a second
// `import()` that only left once the suspense boundary was reached. The pane
// was warm; its body was not. Same chunk, same boundary if the chunk is cold -
// but when it is warm the editor renders in the same pass as the pane.
const CodeEditor = lazyWarm(loadCodeEditor, (m) => m.CodeEditor);
// `lazyWarm` for the same reason, and warmed by the diff read itself (see the
// load effect): the chunk arrives with the content, so the viewer mounts in the
// same commit as the text instead of suspending once more behind a fallback.
const loadDiffViewer = () => import('./DiffViewer');
const DiffViewer = lazyWarm(loadDiffViewer, (m) => m.DiffViewer);
// The Markdown preview drags parse5 in through `rehype-raw` — see the header
// of MarkdownPreview.tsx. Lazy so a plain file open doesn't pay for it.
const MarkdownPreview = lazy(() => import('./MarkdownPreview'));

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * THE PREVIEW SLOT'S HANDOFF. Clicking the next file of a review does not
 * update this pane: it REPLACES the preview pane with a new one (a new id, a
 * new instance), so a "keep the previous file until the next one is read"
 * inside one instance never gets the chance. Measured: the new pane mounts, and
 * the replaced one unmounts ~2 ms later, before the next paint.
 *
 * So a pane that mounts with nothing to show registers as WAITING, and the
 * preview pane that unmounts right after hands it what it was showing (in its
 * layout cleanup, so the update is flushed before the paint). The waiting pane
 * shows it read-only, with the breadcrumb spinner, until its own file is read.
 * Only an UNMOUNTING preview hands off, and only to a pane of the same project
 * and mode that mounted within `TRANSFER_WINDOW_MS`: a diff opened next to a
 * preview that stays (a split) never shows the other pane's file.
 */
type PaneTransfer = { projectPath: string; diff: boolean; path: string; content: string; diffOriginal: string; hunks: HunkSeed | undefined };
type TransferWaiter = { projectPath: string; diff: boolean; path: string; since: number; adopt: (h: PaneTransfer) => void };
const transferWaiters = new Set<TransferWaiter>();
const TRANSFER_WINDOW_MS = 250;

interface FilePaneProps {
  filePath: string;
  projectPath: string;
  diff?: boolean;
  diffProjectPath?: string;
  onPin?: () => void;
}

export function FilePane({ filePath, projectPath, diff, diffProjectPath, onPin }: FilePaneProps) {
  // ⌘F: the pane's id from its host (`PaneKeepAlive`), or the file's own.
  const findPaneId = useFindPaneId() ?? createPaneId('file', filePath);
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
  // THE PATH WHOSE CONTENT IS ON SCREEN, which during a switch is not yet
  // `filePath`. Switching to another file used to unmount the breadcrumb and
  // the editor for a centred spinner and mount them back 60-400 ms later, a
  // blink on every file of a review (fluidity audit panes:F9). Now the previous
  // file stays up, read-only, with a small spinner in the breadcrumb, and the
  // next one replaces it in one commit. `null` = nothing drawn yet.
  const [shownPath, setShownPath] = useState<string | null>(() => (readFileContentCache(filePath) === null ? null : filePath));
  const shownPathRef = useRef(shownPath);
  useEffect(() => { shownPathRef.current = shownPath; }, [shownPath]);

  // The handoff (see `transferWaiters`): what this pane shows, kept current for
  // its unmount, and picked up from the pane it replaces on mount.
  const transferRef = useRef<PaneTransfer | null>(null);
  const previewRef = useRef(!!onPin);
  useEffect(() => {
    previewRef.current = !!onPin;
    if (shownPath !== null && !loading) {
      transferRef.current = { projectPath, diff: !!diff, path: shownPath, content, diffOriginal, hunks: hunkSeed };
    }
  });
  useLayoutEffect(() => {
    let waiter: TransferWaiter | null = null;
    if (shownPath === null) {
      waiter = {
        projectPath, diff: !!diff, path: filePath, since: performance.now(),
        adopt: (from) => {
          transferWaiters.delete(waiter!);
          // Our own file already landed: nothing to bridge.
          if (shownPathRef.current !== null) return;
          setContent(from.content);
          setDiffOriginal(from.diffOriginal);
          setHunkSeed(from.hunks);
          setShownPath((cur) => cur ?? from.path);
        },
      };
      transferWaiters.add(waiter);
    }
    return () => {
      if (waiter) transferWaiters.delete(waiter);
      const mine = transferRef.current;
      if (!previewRef.current || !mine) return;
      const now = performance.now();
      for (const w of transferWaiters) {
        if (w.projectPath === mine.projectPath && w.diff === mine.diff && w.path !== mine.path && now - w.since < TRANSFER_WINDOW_MS) w.adopt(mine);
      }
    };
    // Mount/unmount only: the handoff is a moment, not a subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The hunk strip of the diff, read WITH the diff (see `HunkActions.seed`).
  const [hunkSeed, setHunkSeed] = useState<HunkSeed | undefined>(undefined);
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
  const mediaType = getMediaType(filename);
  const isMedia = mediaType !== 'text';
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
      setLoading(false);
      setShownPath(filePath);
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
    else { setContent(cached); setLoading(false); setShownPath(filePath); }
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
          setShownPath(filePath);
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
      // The diff, its hunks and the viewer's chunk in ONE wait, applied in one
      // commit: the text, the hunk strip and the viewer land together, so
      // nothing below the breadcrumb moves after it (panes:F9).
      Promise.all([
        gitApi.show(diffProjectPath, gitRelPath).catch(() => ''),
        filesApi.content(filePath).catch(() => ''),
        fetchHunks(diffProjectPath, gitRelPath),
        warm(loadDiffViewer).catch(() => null),
      ]).then(([original, modified, hunks]) => {
        if (cancelled) return;
        setDiffOriginal(original);
        setContent(modified);
        setOriginalContent(modified);
        setHunkSeed(hunks);
        setLoading(false);
        setShownPath(filePath);
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
        setShownPath(filePath);
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
    // During a switch the editor still holds the PREVIOUS file: saving it now
    // would write that text under the new path.
    if (shownPathRef.current !== filePath) return;
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


  // Nothing on screen yet: the breadcrumb is already known (it is the path),
  // and the editor area waits as an editor, not as a ring in an empty pane.
  if (loading && shownPath === null) {
    return (
      <div className="flex flex-col h-full" data-testid="file-pane-loading">
        <BreadcrumbNav filePath={filePath} projectPath={projectPath} openFile={handleBreadcrumbOpen} />
        {diff && <DiffModeStrip />}
        <div className="flex-1 overflow-hidden">
          <EditorSkeleton />
        </div>
      </div>
    );
  }
  // A switch in flight: the previous file is what is drawn, and it is not
  // editable meanwhile (a save now would write it under the NEW path).
  const switching = loading && shownPath !== filePath;
  const displayPath = shownPath ?? filePath;
  const displayRel = diffProjectPath ? displayPath.replace(diffProjectPath + '/', '') : displayPath;
  // What the drawn file IS (its type decides the viewer), not what is loading.
  const shownName = basename(displayPath) || displayPath;
  const shownMediaType = getMediaType(shownName);
  const shownIsMedia = shownMediaType !== 'text';
  const shownIsMd = /\.(md|mdx|markdown)$/i.test(shownName);
  const shownIsHtml = isHtmlFile(shownName);
  const shownMdBaseDir = displayPath.substring(0, displayPath.lastIndexOf('/'));

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-prose">
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
      <BreadcrumbNav filePath={displayPath} projectPath={projectPath} openFile={handleBreadcrumbOpen} actions={
        <>
          {switching && <Spinner size="xs" className="mr-1" />}
          {!shownIsMedia && !mdPreview && !(shownIsHtml && htmlPreview) && <span className="text-mini text-app-text-muted tabular-nums">Ln {cursorPos.line}, Col {cursorPos.col}</span>}
          {!shownIsMedia && !(shownIsHtml && htmlPreview) && <WrapBtn active={wordWrap} onClick={toggleWrap} />}
          {shownIsMd && <PreviewBtn previewing={mdPreview} onClick={togglePreview} />}
          {shownIsHtml && <PreviewBtn previewing={htmlPreview} onClick={toggleHtmlPreview} label="HTML" />}
          <CopyPathBtn filePath={displayPath} projectPath={projectPath} />
        </>
      } />

      {diff && <DiffModeStrip />}

      {/* ⌘F in this file (FILE-FIND-01/02): the editor, the diff or the
          Markdown preview below registers the engine; media and the HTML
          preview register none and ⌘F falls back to the project search. */}
      <FindBar paneId={findPaneId} />

      {/* I blocchi, con le loro azioni. Stanno anche QUI e non solo nel
          pannello Git perche' dalla sidebar il diff si apre proprio come questa
          tab: se ci fossero solo la', lo staging per blocco sarebbe una cosa
          che esiste e che non si incontra mai. */}
      {diff && diffProjectPath && (
        <HunkActions
          projectPath={diffProjectPath}
          file={displayRel}
          reloadKey={diffTick}
          onApplied={() => setDiffTick(t => t + 1)}
          seed={hunkSeed}
        />
      )}

      {/* Content area */}
      <div className="flex-1 overflow-hidden">
        {shownIsMedia ? (
          <MediaViewer filePath={displayPath} mediaType={shownMediaType} filename={shownName} />
        ) : diff ? (
          <Suspense fallback={<EditorSkeleton />}>
            <DiffViewer
              originalContent={diffOriginal}
              modifiedContent={content}
              filename={shownName}
              darkMode={darkMode}
              findPaneId={findPaneId}
            />
          </Suspense>
        ) : mdPreview && shownIsMd ? (
          <Suspense fallback={<SpinnerFallback />}>
            <MarkdownPreview content={content} baseDir={shownMdBaseDir} findPaneId={findPaneId} />
          </Suspense>
        ) : htmlPreview && shownIsHtml ? (
          <HtmlPreview filePath={displayPath} filename={shownName} />
        ) : (
          <Suspense fallback={<EditorSkeleton />}>
            <CodeEditor
              content={content}
              filename={shownName}
              readOnly={switching}
              darkMode={darkMode}
              onSave={handleSave}
              onChange={handleChange}
              wordWrap={wordWrap}
              onCursorChange={(l, c) => setCursorPos(prev => prev.line === l && prev.col === c ? prev : { line: l, col: c })}
              findPaneId={findPaneId}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}

/** The "Original (HEAD) | Modified (Working)" strip over a diff. */
function DiffModeStrip() {
  return (
    <div className="flex items-center gap-2 px-3 py-1 border-b border-app-border bg-elevated flex-shrink-0 text-mini text-app-text-muted">
      <GitBranch size={12} className="text-amber-500 flex-shrink-0" />
      <span>Original (HEAD)</span>
      <span>|</span>
      <span>Modified (Working)</span>
    </div>
  );
}

// ── Toolbar Buttons ──

function CopyPathBtn({ filePath, projectPath }: { filePath: string; projectPath: string }) {
  const [copied, setCopied] = useState(false);
  const copyPath = async () => {
    const rel = filePath.replace(projectPath, '').replace(/^\//, '');
    if (!(await copyText(rel))) return;
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

