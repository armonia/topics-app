import { useState, useEffect, useRef, useCallback } from 'react';
import { agentProfilesApi, type AgentProfile } from '../../lib/api';

interface MentionAutocompleteProps {
  query: string;
  onSelect: (name: string) => void;
  onClose: () => void;
  position: { top: number; left: number };
}

const ROLE_COLORS: Record<string, string> = {
  lead: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  worker: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  specialist: 'bg-purple-500/15 text-purple-600 dark:text-purple-400',
};

export function MentionAutocomplete({ query, onSelect, onClose, position }: MentionAutocompleteProps) {
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
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }, [results, selectedIndex, onSelect, onClose]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [handleKeyDown]);

  // Click outside to close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  if (results.length === 0) return null;

  return (
    <div
      ref={menuRef}
      className="fixed z-[9999] glass-surface border border-app-border rounded-lg shadow-lg overflow-hidden"
      style={{
        top: position.top,
        left: position.left,
        minWidth: '180px',
        maxWidth: '260px',
      }}
    >
      {results.map((item, idx) => {
        const isAll = item.id === '__all__';
        const roleClass = isAll ? 'bg-green-500/15 text-green-600 dark:text-green-400' : ROLE_COLORS[item.role] || '';

        return (
          <button
            key={item.id}
            type="button"
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
    </div>
  );
}
