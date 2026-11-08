/**
 * The parts every box of «Consumi» is built from (hub-smistamento, HUBBR-12):
 * the card, the box with its head and foot, the thin bar with the cap mark,
 * the token figure and the row that opens on what it sums. One place, so the boxes added later keep the same look.
 */
import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { tokenParts } from '../../lib/hubUsage';

export const CARD = 'rounded-lg border border-app-border bg-surface';
export const LINE = 'flex h-[34px] items-center gap-2 border-t border-app-border-subtle px-3 first:border-t-0';
export const BUTTON = 'inline-flex h-[26px] flex-none items-center gap-[5px] whitespace-nowrap rounded-sm border border-app-border-light bg-elevated px-2.5 text-mini text-app-text hover:bg-app-hover disabled:opacity-50 @max-2xl:h-9 @max-2xl:flex-1 @max-2xl:justify-center @max-2xl:text-compact';
export const CHIP = 'inline-flex h-[18px] flex-none items-center whitespace-nowrap rounded-xs px-1.5 text-mini';
/** The name column and the figure column of a box row: the same widths in every box, so the bars line up. */
export const NAME_COL = 'w-[112px] flex-none truncate text-mini';
export const FIGURE_COL = 'w-[86px] flex-none text-right text-mini text-app-text-muted';

const BOX_HEAD = 'flex items-center gap-[7px] border-b border-app-border-subtle px-3 py-[9px]';
const BOX_TITLE = 'flex-1 text-compact font-semibold text-app-text';

export function Box({ testId, icon, title, meta, children, foot }: { testId: string; icon: ReactNode; title: string; meta: string; children: ReactNode; foot?: ReactNode }) {
  return (
    <section data-testid={testId} className={`${CARD} flex min-w-0 flex-col`}>
      <div className={BOX_HEAD}>
        <span className="text-app-text-muted" aria-hidden="true">{icon}</span>
        <h2 className={`m-0 ${BOX_TITLE}`}>{title}</h2>
        <span className="text-mini text-app-text-muted">{meta}</span>
      </div>
      <div className="flex-1">{children}</div>
      {foot && <div className="flex items-center gap-1.5 border-t border-app-border-subtle px-3 py-2 text-mini text-app-text-muted">{foot}</div>}
    </section>
  );
}

export function Bar({ pct, hot = false, tone, cap }: { pct: number; hot?: boolean; tone?: string; cap?: number | null }) {
  return (
    <span className="relative h-1.5 min-w-0 flex-1 rounded-full bg-app-hover">
      <i className={`block h-full rounded-full ${tone ?? (hot ? 'bg-amber-500 dark:bg-amber-400' : 'bg-primary')}`} style={{ width: `${Math.max(pct > 0 ? 2 : 0, Math.min(100, pct))}%` }} />
      {cap != null && <u aria-hidden="true" className="absolute -top-[3px] h-3 w-0.5 rounded-[1px] bg-app-text-secondary" style={{ left: `${Math.min(100, cap)}%` }} />}
    </span>
  );
}

export function Tokens({ n, locale, unit }: { n: number; locale: string; unit: string }) {
  const t = tokenParts(n, locale);
  return <>{t.value}<small className="ml-[3px] text-mini font-normal text-app-text-muted">{t.unit ? `${t.unit} ${unit}` : unit}</small></>;
}


/**
 * «N more» at the foot of a box's rows: it sums what is not shown and opens
 * on the rows themselves, each drawn like the ones above.
 */
export function MoreRows({ testId, label, figure, children }: { testId: string; label: string; figure?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <>
      <button type="button" data-testid={testId} aria-expanded={open} onClick={() => setOpen((v) => !v)}
        className={`${LINE} w-full text-left tabular-nums hover:bg-app-hover`}>
        <span className={`${NAME_COL} flex items-center gap-1 text-app-text-muted`}><Icon size={12} aria-hidden="true" className="flex-none" />{label}</span>
        <span className="flex-1" />
        {figure && <span className={FIGURE_COL}>{figure}</span>}
      </button>
      {open && children}
    </>
  );
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
