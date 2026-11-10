import { useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import clsx from 'clsx';
import { FOCUS_RING } from '../shell/pressable';
import { Menu, type MenuItemModel } from '../primitives/Menu';

/**
 * The «more» button of a row: a quiet three-dot control whose menu opens at
 * the button, fixed on the page, so a table that scrolls inside its own frame
 * does not clip it. Clicks and keys stay its own: the row under it, which may
 * open something, does not hear them.
 */
export function RowMenu({ label, items, onSelect, className }: {
  label: string;
  items: MenuItemModel[];
  onSelect: (id: string) => void;
  className?: string;
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  return (
    <span className="inline-flex" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-label={label}
        data-tip={label}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAt(at ? null : { x: Math.max(8, r.right - 190), y: r.bottom + 4 });
        }}
        className={clsx(
          'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-app-text-secondary transition-colors hover:bg-black/[0.06] hover:text-app-text dark:hover:bg-white/[0.1]',
          FOCUS_RING, className,
        )}
      >
        <MoreHorizontal size={15} aria-hidden="true" />
      </button>
      {at && <Menu items={items} ariaLabel={label} x={at.x} y={at.y} onSelect={onSelect} onClose={() => setAt(null)} />}
    </span>
  );
}
