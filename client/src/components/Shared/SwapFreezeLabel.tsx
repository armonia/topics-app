/**
 * THE WORDS NEXT TO THE FROST.
 *
 * A texture alone says "something is wrong with this card", and the first
 * version of these words did not say much more: "Frozen: bun batteria.ts,
 * 2.1 GB, Mac swapping" names a mechanism, not a situation (request of 24/09:
 * "nobody understands the frozen effect"). So the visible sentence answers the
 * three questions a person actually has, in their words and without hovering:
 * WHAT is paused (a test, a command), WHY (the Mac is short of memory) and WHAT
 * TO DO (nothing: it resumes by itself, by a stated time). The command is the
 * secondary detail, and the jargon (swap, pages per second, the weight) lives
 * in the tooltip for whoever wants the mechanism.
 *
 * The tooltip also carries the one consequence that could otherwise pass for a
 * defect: an operation whose own timeout ran out during the pause fails on
 * resume (the T0 probe measured exactly that on a Playwright click).
 *
 * Three shapes, one source of words:
 *  - `full`: card and chat pane, the sentence plus the command;
 *  - `compact`: a tab, the glyph plus "pausa". One short word and not "in
 *    pausa": on a 150 px tab the title kept 78 px before this change and the
 *    two words left it 69 (WebKit, 24/09), one word leaves it more than before;
 *  - `line`: a sidebar row's second line, a short sentence in place of the
 *    preview, so the chat's NAME keeps all its room.
 */
import { Snowflake } from 'lucide-react';
import { useLocale, useT } from '../../hooks/useT';
import type { SwapFreezeView } from '../../state/swapFreeze';
import { FREEZE_MAX_MS } from '../../../../shared/swap-freeze';

export interface SwapFreezeLabelProps {
  freeze: SwapFreezeView;
  variant?: 'full' | 'compact' | 'line';
  className?: string;
}

/**
 * A test suite is what gets frozen most often (the battery of 15/09), and
 * "Test in pausa" tells a person far more than "Comando in pausa". Anything
 * else is a command.
 */
const TEST_COMMAND = /\b(test|tests|spec|e2e|playwright|vitest|jest)\b/i;

function isTestCommand(command: string): boolean {
  return TEST_COMMAND.test(command);
}

export function SwapFreezeLabel({ freeze, variant = 'full', className = '' }: SwapFreezeLabelProps) {
  const tr = useT();
  const locale = useLocale();
  const n = (v: number, digits = 1): string => v.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const what = tr(isTestCommand(freeze.command) ? 'swapFreeze.what.test' : 'swapFreeze.what.command');
  // The server's own ceiling, as a clock time: "by 19:32" is a promise a person
  // can check, "within 10 minutes" of an unknown start is not. `thawBy` is on
  // every view; the fallback only covers a view from an older server.
  const thawBy = Number.isFinite(freeze.thawBy) ? freeze.thawBy : freeze.frozenAt + FREEZE_MAX_MS;
  const at = new Date(thawBy).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  const sentence = tr('swapFreeze.label', { what, at });
  const title = tr('swapFreeze.title', {
    command: freeze.command,
    gb: n(freeze.footprintGB),
    rate: freeze.pagesReadBackPerS == null ? '?' : n(freeze.pagesReadBackPerS),
  });
  const glyph = (
    <Snowflake size={12} className="shrink-0 text-sky-600 dark:text-sky-300" aria-hidden="true" />
  );

  if (variant === 'compact') {
    return (
      <span
        data-testid="swap-freeze-compact"
        className={`ml-0.5 inline-flex flex-shrink-0 items-center gap-0.5 text-micro leading-none font-medium text-sky-700 dark:text-sky-300 ${className}`}
        title={`${sentence}\n${title}`}
        aria-label={sentence}
      >
        {glyph}
        <span>{tr('swapFreeze.short')}</span>
      </span>
    );
  }
  if (variant === 'line') {
    return (
      <span
        data-testid="swap-freeze-line"
        className={`truncate-tight flex items-center gap-1 text-mini font-medium text-sky-700 dark:text-sky-300 ${className}`}
        title={`${sentence}\n${title}`}
      >
        {glyph}
        <span className="truncate">{tr('swapFreeze.rowLine')}</span>
      </span>
    );
  }
  return (
    <span
      data-testid="swap-freeze-label"
      className={`flex max-w-full flex-col gap-0.5 rounded border px-1.5 py-1 text-compact leading-4 md:text-mini bg-surface text-app-text ${className}`}
      style={{ borderColor: 'rgb(var(--swap-ice-edge) / 0.6)' }}
      title={`${sentence}\n${title}`}
    >
      <span className="flex items-start gap-1">
        <span className="mt-0.5">{glyph}</span>
        <span className="font-medium">{sentence}</span>
      </span>
      {/* The command is the detail, not the headline: who wants to know WHICH
          one reads it here, everybody else stops at the sentence above. */}
      <span className="truncate pl-4 font-mono text-app-text-muted">{freeze.command}</span>
    </span>
  );
}
