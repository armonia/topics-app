import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import type { ContextWarning } from '../../lib/api';

interface ContextWarningsProps {
  warnings: ContextWarning[];
}

export function ContextWarnings({ warnings }: ContextWarningsProps) {
  const [expanded, setExpanded] = useState(false);

  if (warnings.length === 0) return null;

  return (
    <div data-testid="context-warnings" className="border-b border-app-border">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-app-hover transition-colors"
      >
        <AlertTriangle size={14} className="text-amber-500 flex-shrink-0" />
        <span className="text-[12px] font-medium text-amber-600 dark:text-amber-400">
          {warnings.length} warning{warnings.length !== 1 ? 's' : ''}
        </span>
        <div className="flex-1" />
        {expanded ? <ChevronDown size={14} className="text-app-text-tertiary" /> : <ChevronRight size={14} className="text-app-text-tertiary" />}
      </button>
      {expanded && (
        <div className="px-4 pb-2 space-y-1">
          {warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-2 text-[11px] text-app-text-secondary">
              <span className="text-amber-500 mt-0.5">
                {w.type === 'budget' ? '!' : w.type === 'large-source' ? '~' : '?'}
              </span>
              <span>{w.detail}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
