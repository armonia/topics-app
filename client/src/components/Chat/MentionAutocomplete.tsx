import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { agentProfilesApi, type AgentProfile } from '../../lib/api';
import { useDismissable } from '@/hooks/useDismissable';
import { POPOVER_PANEL, POPOVER_MARGIN, Z_POPOVER } from '@/lib/popoverStyles';

interface MentionAutocompleteProps {
  query: string;
  onSelect: (name: string) => void;
  onClose: () => void;
  position: { top: number; left: number };
  /** The chat textarea — kept "inside" so clicks/Escape in it don't dismiss,
   *  and focus is never yanked away from the caret (restoreFocus:false). */
  inputRef?: React.RefObject<HTMLElement | null>;
}

const ROLE_COLORS: Record<string, string> = {
  lead: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  worker: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  specialist: 'bg-purple-500/15 text-purple-600 dark:text-purple-400',
};

/** Own max-width — lets the horizontal clamp work without measuring. */
const MAX_W = 260;

export function MentionAutocomplete({ query, onSelect, onClose, position, inputRef }: MentionAutocompleteProps) {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);

  // Fetch agent profiles on mount
  useEffect(() => {
    agentProfilesApi.list()
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, []);

  // Filter profiles by query
  const lowerQuery = query.toLowerCase();
  const filtered = profiles.filter(p =>
    p.name.toLowerCase().includes(lowerQuery)
  );

  // Add @all as a built-in option
  const allOption = { id: '__all__', name: 'all', role: 'all' as const, avatarEmoji: '📢', status: 'available' as const };
  const showAll = 'all'.includes(lowerQuery);
  const results = [
    ...(showAll ? [allOption] : []),
    ...filtered,
  ].slice(0, 6);

  // Reset selection when results change
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset interactive highlight to top when the query changes; selectedIndex is user-controllable (arrow keys) so it can't be pure-derived, and the reset converges (no loop)
    setSelectedIndex(0);
  }, [query]);

  // Keyboard handler
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (results.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      setSelectedIndex(i => (i + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      setSelectedIndex(i => (i - 1 + results.length) % results.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      const selected = results[selectedIndex];
      if (selected) onSelect(selected.name);
    }
    // Escape is handled by useDismissable (unified dismissal contract).
  }, [results, selectedIndex, onSelect]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [handleKeyDown]);

  // Unified dismissal: capture-phase outside-pointer + Escape close. The
  // textarea stays "inside" so typing/clicking in it never dismisses, and
  // restoreFocus:false leaves the caret where it is (the input already holds
  // focus — don't fight it).
  useDismissable({
    open: results.length > 0,
    onClose,
    refs: inputRef ? [inputRef, menuRef] : [menuRef],
    restoreFocus: false,
  });

  if (results.length === 0) return null;

  return createPortal(
    <div
      ref={menuRef}
      role="listbox"
      // POPOVER_PANEL instead of a verbatim copy of its class string, plus the
      // clamps this never had: it was placed at raw caret-derived coordinates
      // with no bound on either axis and no height cap, so a composer near the
      // right or bottom edge pushed the list off-screen. MAX_W is its own
      // max-width, so the horizontal clamp needs no measurement.
      className={`fixed ${POPOVER_PANEL} overflow-y-auto overscroll-contain`}
      style={{
        top: position.top,
        left: Math.max(POPOVER_MARGIN, Math.min(position.left, window.innerWidth - MAX_W - POPOVER_MARGIN)),
        minWidth: '180px',
        maxWidth: `${MAX_W}px`,
        maxHeight: `calc(100vh - ${position.top + POPOVER_MARGIN}px)`,
        zIndex: Z_POPOVER,
      }}
    >
      {results.map((item, idx) => {
        const isAll = item.id === '__all__';
        const roleClass = isAll ? 'bg-green-500/15 text-green-600 dark:text-green-400' : ROLE_COLORS[item.role] || '';

        return (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={idx === selectedIndex}
            className={`w-full px-2.5 py-1.5 flex items-center gap-2 text-left transition-colors ${
              idx === selectedIndex
                ? 'bg-primary/10 text-app-text'
                : 'text-app-text hover:bg-app-hover'
            }`}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(item.name);
            }}
            onMouseEnter={() => setSelectedIndex(idx)}
          >
            <span className="text-[14px] flex-shrink-0">{item.avatarEmoji}</span>
            <span className="text-[11px] font-medium truncate flex-1">@{item.name}</span>
            <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0 ${roleClass}`}>
              {isAll ? 'everyone' : item.role}
            </span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
