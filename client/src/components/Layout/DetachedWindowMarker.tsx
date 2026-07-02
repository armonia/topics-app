// DetachedWindowMarker — the origin-side placeholder for a group that has been
// popped out into a real OS window. Pure presence projection: it renders one
// compact docked card per DETACHED window on this device (from the WS presence
// channel), NOT a persisted layout cell. When the OS window dies its socket
// drops and the card vanishes automatically — zero persistence, zero cleanup.
//
// It is SPACE-AGNOSTIC (ruling 3.5): presence carries no spaceId, so the marker
// renders in every Spazio, after the grid rows. Click → focus that window; if
// the window is gone / on another machine (window_focus_label false), fall back
// to reopening its topics locally.
import { AppWindow } from 'lucide-react';
import { cn } from '@/lib/utils';
import { POPOVER_SURFACE } from '@/lib/popoverStyles';
import { SELECTED_SURFACE } from '@/lib/selectionStyles';
import { tauriInvoke } from '@/lib/shell/tauri';
import { useDetachedWindows } from '@/state/windowPresence';
import type { Topic } from '@/types';

interface DetachedWindowMarkerProps {
  topics: Record<string, Topic>;
  /** Reopen a topic locally when the OS window can't be focused (dead / remote).
   *  Mirrors the sidebar click's fallback — claim-based reopen via openPanel. */
  onReopenTopic: (topicId: string) => void;
}

const MAX_SHOWN = 3;

export function DetachedWindowMarker({ topics, onReopenTopic }: DetachedWindowMarkerProps) {
  const windows = useDetachedWindows();
  if (windows.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5 px-2 pb-2">
      {windows.map((w) => {
        const names = w.topicIds
          .map((id) => topics[id]?.name || topics[id]?.icon || id)
          .filter(Boolean);
        const shown = names.slice(0, MAX_SHOWN);
        const extra = names.length - shown.length;
        const label = shown.join(', ') + (extra > 0 ? ` +${extra}` : '');

        const onClick = () => {
          if (w.windowLabel) {
            void tauriInvoke<boolean>('window_focus_label', { label: w.windowLabel })
              .then((focused) => {
                if (!focused) for (const id of w.topicIds) onReopenTopic(id);
              })
              .catch(() => {
                for (const id of w.topicIds) onReopenTopic(id);
              });
            return;
          }
          for (const id of w.topicIds) onReopenTopic(id);
        };

        return (
          <button
            key={w.windowId}
            onClick={onClick}
            className={cn(
              POPOVER_SURFACE,
              'py-0 flex items-center gap-2 h-11 px-3 text-left transition-colors',
              `hover:${SELECTED_SURFACE}`,
            )}
            title="Apri l'altra finestra"
            aria-label={`Apri la finestra con ${label}`}
          >
            <AppWindow size={16} className="flex-shrink-0 text-app-text-tertiary" />
            <div className="min-w-0 flex-1">
              <div className="text-[12px] text-app-text truncate">{label}</div>
              <div className="text-[11px] text-app-text-tertiary">In un'altra finestra</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
