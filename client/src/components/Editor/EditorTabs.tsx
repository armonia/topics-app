import { useState, useEffect, useCallback, useImperativeHandle, forwardRef, lazy, Suspense } from 'react';
import { X, File } from 'lucide-react';
import { filesApi } from '../../lib/api';
import { getFileIcon } from '../../lib/fileIcons';

const CodeEditor = lazy(() => import('./CodeEditor').then(m => ({ default: m.CodeEditor })));

export interface TabInfo {
  path: string;
  name: string;
  content: string;
  originalContent: string;
  loading?: boolean;
}

interface EditorTabsProps {
  projectPath: string;
}

export const EditorTabs = forwardRef<EditorTabsHandle, EditorTabsProps>(function EditorTabs({ projectPath }, ref) {
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [darkMode, setDarkMode] = useState(false);
  const [saveStatus, setSaveStatus] = useState<Record<string, 'saved' | 'error'>>({});

  useEffect(() => {
    const check = () => setDarkMode(document.documentElement.classList.contains('dark'));
    check();
    const obs = new MutationObserver(check);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  const openFile = useCallback((path: string, name: string) => {
    setTabs(prev => {
      const existing = prev.findIndex(t => t.path === path);
      if (existing >= 0) {
        setActiveIndex(existing);
        return prev;
      }
      const newTab: TabInfo = { path, name, content: '', originalContent: '', loading: true };
      setActiveIndex(prev.length);
      // Load content async
      filesApi.content(path).then(content => {
        setTabs(t => t.map(tab => tab.path === path ? { ...tab, content, originalContent: content, loading: false } : tab));
      }).catch((err: any) => {
        setTabs(t => t.map(tab => tab.path === path ? { ...tab, content: `Error: ${err.message}`, originalContent: '', loading: false } : tab));
      });
      return [...prev, newTab];
    });
  }, []);

  useImperativeHandle(ref, () => ({ openFile }), [openFile]);

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
    setTabs(prev => prev.map(t => t.path === path ? { ...t, content: newContent } : t));
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

  const activeTab = tabs[activeIndex];

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
    <div className="flex flex-col h-full">
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
              className={`flex items-center gap-1.5 px-3 py-1.5 text-[12px] cursor-pointer border-r border-app-border max-w-[180px] group select-none ${
                isActive
                  ? 'bg-surface text-app-text border-b-2 border-b-primary'
                  : 'text-app-text-muted hover:bg-app-hover'
              }`}
            >
              <span className="text-[11px] flex-shrink-0">{getFileIcon(tab.name)}</span>
              <span className="truncate">{tab.name}</span>
              {isModified && <span className="w-2 h-2 rounded-full bg-primary flex-shrink-0" title="Unsaved changes" />}
              {status === 'saved' && <span className="text-[10px] text-green-500 flex-shrink-0">✓</span>}
              {status === 'error' && <span className="text-[10px] text-red-500 flex-shrink-0">!</span>}
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

      {/* File path bar */}
      {activeTab && (
        <div className="flex items-center px-3 py-1 border-b border-app-border bg-elevated dark:bg-app-panel flex-shrink-0">
          <span className="text-[11px] text-app-text-muted truncate">
            {activeTab.path.replace(projectPath, '').replace(/^\//, '')}
          </span>
        </div>
      )}

      {/* Editor */}
      <div className="flex-1 overflow-hidden">
        {activeTab?.loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="w-4 h-4 border-2 border-app-spinner border-t-primary rounded-full animate-spin" />
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
            />
          </Suspense>
        ) : null}
      </div>
    </div>
  );
});

// Expose imperative open method via ref-like pattern
export type EditorTabsHandle = {
  openFile: (path: string, name: string) => void;
};
