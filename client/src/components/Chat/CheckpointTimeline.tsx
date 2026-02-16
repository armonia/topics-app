import { useState, useEffect, useCallback } from 'react';
import { Clock, RotateCcw, Plus } from 'lucide-react';
import { useCheckpoints, type Checkpoint } from '../../hooks/useCheckpoints';

interface CheckpointTimelineProps {
  topicId: string;
  onRollback?: () => void;
}

function formatTimeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function CheckpointTimeline({ topicId, onRollback }: CheckpointTimelineProps) {
  const { checkpoints, loading: _loading, error, load, create, rollback } = useCheckpoints(topicId);
  const [expanded, setExpanded] = useState(false);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [rollingBack, setRollingBack] = useState(false);

  useEffect(() => { load(); }, [load]);

  const handleCreate = useCallback(async () => {
    await create();
  }, [create]);

  const handleRollback = useCallback(async (checkpoint: Checkpoint) => {
    const confirmed = window.confirm(
      `Roll back to "${checkpoint.description}"?\n\nThis will truncate messages to ${checkpoint.messageCount} and remove later checkpoints.${checkpoint.gitHash ? '\n\nGit will be checked out to ' + checkpoint.gitHash.slice(0, 7) + '.' : ''}`
    );
    if (!confirmed) return;

    setRollingBack(true);
    const result = await rollback(checkpoint.idx);
    setRollingBack(false);

    if (result.ok) {
      if (result.warning) {
        alert(`Rolled back successfully.\nNote: ${result.warning}`);
      }
      onRollback?.();
    } else {
      alert(`Rollback failed: ${result.warning || 'Unknown error'}`);
    }
  }, [rollback, onRollback]);

  if (checkpoints.length === 0) return null;

  return (
    <div className="border-t border-app-border">
      {/* Compact bar */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-app-text-tertiary hover:bg-app-hover transition-colors"
      >
        <Clock size={12} />
        <span>{checkpoints.length} checkpoint{checkpoints.length !== 1 ? 's' : ''}</span>
        {/* Timeline dots */}
        {checkpoints.length > 0 && (
          <div className="flex items-center gap-1 ml-1">
            {checkpoints.slice(-8).map((cp) => (
              <div
                key={cp.idx}
                className={`w-1.5 h-1.5 rounded-full ${cp.gitHash ? 'bg-primary' : 'bg-app-placeholder'}`}
                title={cp.description}
              />
            ))}
          </div>
        )}
        <span className="ml-auto text-[10px]">{expanded ? 'Hide' : 'Show'}</span>
      </button>

      {/* Expanded timeline */}
      {expanded && (
        <div className="px-3 py-2 border-t border-app-border bg-surface max-h-[200px] overflow-y-auto">
          {error && <p className="text-red-500 text-[11px] mb-2">{error}</p>}

          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-medium text-app-text-secondary">Checkpoints</span>
            <button
              onClick={handleCreate}
              className="flex items-center gap-1 text-[11px] text-primary hover:underline"
            >
              <Plus size={10} />
              Save
            </button>
          </div>

          {checkpoints.length === 0 ? (
            <p className="text-[11px] text-app-placeholder py-2 text-center">
              No checkpoints yet. Create one to save conversation state.
            </p>
          ) : (
            <div className="space-y-1">
              {checkpoints.map((cp) => (
                <div
                  key={cp.idx}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] transition-colors ${
                    hoveredIdx === cp.idx ? 'bg-app-hover' : ''
                  }`}
                  onMouseEnter={() => setHoveredIdx(cp.idx)}
                  onMouseLeave={() => setHoveredIdx(null)}
                >
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${cp.gitHash ? 'bg-primary' : 'bg-app-placeholder'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-app-text truncate">{cp.description}</div>
                    <div className="text-[10px] text-app-placeholder">
                      {formatTimeAgo(cp.timestamp)} - {cp.messageCount} msgs
                      {cp.gitHash && <span className="ml-1 text-primary">{cp.gitHash.slice(0, 7)}</span>}
                    </div>
                  </div>
                  {hoveredIdx === cp.idx && (
                    <button
                      onClick={() => handleRollback(cp)}
                      disabled={rollingBack}
                      className="p-1 rounded hover:bg-amber-100 dark:hover:bg-amber-900/30 text-app-text-tertiary hover:text-amber-600 transition-colors disabled:opacity-40"
                      title="Roll back to this checkpoint"
                    >
                      <RotateCcw size={12} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
