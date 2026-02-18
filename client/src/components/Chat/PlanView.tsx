import { useState, useMemo, memo } from 'react';
import { Check, X, Play, ClipboardList, ChevronDown, ChevronUp } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { markdownComponents } from '../MessageContent';

interface PlanStep {
  number: number;
  title: string;
  description: string;
}

function parsePlanSteps(content: string): PlanStep[] {
  const steps: PlanStep[] = [];
  // Match numbered steps like "1. **Title** — Description" or "1. **Title**: Description"
  const stepPattern = /^\d+\.\s+\*\*(.+?)\*\*\s*[—\-:]\s*(.+)/gm;
  let match;
  let num = 1;
  while ((match = stepPattern.exec(content)) !== null) {
    steps.push({
      number: num++,
      title: match[1].trim(),
      description: match[2].trim(),
    });
  }
  // Fallback: plain numbered steps without bold
  if (steps.length === 0) {
    const simplePattern = /^(\d+)\.\s+(.+)/gm;
    while ((match = simplePattern.exec(content)) !== null) {
      const text = match[2].trim();
      // Split on first dash/colon if present
      const sepIdx = text.search(/\s*[—\-:]\s/);
      if (sepIdx > 0) {
        steps.push({
          number: parseInt(match[1]),
          title: text.slice(0, sepIdx).trim(),
          description: text.slice(sepIdx + 1).replace(/^[\s—\-:]+/, '').trim(),
        });
      } else {
        steps.push({
          number: parseInt(match[1]),
          title: text,
          description: '',
        });
      }
    }
  }
  return steps;
}

export function isPlanResponse(content: string): boolean {
  if (!content) return false;
  // Check for plan header (multiple variations) + numbered steps
  const hasPlanHeader = /^##?\s+(?:(?:Implementation|Action|Execution|Development|Migration|Refactoring|Deployment)\s+)?Plan\b/mi.test(content);
  const hasNumberedSteps = (content.match(/^\d+\.\s+/gm) || []).length >= 2;
  return hasPlanHeader && hasNumberedSteps;
}

interface PlanViewProps {
  content: string;
  onApprove: () => void;
  onReject: () => void;
  isStreaming?: boolean;
}

export const PlanView = memo(function PlanView({ content, onApprove, onReject, isStreaming }: PlanViewProps) {
  const [approved, setApproved] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const steps = useMemo(() => parsePlanSteps(content), [content]);

  // Extract summary section
  const summaryMatch = content.match(/##?\s+Summary\s*\n([\s\S]*?)(?=\n##|\n\n\n|$)/i);
  const summary = summaryMatch ? summaryMatch[1].trim() : null;

  const handleApprove = () => {
    setApproved(true);
    onApprove();
  };

  const handleReject = () => {
    setRejected(true);
    onReject();
  };

  if (steps.length === 0) return null;

  return (
    <div className="plan-view my-2">
      {/* Plan header */}
      <div className="flex items-center gap-2 mb-2">
        <ClipboardList size={14} className="text-indigo-500" />
        <span className="text-[12px] font-semibold text-indigo-600 dark:text-indigo-400 uppercase tracking-wider">
          Implementation Plan
        </span>
        <span className="text-[10px] text-app-text-muted">
          {steps.length} step{steps.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Toggle button */}
      <button
        onClick={() => setExpanded(e => !e)}
        className="flex items-center gap-1 mb-2 text-[11px] font-medium text-indigo-500 hover:text-indigo-600 dark:text-indigo-400 dark:hover:text-indigo-300 transition-colors"
      >
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        {expanded ? 'Comprimi' : 'Mostra dettagli'}
      </button>

      {expanded ? (
        /* Expanded: full markdown content */
        <div className="mb-3 prose prose-sm max-w-none prose-p:my-0.5 prose-headings:my-1.5 prose-ul:my-0.5 prose-ol:my-0.5 prose-li:my-0 prose-pre:my-1.5 prose-blockquote:my-1">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {content}
          </ReactMarkdown>
        </div>
      ) : (
        <>
          {/* Compact: Steps list */}
          <div className="space-y-1.5 mb-3">
            {steps.map((step) => (
              <div
                key={step.number}
                className="flex items-start gap-2.5 p-2 rounded-lg bg-white/50 dark:bg-surface/50 border border-app-border"
              >
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 text-[10px] font-bold flex items-center justify-center mt-0.5">
                  {step.number}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-medium text-app-text">
                    {step.title}
                  </div>
                  {step.description && (
                    <div className="text-[11px] text-app-text-secondary mt-0.5">
                      {step.description}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Summary */}
          {summary && (
            <div className="text-[11px] text-app-text-secondary mb-3 px-2 py-1.5 bg-app-inset dark:bg-app-panel rounded border-l-2 border-indigo-300 dark:border-indigo-700">
              {summary}
            </div>
          )}
        </>
      )}

      {/* Streaming indicator */}
      {isStreaming && (
        <div className="flex items-center gap-2 mb-3 py-1.5 px-2 rounded-lg bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800">
          <div className="w-3 h-3 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-[11px] text-indigo-600 dark:text-indigo-400 font-medium">
            Plan streaming... ({steps.length} step{steps.length !== 1 ? 's' : ''} so far)
          </span>
        </div>
      )}

      {/* Action buttons */}
      {!isStreaming && !approved && !rejected && (
        <div className="flex items-center gap-2">
          <button
            onClick={handleApprove}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 transition-colors"
          >
            <Play size={12} />
            Execute Plan
          </button>
          <button
            onClick={handleReject}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium bg-app-hover text-app-text-secondary rounded-lg hover:bg-app-hover transition-colors"
          >
            <X size={12} />
            Reject
          </button>
        </div>
      )}

      {/* Status indicators */}
      {approved && (
        <div className="flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
          <Check size={13} />
          Plan approved — executing...
        </div>
      )}
      {rejected && (
        <div className="flex items-center gap-1.5 text-[11px] text-app-text-muted">
          <X size={13} />
          Plan rejected
        </div>
      )}
    </div>
  );
});
