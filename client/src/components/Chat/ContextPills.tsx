import { X, BookOpen, Braces, FileText } from 'lucide-react';
import { useT } from '@/hooks/useT';

interface ContextFile {
  name: string;
  path: string;
  tokens?: number;
  type: 'claude' | 'context' | 'mention';
}

interface ContextPillsProps {
  files: ContextFile[];
  onRemove?: (path: string) => void;
  onToggle?: (path: string, active: boolean) => void;
  excludedPaths?: Set<string>;
  compact?: boolean;
}

export function ContextPills({ files, onRemove, onToggle, excludedPaths, compact = false }: ContextPillsProps) {
  if (files.length === 0) return null;

  return (
    <div data-testid="context-pills" className={`flex items-center gap-1.5 overflow-x-auto scrollbar-hide ${compact ? '' : 'px-3 py-1.5 border-t border-app-border'}`}>
      {!compact && (
        <span className="text-[11px] text-app-text-muted font-medium mr-0.5 flex-shrink-0">Context</span>
      )}
      {files.map(file => (
        <ContextPill
          key={file.path}
          file={file}
          excluded={excludedPaths?.has(file.path) ?? false}
          onToggle={onToggle ? () => onToggle(file.path, !!excludedPaths?.has(file.path)) : undefined}
          onRemove={onRemove ? () => onRemove(file.path) : undefined}
        />
      ))}
    </div>
  );
}

function ContextPill({ file, excluded, onToggle, onRemove }: {
  file: ContextFile;
  excluded: boolean;
  onToggle?: () => void;
  onRemove?: () => void;
}) {
  const tr = useT();
  const activeStyles = {
    claude: 'bg-purple-50 dark:bg-purple-900/20 border-purple-200/60 dark:border-purple-800/30 text-purple-600 dark:text-purple-400',
    context: 'bg-blue-50 dark:bg-blue-900/20 border-blue-200/60 dark:border-blue-800/30 text-blue-600 dark:text-blue-400',
    mention: 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200/60 dark:border-emerald-800/30 text-emerald-600 dark:text-emerald-400',
  };

  const excludedStyle = 'bg-app-hover border-app-border-light/60 text-app-text-muted opacity-60';

  const icon = file.type === 'claude'
    ? <Braces size={10} />
    : file.type === 'context'
    ? <BookOpen size={10} />
    : <FileText size={10} />;

  return (
    <span
      data-testid="context-pill"
      className={`context-pill inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[11px] font-medium flex-shrink-0 transition-all ${
        excluded ? excludedStyle : activeStyles[file.type]
      } ${onToggle ? 'cursor-pointer hover:brightness-95 dark:hover:brightness-110' : ''}`}
      onClick={onToggle}
      title={`${file.path}${file.tokens ? ` (~${file.tokens} tokens)` : ''}${excluded ? ' (excluded)' : ''}`}
    >
      {icon}
      <span className="truncate max-w-[100px]">{file.name}</span>
      {file.tokens != null && file.tokens > 0 && (
        <span className="text-[11px] opacity-60 flex-shrink-0">
          {file.tokens >= 1000 ? `${(file.tokens / 1000).toFixed(1)}k` : `${file.tokens}`}
        </span>
      )}
      {onRemove && (
        <button aria-label={tr('ctx.removeFromContext')}
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="ml-0.5 opacity-40 hover:opacity-100 transition-opacity flex-shrink-0"
        >
          <X size={10} />
        </button>
      )}
    </span>
  );
}
