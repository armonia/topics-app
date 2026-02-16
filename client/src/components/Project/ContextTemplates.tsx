import { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronRight, FileText, Check, X } from 'lucide-react';
import { contextTemplatesApi, type ContextTemplateFile } from '../../lib/api';

interface ContextTemplatesProps {
  topicId: string;
  projectPath: string;
}

const COLLAPSE_KEY = 'topics-context-templates-collapsed';

export function ContextTemplates({ topicId, projectPath }: ContextTemplatesProps) {
  const [files, setFiles] = useState<ContextTemplateFile[]>([]);
  const [, setTotalTokens] = useState(0);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [disabledFiles, setDisabledFiles] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    contextTemplatesApi.getForTopic(topicId)
      .then(data => {
        if (cancelled) return;
        setFiles(data.files);
        setTotalTokens(data.totalTokenEstimate);
      })
      .catch(() => {
        if (cancelled) return;
        setFiles([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [topicId, projectPath]);

  // Load disabled state from server (via topic metadata)
  useEffect(() => {
    // We'll get this from the context-templates endpoint in the future
    // For now, start with all enabled (empty set)
    setDisabledFiles(new Set());
  }, [topicId]);

  const toggleCollapse = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem(COLLAPSE_KEY, String(next)); } catch {}
      return next;
    });
  }, []);

  const toggleFile = useCallback((fileName: string) => {
    setDisabledFiles(prev => {
      const next = new Set(prev);
      if (next.has(fileName)) {
        next.delete(fileName);
      } else {
        next.add(fileName);
      }
      // Sync to server
      contextTemplatesApi.setDisabled(topicId, [...next]).catch(console.warn);
      return next;
    });
  }, [topicId]);

  const enabledTokens = files
    .filter(f => !disabledFiles.has(f.name))
    .reduce((sum, f) => sum + f.tokenEstimate, 0);

  if (loading) {
    return (
      <div className="border-b border-app-border">
        <div className="px-2 py-1.5 text-[11px] text-app-text-muted">Loading context...</div>
      </div>
    );
  }

  if (files.length === 0) return null;

  return (
    <div className="border-b border-app-border">
      {/* Header */}
      <button
        onClick={toggleCollapse}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-[11px] font-medium text-app-text-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        <FileText size={13} />
        <span>Context <span className="font-normal text-[10px] text-app-text-muted">(auto)</span></span>
        <span className="ml-auto text-[10px] text-app-text-muted font-normal">
          ~{enabledTokens.toLocaleString()} tokens
        </span>
      </button>

      {/* File list */}
      {!collapsed && (
        <div className="px-2 pb-2">
          {files.map(file => {
            const enabled = !disabledFiles.has(file.name);
            return (
              <div
                key={file.name}
                className="flex items-center gap-2 py-1 px-1 rounded hover:bg-black/3 dark:hover:bg-white/3 group"
              >
                <button
                  onClick={() => toggleFile(file.name)}
                  className={`flex-shrink-0 w-4 h-4 rounded-sm border flex items-center justify-center transition-colors ${
                    enabled
                      ? 'bg-primary/10 border-primary/30 text-primary'
                      : 'border-app-border-input text-transparent'
                  }`}
                  title={enabled ? 'Click to exclude from context' : 'Click to include in context'}
                >
                  {enabled ? <Check size={10} strokeWidth={3} /> : <X size={10} />}
                </button>
                <FileText size={12} className={`flex-shrink-0 ${enabled ? 'text-app-text-secondary' : 'text-app-spinner'}`} />
                <span className={`text-[11px] truncate flex-1 ${
                  enabled ? 'text-app-text-heading' : 'text-app-text-faint line-through'
                }`}>
                  {file.name}
                </span>
                <span className={`text-[10px] flex-shrink-0 ${
                  enabled ? 'text-app-text-muted' : 'text-app-spinner'
                }`}>
                  ~{file.tokenEstimate.toLocaleString()}
                </span>
              </div>
            );
          })}
          <div className="text-[10px] text-app-text-faint mt-1 px-1">
            Auto-included from project • {files.length} files
          </div>
        </div>
      )}
    </div>
  );
}
