import { ShieldAlert } from 'lucide-react';
import type { Approval } from '../../lib/api';

interface ApprovalBannerProps {
  approval: Approval;
  onReview?: (approvalId: string) => void;
}

export function ApprovalBanner({ approval, onReview }: ApprovalBannerProps) {
  if (approval.status !== 'pending') return null;

  return (
    <div className="flex items-center gap-1.5 px-2 py-1 bg-yellow-500/10 border border-yellow-500/20 rounded text-[10px]">
      <ShieldAlert size={12} className="text-yellow-500 flex-shrink-0" />
      <span className="text-yellow-600 dark:text-yellow-400 flex-1">
        Approval required
        {approval.toStatus && <> to move to <strong>{approval.toStatus}</strong></>}
      </span>
      {approval.confidenceScore !== null && (
        <span className="text-app-text-muted">
          {Math.round(approval.confidenceScore * 100)}% confidence
        </span>
      )}
      {onReview && (
        <button
          onClick={() => onReview(approval.id)}
          className="text-primary hover:text-primary/80 font-medium"
        >
          Review
        </button>
      )}
    </div>
  );
}
