/**
 * THE WORDS NEXT TO THE FROST.
 *
 * A texture alone says "something is wrong with this card". The label says what
 * actually happened, in the terms the person can act on: which command, how much
 * it was holding, why Topics stopped it, and that it comes back on its own. The
 * tooltip carries the one consequence they could otherwise mistake for a defect:
 * an operation whose own timeout ran out during the pause fails on resume (the
 * T0 probe measured exactly that on a Playwright click).
 */
import { Snowflake } from 'lucide-react';
import { useLocale, useT } from '../../hooks/useT';
import type { SwapFreezeView } from '../../state/swapFreeze';

export interface SwapFreezeLabelProps {
  freeze: SwapFreezeView;
  /** The glyph and nothing else, for a row or a tab where the text has no room. */
  compact?: boolean;
  className?: string;
}

export function SwapFreezeLabel({ freeze, compact = false, className = '' }: SwapFreezeLabelProps) {
  const tr = useT();
  const locale = useLocale();
  const n = (v: number, digits = 1): string => v.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const label = tr('swapFreeze.label', { command: freeze.command, gb: n(freeze.footprintGB) });
  const title = tr('swapFreeze.title', { rate: freeze.pagesReadBackPerS == null ? '?' : n(freeze.pagesReadBackPerS) });

  if (compact) {
    return (
      <span className={`inline-flex items-center ${className}`} title={`${label} - ${title}`} aria-label={label}>
        <Snowflake size={12} className="text-sky-600 dark:text-sky-300" aria-hidden="true" />
      </span>
    );
  }
  return (
    <span
      data-testid="swap-freeze-label"
      className={`inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-compact leading-4 md:text-mini bg-surface text-app-text ${className}`}
      style={{ borderColor: 'rgb(var(--swap-ice-edge) / 0.6)' }}
      title={`${label} - ${title}`}
    >
      <Snowflake size={12} className="shrink-0 text-sky-600 dark:text-sky-300" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  );
}
