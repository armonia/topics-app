import type { LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import { Count } from '../primitives/Chip';
import { revealInStrip, useScrollFade } from '../primitives/scrollEdges';
import { FOCUS_RING } from './pressable';

/** Brings the current entry into view along the strip (sideways only), so a strip that scrolls never hides where you are. */
function revealActive(el: HTMLElement | null) {
  revealInStrip(el);
}

export interface SubNavItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  count?: number;
  /** The place on show. */
  active: boolean;
}

/**
 * The strip under the header of a section with sub-sections (Conoscenza:
 * Documenti, Contratti, Dati, Regole; Impostazioni; Squadra): the same words (allow-italian: section names)
 * on one line over a hairline, the current one underlined and marked
 * `aria-current="page"`. Every entry is a place with its own address, so these
 * are links to places, not tabs of one page. On a phone the icons give way so the
 * words fit, and a strip that still overflows scrolls sideways with the current entry in view and its edges faded where more waits; the focus ring is drawn inside each entry, so nothing cuts it.
 */
export function SubNav({ items, onSelect, label, className }: {
  items: SubNavItem[];
  onSelect: (id: string) => void;
  label: string;
  className?: string;
}) {
  const { attach, style, onScroll } = useScrollFade<HTMLElement>();
  return (
    <nav ref={attach} style={style} onScroll={onScroll} aria-label={label} className={clsx('scrollbar-none flex min-w-0 scroll-px-8 items-stretch gap-4 overflow-x-auto md:gap-5 border-b border-app-border', className)}>
      {items.map((it) => {
        const Icon = it.icon;
        return (
          <button
            key={it.id}
            type="button"
            ref={it.active ? revealActive : undefined}
            aria-current={it.active ? 'page' : undefined}
            onClick={() => onSelect(it.id)}
            className={clsx(
              'relative inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-t-md text-prose font-medium transition-colors duration-fast coarse:h-11',
              FOCUS_RING, 'focus-visible:ring-inset',
              it.active ? 'text-app-text' : 'text-app-text-secondary hover:text-app-text',
            )}
          >
            {Icon && <Icon size={14} className={clsx('max-md:hidden', it.active ? 'text-app-text' : 'text-app-text-tertiary')} aria-hidden="true" />}
            {it.label}
            {it.count !== undefined && <Count value={it.count} tone={it.active ? 'blue' : 'neutral'} />}
            <span aria-hidden="true" className={clsx('absolute inset-x-0 bottom-0 h-0.5 rounded-full transition-colors duration-fast', it.active ? 'bg-primary' : 'bg-transparent')} />
          </button>
        );
      })}
    </nav>
  );
}
