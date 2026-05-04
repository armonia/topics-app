/**
 * PendingActionToast — visual surface for the PendingActionContext.
 *
 * Two states per entry:
 *  1. PRE-TICK: empty checkbox + label + Cancel(X). Nothing is committed
 *     until the user explicitly ticks the box.
 *  2. POST-TICK: filled checkbox + label + progress bar (3s default) +
 *     Cancel button. When the bar fills, the manager commits the action.
 *
 * Cancel un-ticks (back to pre-tick) on first click; second click dismisses.
 * For simplicity (and because "I clicked cancel by mistake" is rare during
 * a 3-second window), we just dismiss on any cancel click — re-trigger from
 * the original UI if needed.
 *
 * Mount via <PendingActionOutlet /> at App-level. Toasts stack bottom-right.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, X, Archive, FolderArchive } from 'lucide-react';
import {
  usePendingActions,
  type PendingActionEntry,
  type PendingActionKind,
} from '../../contexts/PendingActionContext';

const KIND_LABELS: Record<PendingActionKind, { verb: string; subject: string }> = {
  'close-tab':       { verb: 'Chiudi',   subject: 'tab' },
  'archive-topic':   { verb: 'Archivia', subject: 'topic' },
  'archive-project': { verb: 'Archivia', subject: 'progetto' },
};

function KindIcon({ kind, size = 14 }: { kind: PendingActionKind; size?: number }) {
  if (kind === 'archive-topic') return <Archive size={size} />;
  if (kind === 'archive-project') return <FolderArchive size={size} />;
  return <X size={size} />;
}

interface PendingActionToastItemProps {
  entry: PendingActionEntry;
  countdownMs: number;
  onTick: () => void;
  onCancel: () => void;
}

function PendingActionToastItem({
  entry,
  countdownMs,
  onTick,
  onCancel,
}: PendingActionToastItemProps) {
  const [enterState, setEnterState] = useState<'enter' | 'visible'>('enter');
  // The checkbox tick animation needs a fresh paint between "ticked false"
  // and "ticked true" so the progress bar transition has something to
  // interpolate from. We hold the bar at 0% on first paint, then flip to 100%
  // on the next animation frame.
  const [progressTo, setProgressTo] = useState(0);
  const tickedRef = useRef(false);

  useEffect(() => {
    requestAnimationFrame(() => setEnterState('visible'));
  }, []);

  useEffect(() => {
    if (entry.tickedAt === null) {
      tickedRef.current = false;
      setProgressTo(0);
      return;
    }
    if (tickedRef.current) return;
    tickedRef.current = true;
    // Two RAFs: first paint with width:0, second paint flips to width:100% so
    // the CSS transition runs. Without this, browsers occasionally collapse
    // the change into the initial layout pass and the bar appears full-on.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setProgressTo(100));
    });
  }, [entry.tickedAt]);

  const labels = KIND_LABELS[entry.kind];
  const ticked = entry.tickedAt !== null;
  const accent = entry.color || '#6b7280';

  return (
    <div
      role="alertdialog"
      aria-label={`${labels.verb} ${labels.subject}: ${entry.label}`}
      className={`relative w-[280px] rounded-lg shadow-lg border bg-surface dark:bg-elevated text-app-text overflow-hidden transition-all duration-300 ${
        enterState === 'enter'
          ? 'opacity-0 translate-y-2'
          : 'opacity-100 translate-y-0'
      } ${ticked ? 'border-app-border-light' : 'border-app-border'}`}
      style={{ pointerEvents: 'auto' }}
    >
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <button
          type="button"
          onClick={onTick}
          aria-label={ticked ? 'Already ticked' : `Confirm ${labels.verb.toLowerCase()}`}
          aria-pressed={ticked}
          disabled={ticked}
          className={`flex-shrink-0 w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${
            ticked
              ? 'border-transparent text-white'
              : 'border-app-border-light hover:border-app-text-tertiary cursor-pointer'
          }`}
          style={ticked ? { backgroundColor: accent } : undefined}
        >
          {ticked && <Check size={12} strokeWidth={3} />}
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 text-[11px] text-app-text-tertiary">
            <KindIcon kind={entry.kind} size={11} />
            <span>{labels.verb} {labels.subject}</span>
          </div>
          <div className="text-[12px] font-medium truncate">{entry.label}</div>
        </div>

        <button
          type="button"
          onClick={onCancel}
          aria-label="Annulla"
          title="Annulla"
          className="flex-shrink-0 w-6 h-6 rounded hover:bg-app-hover text-app-text-tertiary hover:text-app-text flex items-center justify-center transition-colors"
        >
          <X size={13} />
        </button>
      </div>

      {/* Progress bar — only renders width transition once ticked. */}
      <div className="h-[3px] bg-app-border/40 relative overflow-hidden">
        <div
          className="absolute inset-y-0 left-0"
          style={{
            width: `${progressTo}%`,
            backgroundColor: accent,
            transition: ticked
              ? `width ${countdownMs}ms linear`
              : 'none',
          }}
        />
      </div>
    </div>
  );
}

/**
 * Renders all currently-pending actions as a stack of toasts. Mount once at
 * App level (after the PendingActionProvider). Position is fixed bottom-right
 * by default — the OS / dock area on macOS is clear there.
 */
export function PendingActionOutlet() {
  const { entries, tick, cancel, countdownMs } = usePendingActions();
  if (entries.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[120] flex flex-col gap-2 pointer-events-none">
      {entries.map((entry) => (
        <PendingActionToastItem
          key={entry.key}
          entry={entry}
          countdownMs={countdownMs}
          onTick={() => tick(entry.key)}
          onCancel={() => cancel(entry.key)}
        />
      ))}
    </div>
  );
}
