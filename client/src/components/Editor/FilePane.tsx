import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { filesApi } from '../../lib/api';
import { getFileIcon } from '../../lib/fileIcons';

const CodeEditor = lazy(() => import('./CodeEditor').then(m => ({ default: m.CodeEditor })));

interface FilePaneProps {
  filePath: string;
  projectPath: string;
}

export function FilePane({ filePath, projectPath }: FilePaneProps) {
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [darkMode, setDarkMode] = useState(false);

  const filename = filePath.split('/').pop() || filePath;
  const relativePath = filePath.replace(projectPath, '').replace(/^\//, '');

  // Dark mode observer
  useEffect(() => {
    const check = () => setDarkMode(document.documentElement.classList.contains('dark'));
    check();
    const obs = new MutationObserver(check);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  // Load file content
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
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
    return () => { cancelled = true; };
  }, [filePath]);

  const handleChange = useCallback((newContent: string) => {
    setContent(newContent);
  }, []);

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

  const isModified = content !== originalContent;

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
      <div className="flex items-center gap-1.5 px-3 py-1 border-b border-app-border bg-elevated flex-shrink-0">
        <span className="text-[13px] flex-shrink-0">{getFileIcon(filename)}</span>
        <span className="text-[11px] text-app-text-muted truncate">{relativePath}</span>
        {isModified && <span className="w-2 h-2 rounded-full bg-primary flex-shrink-0 ml-auto" title="Unsaved changes" />}
        {saveStatus === 'saved' && <span className="text-[10px] text-green-500 flex-shrink-0 ml-auto">Saved</span>}
        {saveStatus === 'error' && <span className="text-[10px] text-red-500 flex-shrink-0 ml-auto">Save failed</span>}
      </div>

      {/* Editor */}
      <div className="flex-1 overflow-hidden">
        <Suspense fallback={<div className="flex items-center justify-center h-full"><div className="w-4 h-4 border-2 border-app-spinner border-t-primary rounded-full animate-spin" /></div>}>
          <CodeEditor
            content={content}
            filename={filename}
            readOnly={false}
            darkMode={darkMode}
            onSave={handleSave}
            onChange={handleChange}
          />
        </Suspense>
      </div>
    </div>
  );
}
