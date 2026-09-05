import { useState, useEffect, useCallback } from 'react';
import { Clock, RotateCcw, Plus } from 'lucide-react';
import { useCheckpoints, type Checkpoint } from '../../hooks/useCheckpoints';
import { useToast } from '../Shared/Toast';
import { useConfirm } from '../../hooks/useConfirm';
import { useT } from '../../hooks/useT';
import { BLOCKER_KEY, rollbackButtonState, rollbackDialogText } from './checkpointPlan';

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
  const { checkpoints, loading: _loading, error, load, create, rollback, fetchPlan, plans } = useCheckpoints(topicId);
  const [expanded, setExpanded] = useState(false);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [rollingBack, setRollingBack] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();
  const tr = useT();

  useEffect(() => { load(); }, [load]);

  const handleCreate = useCallback(async () => {
    await create();
  }, [create]);

  const handleRollback = useCallback(async (checkpoint: Checkpoint) => {
    // The dialog says what the PLAN says: how many files come back, how many
    // the chat created and will be deleted, which paths somebody else changed
    // and are left alone. It used to promise a git checkout to a hash, which
    // is not what happens any more and never quite was.
    const preflight = (await fetchPlan(checkpoint.idx)) ?? plans[checkpoint.idx] ?? null;
    const text = rollbackDialogText(checkpoint, preflight, tr);
    const confirmed = await confirm({
      title: tr('checkpoint.rollback.confirmTitle', { name: checkpoint.description }),
      confirmLabel: tr('checkpoint.rollback.confirm'),
      body: (
        <div className="space-y-2">
          {text.lines.map((line) => <p key={line}>{line}</p>)}
          {text.skippedPaths.length > 0 && (
            <ul className="font-mono text-[11px] pl-3 list-disc">
              {text.skippedPaths.map((path) => <li key={path}>{path}</li>)}
              {text.more && <li className="list-none">{text.more}</li>}
            </ul>
          )}
        </div>
      ),
    });
    if (!confirmed) return;

    setRollingBack(true);
    const result = await rollback(checkpoint.idx);
    setRollingBack(false);

    // Toast, non `alert()`: la finestra dell'app e' una WKWebView, e un dialog
    // modale nativo BLOCCA il thread della webview — cioe' congela chat in
    // streaming, terminali e pane accanto finche' non lo chiudi a mano. Un
    // esito di rollback non vale il blocco di tutta l'app.
    if (result.ok) {
      const leftAlone = result.outcome?.files?.skipped.length ?? 0;
      if (leftAlone > 0) toast.warning(tr('checkpoint.plan.skipped', { n: leftAlone }));
      else toast.success(tr('checkpoint.rollback.done'));
      onRollback?.();
    } else if (result.blockedBy) {
      toast.error(tr('checkpoint.rollback.refused', { reason: tr(BLOCKER_KEY[result.blockedBy]) }));
    } else {
      toast.error(tr('checkpoint.rollback.failed', { error: result.warning || tr('checkpoint.rollback.unknownError') }));
    }
  }, [rollback, onRollback, toast, confirm, fetchPlan, plans, tr]);

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
        <span className="ml-auto text-[11px]">{expanded ? 'Hide' : 'Show'}</span>
      </button>

      {/* Expanded timeline */}
      {expanded && (
        <div data-testid="checkpoint-panel" className="px-3 py-2 border-t border-app-border bg-surface max-h-[200px] overflow-y-auto">
          {error && <p className="text-red-500 text-[11px] mb-2">{error}</p>}

          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-medium text-app-text-secondary">Checkpoints</span>
            <button
              onClick={handleCreate}
              data-testid="checkpoint-save"
              className="flex items-center gap-1 text-[11px] text-primary hover:underline"
            >
              <Plus size={10} />
              {tr('checkpoint.save')}
            </button>
          </div>

          {checkpoints.length === 0 ? (
            <p className="text-[11px] text-app-placeholder py-2 text-center">
              {tr('checkpoint.empty')}
            </p>
          ) : (
            <div className="space-y-1">
              {checkpoints.map((cp) => {
                // The preflight decides the button: disabled, with the reason
                // as its title, only when the route said the gesture stops.
                const button = rollbackButtonState(plans[cp.idx], tr);
                return (
                <div
                  key={cp.idx}
                  // Appiglio stabile per chi cerca UNA voce della timeline.
                  // `.space-y-1 > div` non lo è: quella utility di spaziatura la
                  // portano almeno sei contenitori di chat (ToolCards ×3,
                  // InvokedCommandRow, ToolPermissionRow, e questo), quindi un
                  // `nth(1)` prendeva il secondo div di QUALUNQUE di loro — e
                  // una card di strumento che sta ancora comparendo non è mai
                  // «stable», da cui un clic che non parte più.
                  data-testid="checkpoint-entry"
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] transition-colors ${
                    hoveredIdx === cp.idx ? 'bg-app-hover' : ''
                  }`}
                  onMouseEnter={() => { setHoveredIdx(cp.idx); void fetchPlan(cp.idx); }}
                  onMouseLeave={() => setHoveredIdx(null)}
                >
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${cp.gitHash ? 'bg-primary' : 'bg-app-placeholder'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-app-text truncate">{cp.description}</div>
                    <div className="text-[11px] text-app-placeholder">
                      {formatTimeAgo(cp.timestamp)} - {cp.messageCount} msgs
                      {cp.gitHash && <span className="ml-1 text-primary">{cp.gitHash.slice(0, 7)}</span>}
                    </div>
                  </div>
                  {/* The reason, INLINE and not only in the tooltip: a greyed
                      button with no visible words is a button that looks
                      broken. `rollbackButtonState` already chose the sentence;
                      the component only shows it. */}
                  {hoveredIdx === cp.idx && button.disabled && (
                    <span data-testid="checkpoint-blocked-reason" className="text-[11px] text-amber-600 truncate max-w-[60%]" title={button.title}>
                      {button.title}
                    </span>
                  )}
                  {hoveredIdx === cp.idx && (
                    <button
                      onClick={() => handleRollback(cp)}
                      data-testid="checkpoint-rollback"
                      disabled={rollingBack || button.disabled}
                      className="p-1 rounded hover:bg-amber-100 dark:hover:bg-amber-900/30 text-app-text-tertiary hover:text-amber-600 transition-colors disabled:opacity-40"
                      title={button.title}
                    >
                      <RotateCcw size={12} />
                    </button>
                  )}
                </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
