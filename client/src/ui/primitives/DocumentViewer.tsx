import type { KeyboardEvent, ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Download, Maximize2, Quote, ZoomIn, ZoomOut, type LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { FOCUS_RING } from '../shell/pressable';

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.25;

const round = (z: number) => Math.round(z * 100) / 100;

const TOOL = clsx(
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-app-text-secondary transition-colors',
  'enabled:hover:bg-black/[0.05] enabled:hover:text-app-text disabled:cursor-default disabled:opacity-35 dark:enabled:hover:bg-white/[0.08]',
  FOCUS_RING,
);

function Tool({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick?: () => void }) {
  return (
    <button type="button" aria-label={label} data-tip={label} onClick={onClick} disabled={!onClick} className={TOOL}>
      <Icon size={15} aria-hidden="true" />
    </button>
  );
}

/**
 * An original document, page by page, the way a reader checks it: the page
 * thumbnails on the left (not on a phone), the page on a grey desk with a
 * paper shadow, the page count with previous and next, zoom out, in and fit
 * (`zoom` 1 = the page fills the desk's width), the PDF to download when
 * there is one. A `quote` stands in a highlighted box over the page it was
 * taken from. `aside` is a column on the right (under the page on a phone),
 * e.g. the summary the reader is checking against the original.
 * The page and the zoom are the caller's; arrows on the desk turn the page.
 */
export function DocumentViewer({ name, detail, pages, page, onPage, zoom, onZoom, pdfHref, quote, aside, actions, copy, phone }: {
  name: string;
  detail?: string;
  /** One image URL per page. */
  pages: string[];
  /** 1-based. */
  page: number;
  onPage: (n: number) => void;
  zoom: number;
  onZoom: (z: number) => void;
  pdfHref?: string;
  quote?: { text: string; page: number };
  aside?: ReactNode;
  actions?: ReactNode;
  copy: UiCopy;
  phone?: boolean;
}) {
  const v = copy.kit.viewer;
  const total = pages.length;
  const current = Math.min(Math.max(1, page), Math.max(1, total));
  const src = pages[current - 1];
  const go = (n: number) => (n >= 1 && n <= total && n !== current ? () => onPage(n) : undefined);
  const zoomBy = (d: number) => {
    const next = round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom + d)));
    return next !== round(zoom) ? () => onZoom(next) : undefined;
  };
  const onDeskKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'PageDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'PageUp' ? -1 : 0;
    const to = step ? go(current + step) : undefined;
    if (!to) return;
    e.preventDefault();
    to();
  };

  const toolbar = (
    <div role="toolbar" aria-label={v.toolbar} className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-app-border bg-surface px-3 py-1.5 sm:gap-x-3">
      <div className={clsx('flex min-w-0 flex-1 items-baseline gap-2', phone ? 'basis-full' : 'max-sm:basis-full')}>
        <span className="min-w-0 truncate text-prose font-semibold text-app-text">{name}</span>
        {detail && <span className="hidden shrink-0 truncate text-mini text-app-text-tertiary sm:inline">{detail}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Tool icon={ChevronLeft} label={v.previous} onClick={go(current - 1)} />
        <span className="min-w-[76px] px-1 text-center text-mini tabular-nums text-app-text-secondary" aria-live="polite">{v.pageOf(current, total)}</span>
        <Tool icon={ChevronRight} label={v.next} onClick={go(current + 1)} />
        <span aria-hidden="true" className="mx-1 h-4 w-px bg-app-border-light" />
        <Tool icon={ZoomOut} label={v.zoomOut} onClick={zoomBy(-ZOOM_STEP)} />
        <span className="w-9 text-center text-mini tabular-nums text-app-text-tertiary">{v.zoom(Math.round(zoom * 100))}</span>
        <Tool icon={ZoomIn} label={v.zoomIn} onClick={zoomBy(ZOOM_STEP)} />
        <Tool icon={Maximize2} label={v.fit} onClick={round(zoom) !== 1 ? () => onZoom(1) : undefined} />
      </div>
      {(pdfHref || actions) && (
        <div className="flex shrink-0 items-center gap-1.5">
          {pdfHref && (
            <a
              href={pdfHref}
              download
              data-tip={v.download}
              className={clsx('inline-flex h-7 items-center gap-1.5 rounded-lg bg-black/[0.05] px-2.5 text-prose font-medium text-app-text transition-colors hover:bg-black/[0.08] dark:bg-white/[0.08] dark:hover:bg-white/[0.12]', FOCUS_RING)}
            >
              <Download size={14} aria-hidden="true" />
              <span className={phone ? 'sr-only' : 'max-sm:sr-only'}>{v.download}</span>
            </a>
          )}
          {actions}
        </div>
      )}
    </div>
  );

  const rail = !phone && total > 1 && (
    <nav aria-label={v.pages} className="hidden w-[92px] shrink-0 flex-col gap-2.5 overflow-y-auto border-r border-app-border bg-app-inset p-2.5 md:flex">
      {pages.map((p, i) => {
        const n = i + 1;
        const on = n === current;
        return (
          <button
            key={`${n}-${p}`}
            type="button"
            onClick={() => onPage(n)}
            aria-label={v.goToPage(n)}
            aria-current={on ? 'page' : undefined}
            className={clsx('group flex flex-col items-center gap-1 rounded-md p-1 transition-colors', FOCUS_RING, on ? 'bg-primary/10' : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.06]')}
          >
            <img
              src={p}
              alt=""
              loading="lazy"
              className={clsx('aspect-[1/1.414] w-full rounded-[3px] bg-white object-cover object-top shadow-sm ring-1', on ? 'ring-2 ring-primary' : 'ring-black/10 dark:ring-white/10')}
            />
            <span className={clsx('text-mini tabular-nums', on ? 'font-semibold text-primary dark:text-primary-dark' : 'text-app-text-tertiary')}>{n}</span>
          </button>
        );
      })}
    </nav>
  );

  const desk = (
    <div
      role="region"
      tabIndex={0}
      onKeyDown={onDeskKey}
      aria-label={v.pageImage(name, current)}
      className={clsx('min-h-0 min-w-0 flex-1 overflow-auto bg-[#e7e8ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60 dark:bg-[#121316]', phone ? 'px-3 py-4' : 'px-3 py-4 md:px-8 md:py-6')}
    >
      <div style={{ width: `${zoom * 100}%` }} className="mx-auto max-w-none">
        {quote && quote.page === current && (
          <figure className="mb-3 rounded-lg border border-amber-500/40 bg-amber-50 px-3.5 py-2.5 dark:border-amber-400/30 dark:bg-amber-500/10">
            <figcaption className="mb-1 flex items-center gap-1.5 text-mini font-semibold text-amber-800 dark:text-amber-300">
              <Quote size={12} aria-hidden="true" />
              {v.quote(quote.page)}
            </figcaption>
            <blockquote className="text-prose leading-6 text-app-text">{quote.text}</blockquote>
          </figure>
        )}
        {src ? (
          <img
            src={src}
            alt={v.pageImage(name, current)}
            className="block h-auto w-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.10),0_8px_28px_rgba(0,0,0,0.12)] dark:shadow-[0_1px_2px_rgba(0,0,0,0.5),0_8px_28px_rgba(0,0,0,0.5)]"
          />
        ) : (
          <div aria-hidden="true" className="aspect-[1/1.414] w-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.10),0_8px_28px_rgba(0,0,0,0.12)]" />
        )}
      </div>
    </div>
  );

  /* `phone` forces the stacked layout; without it the same happens under 768px. */
  return (
    <div className={clsx('flex min-h-0 min-w-0 flex-1', phone ? 'flex-col overflow-y-auto' : 'max-md:flex-col max-md:overflow-y-auto md:flex-row')}>
      <div className={clsx('flex min-w-0 flex-col', phone ? 'min-h-[70dvh] shrink-0' : 'max-md:min-h-[70dvh] max-md:shrink-0 md:min-h-0 md:flex-1')}>
        {toolbar}
        <div className="flex min-h-0 flex-1">
          {rail}
          {desk}
        </div>
      </div>
      {aside && (
        <aside
          className={clsx(
            'min-w-0 bg-surface',
            phone ? 'border-t border-app-border' : 'max-md:border-t max-md:border-app-border md:w-[360px] md:shrink-0 md:overflow-y-auto md:border-l md:border-app-border',
          )}
        >
          {aside}
        </aside>
      )}
    </div>
  );
}
