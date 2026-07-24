// DetachedWindowsSection — sidebar presence of ALL detached (popped-out) OS
// windows on this device. The grid already shows DetachedWindowMarker cards,
// but the sidebar is where you look for "what's open where" — so surface the
// same live WS presence here as a compact, self-healing section (a dead window's
// socket drops and its row vanishes; zero persistence).
//
// Click a window → focus it natively; if it's gone / on another machine
// (window_focus_label returns false), fall back to reopening its topics locally.
import { AppWindow } from 'lucide-react';
import { tauriInvoke } from '@/lib/shell/tauri';
import { useDetachedWindows } from '@/state/windowPresence';
import type { Topic } from '@/types';

const MAX_NAMES = 3;

interface DetachedWindowsSectionProps {
  topics: Record<string, Topic>;
  /** Reopen a topic locally when the OS window can't be focused (dead / remote). */
  onReopenTopic: (topicId: string) => void;
}

export function DetachedWindowsSection({ topics, onReopenTopic }: DetachedWindowsSectionProps) {
  const windows = useDetachedWindows();
  if (windows.length === 0) return null;

  return (
    <div className="px-2 pt-2 pb-1" data-testid="sidebar-detached-windows">
      <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wider text-app-text-tertiary">
        Finestre aperte
      </div>
      <div className="flex flex-col gap-1">
        {windows.map((w) => {
          const names = w.topicIds
            .map((id) => topics[id]?.name || topics[id]?.icon || id)
            .filter(Boolean);
          const shown = names.slice(0, MAX_NAMES);
          const extra = names.length - shown.length;
          const label = shown.join(', ') + (extra > 0 ? ` +${extra}` : '') || 'Finestra';

          const onClick = () => {
            if (w.windowLabel) {
              void tauriInvoke<boolean>('window_focus_label', { label: w.windowLabel })
                .then((focused) => { if (!focused) for (const id of w.topicIds) onReopenTopic(id); })
                .catch(() => { for (const id of w.topicIds) onReopenTopic(id); });
              return;
            }
            for (const id of w.topicIds) onReopenTopic(id);
          };

          return (
            <button
              key={w.windowId}
              onClick={onClick}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-app-text transition-colors hover:bg-app-hover"
              title="Apri l'altra finestra"
              aria-label={`Apri la finestra con ${label}`}
            >
              <AppWindow size={14} className="flex-shrink-0 text-app-text-tertiary" />
              <span className="min-w-0 flex-1 truncate">{label}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 border-b border-app-border" />
    </div>
  );
}
