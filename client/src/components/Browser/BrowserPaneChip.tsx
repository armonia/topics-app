/**
 * The small floating badges a browser pane puts over the page.
 *
 * There were four of them and four ways of drawing them: the connection pill,
 * the engine toggle, the render-mode toggle, and the co-browse text-selection
 * hint. Each carried its own hand-written
 * `absolute … rounded-full px-2 py-1 text-[11px] font-medium border
 * transition-colors` string plus its own palette, so they had already drifted —
 * one of them (`bg-black/70 text-white`) didn't follow the theme at all, and it
 * was the only one that stayed dark-on-dark in light mode.
 *
 * The colours are the part that was actually broken rather than merely
 * inconsistent. The status pill used raw `green-600` / `yellow-600`, which over
 * its own `/15` tint measure 2,81:1 and 2,65:1 in the light theme against a
 * threshold of 4,5 — these are 11px badges, so that is the normal-text
 * threshold, not the large-text one. The measured pairs live in `popoverStyles`
 * with the numbers written next to them; the trap worth knowing is that the
 * tint has to be part of the measurement, because a 15% veil of the same hue
 * moves the ground TOWARDS the ink (`green-700` looks like the obvious fix and
 * still misses, at 4,32).
 *
 * One component, one set of tokens: a fifth badge can't be added in a fifth
 * style, and a colour can't drift without the numbers next to it changing.
 */
import type { ReactNode } from 'react';
import { DANGER_TEXT, WARNING_TEXT, SUCCESS_TEXT } from '../../lib/popoverStyles';

export type ChipTone = 'neutral' | 'active' | 'ok' | 'warn' | 'danger';

/** Where the chip sits inside the pane. `top-center` belongs to transient hints
 *  (they read as a message, not as a control), the corners to state + toggles. */
export type ChipCorner = 'top-left' | 'top-right' | 'bottom-left' | 'top-center';

/** Exported so a test can assert the colour DECISION (the measured pairs above)
 *  without needing a DOM to render into. */
export const TONE: Record<ChipTone, string> = {
  // The off state of a toggle: readable, but visibly not "on".
  neutral: 'bg-surface/90 border-app-border text-app-text-secondary hover:bg-surface hover:text-app-text',
  active: 'bg-primary/15 border-primary/40 text-primary hover:bg-primary/25',
  ok: `bg-green-500/15 border-green-500/30 ${SUCCESS_TEXT}`,
  warn: `bg-yellow-500/15 border-yellow-500/30 ${WARNING_TEXT}`,
  danger: `bg-red-500/15 border-red-500/30 ${DANGER_TEXT}`,
};

const CORNER: Record<ChipCorner, string> = {
  'top-left': 'top-2 left-2',
  'top-right': 'top-2 right-2',
  'bottom-left': 'bottom-2 left-2',
  'top-center': 'top-2 left-1/2 -translate-x-1/2',
};

export interface BrowserPaneChipProps {
  corner: ChipCorner;
  tone: ChipTone;
  children: ReactNode;
  /** Leading glyph (a lucide icon at size 12, or the status dot). */
  icon?: ReactNode;
  /** Present → the chip is a button. Absent → a non-interactive indicator that
   *  doesn't eat pointer events aimed at the page underneath. */
  onClick?: () => void;
  title?: string;
  testId?: string;
  /** Stacking inside the pane. Defaults to 10; the render toggle sits above the
   *  co-browse surface, which paints its own layers. */
  z?: number;
  className?: string;
}

export function BrowserPaneChip({
  corner, tone, children, icon, onClick, title, testId, z = 10, className = '',
}: BrowserPaneChipProps) {
  const base =
    `absolute ${CORNER[corner]} flex items-center gap-1.5 px-2 py-1 rounded-full ` +
    `text-[11px] font-medium border transition-colors ${TONE[tone]} ${className}`;
  if (!onClick) {
    return (
      <div
        className={`${base} pointer-events-none select-none`}
        style={{ zIndex: z }}
        data-testid={testId}
        title={title}
      >
        {icon}
        {children}
      </div>
    );
  }
  return (
    <button type="button" onClick={onClick} className={base} style={{ zIndex: z }} data-testid={testId} title={title}>
      {icon}
      {children}
    </button>
  );
}

/** The pulsing/steady dot the connection pill leads with. */
export function ChipDot({ className }: { className: string }) {
  return <span className={`w-1.5 h-1.5 rounded-full ${className}`} aria-hidden />;
}
