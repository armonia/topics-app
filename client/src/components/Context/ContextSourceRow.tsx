import { useState, useRef, useEffect } from 'react';
import { ChevronRight, ChevronDown, Eye, EyeOff, Edit3, Save, X, FolderTree } from 'lucide-react';
import type { ContextSource } from '../../lib/api';

const CATEGORY_ICONS: Record<string, string> = {
  openclaw: '\u{1F535}',  // blue circle
  memory: '\u{1F7E3}',    // purple circle
  prompt: '\u{2728}',     // sparkles
  template: '\u{1F4C4}',  // page
  file: '\u{1F4CE}',      // paperclip
  pinned: '\u{1F4CC}',    // pushpin
};

const CATEGORY_COLORS: Record<string, string> = {
  openclaw: '#3b82f6',
  memory: '#8b5cf6',
  prompt: '#f59e0b',
  template: '#22c55e',
  file: '#ef4444',
  pinned: '#06b6d4',
};

interface ContextSourceRowProps {
  source: ContextSource;
  onToggle?: (id: string, enabled: boolean) => void;
  onEdit?: (id: string, content: string) => void;
  onBrowseMemory?: () => void;
}

export function ContextSourceRow({ source, onToggle, onEdit, onBrowseMemory }: ContextSourceRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [editing]);

  const formatTokens = (n: number) => {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return n.toString();
  };

  const icon = CATEGORY_ICONS[source.category] || '\u{2753}';
  const color = CATEGORY_COLORS[source.category] || '#6b7280';
  const isOpenClawMemoryTree = source.id === 'openclaw:memory-tree';

  const handleStartEdit = () => {
    setEditContent(source.preview || '');
    setEditing(true);
    setExpanded(true);
  };

  const handleSaveEdit = () => {
    onEdit?.(source.id, editContent);
    setEditing(false);
  };

  const handleCancelEdit = () => {
    setEditing(false);
  };

  return (
    <div data-testid="context-source-row" className={`border-b border-app-border last:border-b-0 transition-colors ${!source.enabled ? 'opacity-50' : ''}`}>
      {/* Row header */}
      <div className="flex items-center gap-2 px-4 py-2 hover:bg-app-hover/50 transition-colors">
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-4 h-4 flex items-center justify-center text-app-text-tertiary flex-shrink-0"
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <span className="text-[13px] leading-none flex-shrink-0">{icon}</span>
        <span className="text-[12px] text-app-text truncate flex-1 min-w-0">{source.label}</span>

        {/* Token count */}
        <span className="text-[10px] text-app-text-muted tabular-nums flex-shrink-0">
          ~{formatTokens(source.tokens)} tok
          {!source.countInBudget && <span className="ml-1 text-app-text-muted italic">(archive)</span>}
        </span>

        {/* Memory tree browse button */}
        {isOpenClawMemoryTree && onBrowseMemory && (
          <button
            onClick={(e) => { e.stopPropagation(); onBrowseMemory(); }}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-app-hover text-app-text-tertiary hover:text-primary transition-colors flex-shrink-0"
            title="Browse memory tree"
          >
            <FolderTree size={12} />
          </button>
        )}

        {/* Edit button */}
        {source.editable && !editing && (
          <button
            onClick={(e) => { e.stopPropagation(); handleStartEdit(); }}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-app-hover text-app-text-tertiary hover:text-primary transition-colors flex-shrink-0"
            title="Edit"
          >
            <Edit3 size={12} />
          </button>
        )}

        {/* Toggle */}
        {onToggle && source.category !== 'openclaw' && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggle(source.id, !source.enabled); }}
            className={`w-6 h-6 flex items-center justify-center rounded transition-colors flex-shrink-0 ${
              source.enabled
                ? 'text-primary hover:bg-primary/10'
                : 'text-app-text-muted hover:bg-app-hover'
            }`}
            title={source.enabled ? 'Disable this source' : 'Enable this source'}
          >
            {source.enabled ? <Eye size={12} /> : <EyeOff size={12} />}
          </button>
        )}
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="px-4 pb-3 pl-10">
          {editing ? (
            <div className="space-y-2">
              <textarea
                ref={textareaRef}
                value={editContent}
                onChange={e => setEditContent(e.target.value)}
                className="w-full px-2 py-1.5 border border-app-border-light rounded text-[11px] bg-surface dark:bg-elevated text-app-text font-mono resize-y min-h-[80px] focus:outline-none focus:ring-1 focus:ring-primary"
                rows={6}
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={handleSaveEdit}
                  className="flex items-center gap-1 px-2 py-1 text-[11px] bg-primary text-white rounded hover:bg-primary-hover transition-colors"
                >
                  <Save size={10} /> Save
                </button>
                <button
                  onClick={handleCancelEdit}
                  className="flex items-center gap-1 px-2 py-1 text-[11px] text-app-text-secondary hover:bg-app-hover rounded transition-colors"
                >
                  <X size={10} /> Cancel
                </button>
              </div>
            </div>
          ) : source.preview ? (
            <div className="text-[11px] text-app-text-secondary font-mono whitespace-pre-wrap break-words line-clamp-6 bg-black/3 dark:bg-white/3 rounded p-2">
              {source.preview}
            </div>
          ) : (
            <div className="text-[11px] text-app-text-muted italic">No content</div>
          )}
          {/* Color indicator bar */}
          <div className="mt-1.5 h-0.5 rounded-full" style={{ backgroundColor: color, width: '100%', opacity: 0.3 }} />
        </div>
      )}
    </div>
  );
}
