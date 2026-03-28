import { useState, useEffect } from 'react';
import { X, ShieldCheck, ShieldX, BarChart3 } from 'lucide-react';
import type { Approval } from '../../lib/api';

interface ApprovalReviewModalProps {
  approval: Approval;
  onApprove: (id: string, comment?: string) => void;
  onReject: (id: string, comment?: string) => void;
  onClose: () => void;
}

export function ApprovalReviewModal({ approval, onApprove, onReject, onClose }: ApprovalReviewModalProps) {
  const [comment, setComment] = useState('');

  // Escape key to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div data-testid="approval-review-modal" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-surface border border-app-border rounded-lg shadow-xl w-[400px] max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-app-border">
          <ShieldCheck size={16} className="text-primary" />
          <span className="text-[13px] font-semibold text-app-text flex-1">Review Approval</span>
          <button onClick={onClose} className="text-app-text-muted hover:text-app-text">
            <X size={14} />
          </button>
        </div>

        {/* Content */}
        <div className="px-4 py-3 space-y-3 overflow-y-auto">
          {/* Task info */}
          <div>
            <div className="text-[10px] text-app-text-muted uppercase tracking-wider mb-0.5">Task</div>
            <div className="text-[12px] text-app-text font-medium">{approval.taskText || approval.taskId}</div>
          </div>

          {/* Transition */}
          {approval.fromStatus && approval.toStatus && (
            <div>
              <div className="text-[10px] text-app-text-muted uppercase tracking-wider mb-0.5">Status Change</div>
              <div className="text-[11px] text-app-text">
                {approval.fromStatus} &rarr; <strong>{approval.toStatus}</strong>
              </div>
            </div>
          )}

          {/* Confidence */}
          {approval.confidenceScore !== null && (
            <div>
              <div className="text-[10px] text-app-text-muted uppercase tracking-wider mb-0.5">Confidence</div>
              <div className="flex items-center gap-2">
                {(() => {
                  const pct = Math.round(approval.confidenceScore);
                  return (
                    <>
                      <div className="flex-1 bg-black/10 dark:bg-white/10 rounded-full h-1.5">
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-[11px] text-app-text font-medium">
                        {pct}%
                      </span>
                    </>
                  );
                })()}
              </div>
            </div>
          )}

          {/* Rubric scores */}
          {approval.rubricScores && Object.keys(approval.rubricScores).length > 0 && (
            <div>
              <div className="flex items-center gap-1 text-[10px] text-app-text-muted uppercase tracking-wider mb-1">
                <BarChart3 size={10} />
                <span>Rubric Scores</span>
              </div>
              <div className="space-y-1">
                {Object.entries(approval.rubricScores).map(([key, value]) => (
                  <div key={key} className="flex items-center gap-2 text-[11px]">
                    <span className="text-app-text-muted flex-1">{key}</span>
                    <span className="text-app-text font-medium">{value}/5</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Justification */}
          {approval.justification && (
            <div>
              <div className="text-[10px] text-app-text-muted uppercase tracking-wider mb-0.5">Justification</div>
              <div className="text-[11px] text-app-text bg-black/3 dark:bg-white/3 rounded px-2 py-1.5 whitespace-pre-wrap">
                {approval.justification}
              </div>
            </div>
          )}

          {/* Review comment */}
          <div>
            <div className="text-[10px] text-app-text-muted uppercase tracking-wider mb-0.5">Comment (optional)</div>
            <textarea
              value={comment}
              onChange={e => setComment(e.target.value)}
              placeholder="Add a review comment..."
              className="w-full text-[11px] bg-surface border border-app-border rounded px-2 py-1.5 focus:outline-none focus:border-primary text-app-text placeholder-app-placeholder resize-none min-h-[60px]"
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 px-4 py-3 border-t border-app-border">
          <div className="text-[9px] text-app-text-muted flex-1">
            Requested by {approval.requestedBy} &middot; {new Date(approval.createdAt).toLocaleString()}
            {approval.expiresAt && (
              <> &middot; Expires {new Date(approval.expiresAt).toLocaleString()}</>
            )}
          </div>
          <button
            onClick={() => onReject(approval.id, comment || undefined)}
            className="flex items-center gap-1 text-[11px] px-3 py-1.5 rounded border border-red-500/30 text-red-500 hover:bg-red-500/10 transition-colors"
          >
            <ShieldX size={12} />
            Reject
          </button>
          <button
            onClick={() => onApprove(approval.id, comment || undefined)}
            className="flex items-center gap-1 text-[11px] px-3 py-1.5 rounded bg-primary text-white hover:opacity-90 transition-opacity"
          >
            <ShieldCheck size={12} />
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
