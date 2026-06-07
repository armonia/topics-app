import { useState, useEffect, useCallback, useImperativeHandle, forwardRef, useRef, lazy, Suspense } from 'react';
import { X, File, WrapText, Eye, Code, Copy, Check } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { filesApi } from '../../lib/api';
import { getFileIconDef } from '../../lib/fileIcons';
import { markdownComponents } from '../MessageContent';
import { BreadcrumbNav } from './BreadcrumbNav';
import { getMediaType, isHtmlFile, MediaViewer, HtmlPreview } from './fileMedia';

const CodeEditor = lazy(() => import('./CodeEditor').then(m => ({ default: m.CodeEditor })));

export interface TabInfo {
  path: string;
  name: string;
  content: string;
  originalContent: string;
  loading?: boolean;
  preview?: boolean;
  lineNumber?: number;
}

interface EditorTabsProps {
  projectPath: string;
}

export const EditorTabs = forwardRef<EditorTabsHandle, EditorTabsProps>(function EditorTabs({ projectPath }, ref) {
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [darkMode, setDarkMode] = useState(false);
  const [saveStatus, setSaveStatus] = useState<Record<string, 'saved' | 'error'>>({});
  const [wordWrap, setWordWrap] = useState(() => localStorage.getItem('editor-word-wrap') === '1');
  const [mdPreviewTabs, setMdPreviewTabs] = useState<Record<string, boolean>>({});
  const [htmlPreviewTabs, setHtmlPreviewTabs] = useState<Record<string, boolean>>({});
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });
  const fetchAbortRef = useRef<AbortController | null>(null);

  // Abort any in-flight fetch when component unmounts
  useEffect(() => {
    return () => { fetchAbortRef.current?.abort(); };
  }, []);

  useEffect(() => {
    const check = () => setDarkMode(document.documentElement.classList.contains('dark'));
    check();
    const obs = new MutationObserver(check);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  const openFile = useCallback((path: string, name: string, lineNumber?: number, preview: boolean = true) => {
    // Save to recent files
    try {
      const key = `recent-files-${projectPath}`;
      const recent: { path: string; name: string; timestamp: number }[] = JSON.parse(localStorage.getItem(key) || '[]');
      const filtered = recent.filter(r => r.path !== path);
      filtered.unshift({ path, name, timestamp: Date.now() });
      localStorage.setItem(key, JSON.stringify(filtered.slice(0, 20)));
    } catch {}

    // Binary/media files (pdf, image, video, audio) are rendered via /preview/ iframe;
    // we must NOT fetch their bytes through /api/files/content (which has a 100KB text limit).
    // HTML is also rendered in an iframe by default, so we can skip the fetch too.
    const mediaType = getMediaType(name);
    const skipFetch = mediaType !== 'text' || isHtmlFile(name);

    let shouldFetch = false;

    setTabs(prev => {
      const existing = prev.findIndex(t => t.path === path);
      if (existing >= 0) {
        setActiveIndex(existing);
        // Update lineNumber if provided
        if (lineNumber !== undefined) {
          return prev.map((t, i) => i === existing ? { ...t, lineNumber } : t);
        }
        return prev;
      }

      // New tab needed — fetch only if it's a text file we can edit
      shouldFetch = !skipFetch;

      // If there's an existing preview tab, replace it
      const previewIndex = prev.findIndex(t => t.preview);
      const newTab: TabInfo = { path, name, content: '', originalContent: '', loading: !skipFetch, preview, lineNumber };

      if (previewIndex >= 0 && preview) {
        // Replace the existing preview tab
        const next = [...prev];
        next[previewIndex] = newTab;
        setActiveIndex(previewIndex);
        return next;
      }

      setActiveIndex(prev.length);
      return [...prev, newTab];
    });

    // Fetch content OUTSIDE setTabs — cancel any previous in-flight fetch (prevents stale content on rapid opens)
    if (shouldFetch) {
      if (fetchAbortRef.current) fetchAbortRef.current.abort();
      const controller = new AbortController();
      fetchAbortRef.current = controller;

      filesApi.content(path).then(content => {
        if (controller.signal.aborted) return; // Discard if overtaken by newer open
        setTabs(t => t.map(tab => tab.path === path ? { ...tab, content, originalContent: content, loading: false } : tab));
      }).catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        setTabs(t => t.map(tab => tab.path === path ? { ...tab, content: `Error: ${message}`, originalContent: '', loading: false } : tab));
      });
    }
  }, [projectPath]);

  const pinTab = useCallback((path: string) => {
    setTabs(prev => prev.map(t => t.path === path ? { ...t, preview: false } : t));
  }, []);

  useImperativeHandle(ref, () => ({ openFile, pinTab }), [openFile, pinTab]);

  const closeTab = useCallback((index: number, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setTabs(prev => {
      const next = prev.filter((_, i) => i !== index);
      setActiveIndex(ai => {
        if (index < ai) return ai - 1;
        if (index === ai) return Math.min(ai, next.length - 1);
        return ai;
      });
      return next;
    });
  }, []);

  const handleContentChange = useCallback((path: string, newContent: string) => {
    setTabs(prev => prev.map(t => t.path === path ? { ...t, content: newContent, preview: false } : t));
  }, []);

  const handleSave = useCallback(async (content: string) => {
    const tab = tabs[activeIndex];
    if (!tab) return;
    try {
      await filesApi.save(tab.path, content);
      setTabs(prev => prev.map(t => t.path === tab.path ? { ...t, content, originalContent: content } : t));
      setSaveStatus(prev => ({ ...prev, [tab.path]: 'saved' }));
      setTimeout(() => setSaveStatus(prev => { const n = { ...prev }; delete n[tab!.path]; return n; }), 2000);
    } catch {
      setSaveStatus(prev => ({ ...prev, [tab.path]: 'error' }));
    }
  }, [tabs, activeIndex]);

  const toggleWrap = useCallback(() => {
    setWordWrap(prev => {
      const next = !prev;
      localStorage.setItem('editor-word-wrap', next ? '1' : '0');
      return next;
    });
  }, []);

  const togglePreview = useCallback(() => {
    const tab = tabs[activeIndex];
    if (!tab) return;
    setMdPreviewTabs(prev => ({ ...prev, [tab.path]: !prev[tab.path] }));
  }, [tabs, activeIndex]);

  const toggleHtmlPreview = useCallback(() => {
    const tab = tabs[activeIndex];
    if (!tab) return;
    // If user switches to source view for HTML, lazy-fetch content (first time only).
    // Use /preview/ endpoint (no 100KB limit) since HTML files can easily be larger.
    const goingToSource = htmlPreviewTabs[tab.path] !== false; // default true, so toggling goes to source
    setHtmlPreviewTabs(prev => ({ ...prev, [tab.path]: !(prev[tab.path] ?? true) }));
    if (goingToSource && !tab.content && !tab.loading) {
      setTabs(prev => prev.map(t => t.path === tab.path ? { ...t, loading: true } : t));
      fetch(`/preview${tab.path}`)
        .then(r => r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)))
        .then(content => {
          setTabs(prev => prev.map(t => t.path === tab.path ? { ...t, content, originalContent: content, loading: false } : t));
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          setTabs(prev => prev.map(t => t.path === tab.path ? { ...t, content: `Error: ${message}`, originalContent: '', loading: false } : t));
        });
    }
  }, [tabs, activeIndex, htmlPreviewTabs]);

  const activeTab = tabs[activeIndex];
  const activeIsMd = activeTab ? /\.(md|mdx|markdown)$/i.test(activeTab.name) : false;
  const activeMdPreview = activeTab ? !!mdPreviewTabs[activeTab.path] : false;
  const activeMediaType = activeTab ? getMediaType(activeTab.name) : 'text';
  const activeIsMedia = activeMediaType !== 'text';
  const activeIsHtml = activeTab ? isHtmlFile(activeTab.name) : false;
  const activeHtmlPreview = activeTab ? (htmlPreviewTabs[activeTab.path] ?? true) : false;

  if (tabs.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-app-text-tertiary text-[13px]">
        <div className="text-center">
          <File size={32} className="mx-auto mb-2 opacity-30" />
          <p>Select a file to view its content</p>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="editor-tabs" className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex items-center overflow-x-auto border-b border-app-border bg-app-hover dark:bg-app-panel flex-shrink-0">
        {tabs.map((tab, i) => {
          const isActive = i === activeIndex;
          const isModified = tab.content !== tab.originalContent;
          const status = saveStatus[tab.path];
          return (
            <div
              key={tab.path}
              onClick={() => setActiveIndex(i)}
              onDoubleClick={() => { if (tab.preview) pinTab(tab.path); }}
              onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(i); } }}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-[12px] cursor-pointer border-r border-app-border max-w-[180px] group select-none ${
                isActive
                  ? 'bg-surface text-app-text border-b-2 border-b-primary'
                  : 'text-app-text-muted hover:bg-app-hover'
              }`}
            >
              <span className="flex items-center justify-center w-3.5 h-3.5 flex-shrink-0">{(() => { const d = getFileIconDef(tab.name); const I = d.icon; return <I size={12} style={{ color: d.color }} />; })()}</span>
              <span className={`truncate ${tab.preview ? 'italic' : ''}`}>{tab.name}</span>
              {isModified && <span className="w-2 h-2 rounded-full bg-primary flex-shrink-0" title="Unsaved changes" />}
              {status === 'saved' && <span className="text-[11px] text-green-500 flex-shrink-0">✓</span>}
              {status === 'error' && <span className="text-[11px] text-red-500 flex-shrink-0">!</span>}
              <button
                onClick={(e) => closeTab(i, e)}
                className="ml-auto p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-black/10 dark:hover:bg-white/10 flex-shrink-0 transition-opacity"
              >
                <X size={10} />
              </button>
            </div>
          );
        })}
      </div>

      {/* Breadcrumb path bar */}
      {activeTab && (
        <BreadcrumbNav filePath={activeTab.path} projectPath={projectPath} openFile={openFile} actions={
          <>
            {!activeIsMedia && !activeMdPreview && !(activeIsHtml && activeHtmlPreview) && <span className="text-[11px] text-app-text-muted tabular-nums">Ln {cursorPos.line}, Col {cursorPos.col}</span>}
            {!activeIsMedia && !(activeIsHtml && activeHtmlPreview) && <WrapBtn active={wordWrap} onClick={toggleWrap} />}
            {activeIsMd && <PreviewBtn previewing={activeMdPreview} onClick={togglePreview} />}
            {activeIsHtml && <PreviewBtn previewing={activeHtmlPreview} onClick={toggleHtmlPreview} label="HTML" />}
            <CopyPathBtn filePath={activeTab.path} projectPath={projectPath} />
          </>
        } />
      )}

      {/* Editor */}
      <div className="flex-1 overflow-hidden">
        {activeTab?.loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="w-4 h-4 border-2 border-app-spinner border-t-primary rounded-full animate-spin" />
          </div>
        ) : activeTab && activeIsHtml && activeHtmlPreview ? (
          <HtmlPreview filePath={activeTab.path} filename={activeTab.name} />
        ) : activeTab && activeIsMedia ? (
          <MediaViewer filePath={activeTab.path} mediaType={activeMediaType} filename={activeTab.name} />
        ) : activeTab && activeMdPreview && activeIsMd ? (
          <div className="h-full overflow-auto px-6 py-4 prose dark:prose-invert prose-sm max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {activeTab.content}
            </ReactMarkdown>
          </div>
        ) : activeTab ? (
          <Suspense fallback={<div className="flex items-center justify-center h-full"><div className="w-4 h-4 border-2 border-app-spinner border-t-primary rounded-full animate-spin" /></div>}>
            <CodeEditor
              content={activeTab.content}
              filename={activeTab.name}
              readOnly={false}
              darkMode={darkMode}
              onSave={handleSave}
              onChange={(c) => handleContentChange(activeTab.path, c)}
              initialLine={activeTab.lineNumber}
              wordWrap={wordWrap}
              onCursorChange={(l, c) => setCursorPos(prev => prev.line === l && prev.col === c ? prev : { line: l, col: c })}
            />
          </Suspense>
        ) : null}
      </div>
    </div>
  );
});

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

function PreviewBtn({ previewing, onClick, label = 'Markdown' }: { previewing: boolean; onClick: () => void; label?: string }) {
  return (
    <button onClick={onClick} title={previewing ? 'Show Source' : `Preview ${label}`} className={`p-0.5 rounded hover:bg-app-hover transition-colors ${previewing ? 'text-primary' : 'text-app-text-muted'}`}>
      {previewing ? <Code size={13} /> : <Eye size={13} />}
    </button>
  );
}

// Expose imperative open method via ref-like pattern
export type EditorTabsHandle = {
  openFile: (path: string, name: string, lineNumber?: number, preview?: boolean) => void;
  pinTab: (path: string) => void;
};
