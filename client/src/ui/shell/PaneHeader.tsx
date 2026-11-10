import { Fragment, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import clsx from 'clsx';
import type { CrumbModel } from '../types';
import type { UiCopy } from '../copy/types';
import { useMeasuredRef } from '../primitives/scrollEdges';

/**
 * The way back to the place a screen was opened from, at the start of a pane
 * header: an arrow and the name of that place, so the reader knows where it
 * leads before pressing it.
 */
export function BackButton({ label, onClick, copy }: { label: string; onClick: () => void; copy: UiCopy }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={copy.common.back(label)}
      data-tip={copy.common.back(label)}
      className="-ml-1.5 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-1.5 text-prose text-app-text-secondary transition-colors hover:bg-black/[0.05] hover:text-app-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 dark:hover:bg-white/[0.08]"
    >
      <ArrowLeft size={15} aria-hidden="true" />
      <span className="max-w-[180px] truncate">{label}</span>
    </button>
  );
}

/**
 * The bar at the top of a pane: where you are (crumbs, the last one is the
 * place itself), its state, and the controls of the pane on the right. 40px,
 * like the product's pane chrome bar. `leading` sits before the crumbs, for a
 * way back.
 *
 * Under an ancestor marked `data-back-in-crumbs` (an edition whose crumbs are
 * a trail of places) the way back gives way, from 768px up, to the crumb that
 * names the same place: it would say the parent twice, side by side, and push
 * the trail off the left edge the other pages start it at. On a phone the
 * trail is not shown and the way back stays.
 */
export function PaneHeader({ crumbs, status, leading, children }: { crumbs: CrumbModel[]; status?: ReactNode; leading?: ReactNode; children?: ReactNode }) {
  const parentInTrail = crumbs.some((c) => c.onSelect);
  const trail = crumbs.map((c) => `${c.label}|${c.detail ?? ''}`).join('/');
  const [fit, setFit] = useState<{ trail: string; hidden: number }>({ trail: '', hidden: 0 });
  const maxHidden = Math.max(0, crumbs.length - 3);
  const hidden = fit.trail === trail ? Math.min(fit.hidden, maxHidden) : 0;
  /* Once no level is left to drop, the names shrink with an ellipsis as the last resort. */
  const squeeze = hidden >= maxHidden;
  /* Measured after every render: while the trail overflows, one more middle level gives way. */
  const row = useMeasuredRef<HTMLDivElement>((el) => {
    if (squeeze) return;
    if (el.scrollWidth > el.clientWidth + 1) setFit({ trail, hidden: hidden + 1 });
  });
  /* The header itself changing width starts the fitting over (a wider pane may hold levels that did not fit). */
  const lastWidth = useRef(0);
  const header = useMeasuredRef<HTMLElement>((el) => {
    if (Math.abs(el.clientWidth - lastWidth.current) < 1) return;
    const first = lastWidth.current === 0;
    lastWidth.current = el.clientWidth;
    if (!first) setFit({ trail: '', hidden: 0 });
  });
  const folded = crumbs.slice(1, 1 + hidden);
  const shown = crumbs.map((c, i) => ({ c, i })).filter(({ i }) => i === 0 || i > hidden);
  const foldedTip = folded.map((c) => c.label).join(' / ');
  return (
    <header ref={header} className="flex h-11 shrink-0 items-center gap-3 border-b border-app-border px-4">
      {leading && <span className={clsx('flex shrink-0 items-center gap-2', parentInTrail && 'md:[[data-back-in-crumbs]_&]:hidden')}>{leading}<span className="h-4 w-px bg-app-border-light" aria-hidden="true" /></span>}
      {/* In a narrow pane the trail drops its middle levels (the «…» button names them) instead of cutting a name in half or sliding under the buttons on the right. */}
      <div ref={row} className="flex min-w-0 items-center gap-1.5 overflow-hidden text-prose leading-5" data-crumbs="true">
        {shown.map(({ c, i }, n) => {
          const last = i === crumbs.length - 1;
          const sizing = squeeze ? 'min-w-[3rem] shrink truncate' : 'shrink-0 whitespace-nowrap';
          return (
            <Fragment key={`${c.label}-${i}`}>
              {n > 0 && <span className="shrink-0 text-app-text-faint" aria-hidden="true">/</span>}
              {n === 1 && folded.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={folded.slice().reverse().find((f) => f.onSelect)?.onSelect}
                    aria-label={foldedTip}
                    data-tip={foldedTip}
                    data-crumbs-more=""
                    className="-mx-1 shrink-0 rounded-md px-1 text-app-text-secondary transition-colors hover:bg-black/[0.05] hover:text-app-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 dark:hover:bg-white/[0.08]"
                  >
                    …
                  </button>
                  <span className="shrink-0 text-app-text-faint" aria-hidden="true">/</span>
                </>
              )}
              {!last && c.onSelect ? (
                <button
                  type="button"
                  onClick={c.onSelect}
                  data-tip={c.label}
                  className={clsx('-mx-1 rounded-md px-1 text-app-text-secondary transition-colors hover:bg-black/[0.05] hover:text-app-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 dark:hover:bg-white/[0.08]', sizing)}
                >
                  {c.label}
                </button>
              ) : (
                <span data-tip={last ? c.label : undefined} aria-current={last ? 'page' : undefined} className={clsx(sizing, squeeze && last && 'shrink-[4]', last ? 'font-semibold text-app-text' : 'text-app-text-secondary')}>{c.label}</span>
              )}
              {c.detail && <span className="shrink-0 text-app-text-tertiary">· {c.detail}</span>}
            </Fragment>
          );
        })}
        {status && <span className="ml-1 shrink-0">{status}</span>}
      </div>
      <span className="flex-1" />
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </header>
  );
}
