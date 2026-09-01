import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { useT } from '@/hooks/useT';

/**
 * A PANEL THAT OPENS FROM THE THING IT IS ABOUT, and closes.
 *
 * -- WHY A DROPDOWN AND NOT A TAB --------------------------------------------
 * The profile used to be a strip of tabs (profile, followers, privacy), and a
 * strip of tabs turns a person into a settings panel: two of the three names
 * were not the answer to "who is this", they were controls that happened to
 * live nearby. Followers and privacy are still one gesture away, but the
 * gesture starts where the question does: the counters open the people, the
 * shield opens what this page publishes.
 *
 * -- WHY IT IS ANCHORED IN THE FLOW AND NOT FLOATING -------------------------
 * It is rendered inside the header, right under its trigger, instead of being
 * positioned over the page. A floating panel has to be measured, flipped and
 * closed on every scroll; this one moves with the content it belongs to and
 * cannot land off screen. It still behaves like a menu where it matters:
 * Escape closes it, and so does the cross.
 */
export function ProfileDropdown({ title, onClose, testId, children }: {
  title: string;
  onClose: () => void;
  testId: string;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div
      data-testid={testId}
      className="mt-3 rounded-lg border border-app-border bg-app-surface shadow-lg"
    >
      <div className="flex items-center gap-2 border-b border-app-border px-3 py-2">
        <span className="min-w-0 truncate text-[12px] font-medium text-app-text">{title}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          data-testid={`${testId}-close`}
          className="ml-auto flex-shrink-0 rounded p-1 text-app-text-muted hover:bg-app-hover hover:text-app-text coarse:min-h-11"
        >
          <X size={13} />
        </button>
      </div>
      {/* The ceiling is the point: the people list grows with the install, and
          a panel that pushes the figures below the fold turns the profile back
          into a page you have to scroll to read. */}
      <div className="max-h-[380px] overflow-y-auto px-3 py-3">{children}</div>
    </div>
  );
}
