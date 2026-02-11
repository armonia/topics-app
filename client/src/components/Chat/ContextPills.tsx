import { useState, useEffect } from 'react';
import { X, BookOpen, Braces, FileText } from 'lucide-react';

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
    <div className={`flex items-center gap-1.5 overflow-x-auto scrollbar-hide ${compact ? '' : 'px-3 py-1.5 border-t border-[#f0f0f0] dark:border-[#222]'}`}>
      {!compact && (
        <span className="text-[10px] text-[#888] dark:text-[#666] font-medium mr-0.5 flex-shrink-0">Context</span>
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
  const activeStyles = {
    claude: 'bg-purple-50 dark:bg-purple-900/20 border-purple-200/60 dark:border-purple-800/30 text-purple-600 dark:text-purple-400',
    context: 'bg-blue-50 dark:bg-blue-900/20 border-blue-200/60 dark:border-blue-800/30 text-blue-600 dark:text-blue-400',
    mention: 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200/60 dark:border-emerald-800/30 text-emerald-600 dark:text-emerald-400',
  };

  const excludedStyle = 'bg-gray-100 dark:bg-gray-800/30 border-gray-200/60 dark:border-gray-700/30 text-gray-400 dark:text-gray-500 opacity-60';

  const icon = file.type === 'claude'
    ? <Braces size={10} />
    : file.type === 'context'
    ? <BookOpen size={10} />
    : <FileText size={10} />;

  return (
    <span
      className={`context-pill inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-medium flex-shrink-0 transition-all ${
        excluded ? excludedStyle : activeStyles[file.type]
      } ${onToggle ? 'cursor-pointer hover:brightness-95 dark:hover:brightness-110' : ''}`}
      onClick={onToggle}
      title={`${file.path}${file.tokens ? ` (~${file.tokens} tokens)` : ''}${excluded ? ' (excluded)' : ''}`}
    >
      {icon}
      <span className="truncate max-w-[100px]">{file.name}</span>
      {file.tokens != null && file.tokens > 0 && (
        <span className="text-[9px] opacity-60 flex-shrink-0">
          {file.tokens >= 1000 ? `${(file.tokens / 1000).toFixed(1)}k` : `${file.tokens}`}
        </span>
      )}
      {onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="ml-0.5 opacity-40 hover:opacity-100 transition-opacity flex-shrink-0"
        >
          <X size={10} />
        </button>
      )}
    </span>
  );
}

/** Hook to fetch token estimates for context files */
export function useContextFileTokens(sessionKey: string, filePaths: string[]): Map<string, number> {
  const [tokenMap, setTokenMap] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    if (!filePaths.length) { setTokenMap(new Map()); return; }

    fetch(`/api/context?sessionKey=${encodeURIComponent(sessionKey)}`)
      .then(r => r.json())
      .then((data: any) => {
        const map = new Map<string, number>();
        // Try to extract per-file tokens from breakdown description
        const contextBreakdown = data.breakdown?.find((b: any) =>
          b.label === 'Context files' && b.description
        );
        if (contextBreakdown?.description) {
          const parts = contextBreakdown.description.split(', ');
          for (const part of parts) {
            const match = part.match(/^(.+?):\s*~?(\d+)\s*tokens?$/);
            if (match) {
              const fname = match[1];
              const tokens = parseInt(match[2], 10);
              const matchingPath = filePaths.find(p => p.endsWith(fname) || p.split('/').pop() === fname);
              if (matchingPath) map.set(matchingPath, tokens);
            }
          }
        }
        // Fallback: distribute evenly if no per-file info
        if (map.size === 0 && contextBreakdown?.tokens && filePaths.length > 0) {
          const perFile = Math.round(contextBreakdown.tokens / filePaths.length);
          for (const p of filePaths) map.set(p, perFile);
        }
        setTokenMap(map);
      })
      .catch(() => {});
  }, [sessionKey, filePaths.join(',')]);

  return tokenMap;
}
