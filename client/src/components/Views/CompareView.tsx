/**
 * The `compare` view (GENUI-01): 2-4 options side by side, drawn from data.
 *
 * ONE component for both places it appears, the chat block and the standalone
 * page, so the two can never disagree. What changes between them is only the
 * room it gets, and the layout answers to its CONTAINER, not the window: a
 * chat column 600 px wide on a 27" screen is a phone as far as three cards are
 * concerned.
 *  - narrow container: the cards are a horizontal snap strip, one card and the
 *    edge of the next in sight, so it is obvious there is more;
 *  - wide container: a grid, one column per option, rows aligned (metrics are
 *    laid out in the same order on every card, missing ones keep their slot).
 *
 * Nothing here invents styling: tokens and type scale of the app only, so dark
 * and light follow the app's theme and the contrast rules already measured
 * in `index.css` hold.
 */
import { useMemo, useRef, useState, type MouseEvent } from 'react';
import { ArrowUpRight, Check, ChevronLeft, ChevronRight, Minus } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { openLink, isExternalLinkGesture } from '../../lib/openLink';
import { rankMetrics, type CompareOption, type CompareViewSpec, type MetricRank, type ViewMetric } from '../../../../shared/views';
import { viewImageUrl } from './viewRoute';

type Variant = 'chat' | 'page';

export function formatPrice(amount: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    }).format(amount);
  } catch {
    // An unknown currency code is still a price: show the code after it.
    return `${amount} ${currency}`;
  }
}

/** Metric labels in order of first appearance across options: the shared row order. */
export function metricOrder(options: readonly CompareOption[]): string[] {
  const seen: string[] = [];
  for (const o of options) for (const m of o.metrics ?? []) if (!seen.includes(m.label)) seen.push(m.label);
  return seen;
}

/**
 * From which container width the strip becomes a grid, per option count: about
 * 13-14rem per card. Literal class strings, because Tailwind only generates
 * the classes it can read in the source.
 */
const LAYOUT: Record<2 | 3 | 4, { list: string; item: string; cell: string }> = {
  2: { list: '@md:grid @md:grid-cols-2 @md:gap-y-0 @md:overflow-visible', item: '@md:w-auto @md:row-span-5 @md:grid @md:grid-rows-subgrid', cell: '@md:row-span-5 @md:grid @md:grid-rows-subgrid' },
  3: { list: '@2xl:grid @2xl:grid-cols-3 @2xl:gap-y-0 @2xl:overflow-visible', item: '@2xl:w-auto @2xl:row-span-5 @2xl:grid @2xl:grid-rows-subgrid', cell: '@2xl:row-span-5 @2xl:grid @2xl:grid-rows-subgrid' },
  4: { list: '@4xl:grid @4xl:grid-cols-4 @4xl:gap-y-0 @4xl:overflow-visible', item: '@4xl:w-auto @4xl:row-span-5 @4xl:grid @4xl:grid-rows-subgrid', cell: '@4xl:row-span-5 @4xl:grid @4xl:grid-rows-subgrid' },
};

export function CompareView({ spec, variant, locale }: { spec: CompareViewSpec; variant: Variant; locale: string }) {
  const tr = useT();
  const ranks = useMemo(() => rankMetrics(spec.options), [spec.options]);
  const order = useMemo(() => metricOrder(spec.options), [spec.options]);
  const n = spec.options.length;
  const layout = LAYOUT[Math.min(Math.max(n, 2), 4) as 2 | 3 | 4];
  const page = variant === 'page';

  return (
    <section data-testid="compare-view" data-variant={variant} data-options={n} className="@container min-w-0">
      <header className={page ? 'mb-4' : 'mb-2'}>
        <h2 data-testid="compare-title" className={`${page ? 'text-headline' : 'text-title'} font-semibold leading-tight text-app-text-heading`}>
          {spec.title}
        </h2>
        {spec.subtitle && <p className="mt-0.5 text-compact text-app-text-secondary">{spec.subtitle}</p>}
      </header>
      {spec.verdict && (
        <p data-testid="compare-verdict" className={`${page ? 'mb-4 text-body-lg' : 'mb-3 text-prose'} rounded border border-app-border bg-app-inset px-3 py-2 text-app-text`}>
          <span className="mr-1.5 font-semibold text-app-text-heading">{tr('views.verdict')}:</span>
          {spec.verdict}
        </p>
      )}
      <ul
        data-testid="compare-options"
        // As a strip it scrolls sideways, and a region that scrolls must be
        // reachable from the keyboard (arrow keys scroll it once focused).
        tabIndex={0}
        aria-label={spec.title}
        className={`-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-2 ${layout.list}`}
      >
        {spec.options.map((o, i) => (
          <li
            key={i}
            className={`flex w-[min(82%,20rem)] shrink-0 snap-start ${layout.item}`}
          >
            <OptionCard option={o} ranks={ranks[i]} order={order} locale={locale} page={page} cell={layout.cell} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function OptionCard({ option, ranks, order, locale, page, cell }: {
  option: CompareOption; ranks: Record<string, MetricRank>; order: string[]; locale: string; page: boolean; cell: string;
}) {
  const tr = useT();
  const rec = !!option.recommended;
  const metricsByLabel = new Map(option.metrics?.map((m) => [m.label, m]) ?? []);
  const hasPoints = !!(option.pros?.length || option.cons?.length);
  // Five sections, always five children, so that in the grid each one sits on
  // the same row of a subgrid as its neighbours' (photo, head, metrics, points,
  // link): the metrics of three cards line up even when one title wraps. An
  // absent section is an empty cell, not a missing one.
  return (
    <article
      data-testid="compare-option"
      data-recommended={rec ? 'true' : 'false'}
      aria-label={rec ? `${option.title}, ${tr('views.recommended')}` : option.title}
      className={`flex w-full min-w-0 flex-col overflow-hidden rounded-lg border bg-surface ${cell} ${rec ? 'border-primary ring-1 ring-primary' : 'border-app-border'}`}
    >
      {option.images && option.images.length > 0 ? <Gallery images={option.images} title={option.title} tall={page} /> : <div />}
      <div className="px-3 pt-3">
        {rec && (
          <span data-testid="compare-recommended" className="mb-1.5 inline-flex items-center gap-1 rounded-sm bg-primary px-1.5 py-0.5 text-mini font-semibold text-white">
            <Check size={11} strokeWidth={3} aria-hidden />
            {tr('views.recommended')}
          </span>
        )}
        {/* Name and price share the first line; everything else gets the
            card's full width, or a 20-character note squeezes the name into
            two lines and the description into five. */}
        <div className="flex items-baseline justify-between gap-3">
          <h3 data-testid="compare-option-title" className="min-w-0 text-body-lg font-semibold leading-snug text-app-text-heading">{option.title}</h3>
          {option.price && (
            <span data-testid="compare-price" className="shrink-0 text-title font-semibold tabular-nums text-app-text-heading">
              {formatPrice(option.price.amount, option.price.currency, locale)}
            </span>
          )}
        </div>
        {option.price?.note && <p className="text-right text-mini text-app-text-muted">{option.price.note}</p>}
        {option.subtitle && <p className="mt-1 text-compact leading-snug text-app-text-secondary">{option.subtitle}</p>}
      </div>

      {order.length > 0 ? (
        <dl data-testid="compare-metrics" className="grid grid-cols-2 content-start gap-1.5 px-3 pt-2.5">
          {order.map((label) => (
            <Metric key={label} label={label} metric={metricsByLabel.get(label)} rank={ranks[label]} />
          ))}
        </dl>
      ) : <div />}

      {hasPoints ? (
        <ul data-testid="compare-points" className="space-y-1 px-3 pt-2.5 text-compact leading-snug text-app-text">
          {option.pros?.map((p, j) => (
            <li key={`p${j}`} className="flex gap-1.5">
              <Check size={14} className="mt-px shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden />
              <span><span className="sr-only">{tr('views.pro')}: </span>{p}</span>
            </li>
          ))}
          {option.cons?.map((c, j) => (
            <li key={`c${j}`} className="flex gap-1.5">
              <Minus size={14} className="mt-px shrink-0 text-red-700 dark:text-red-400" aria-hidden />
              <span><span className="sr-only">{tr('views.con')}: </span>{c}</span>
            </li>
          ))}
        </ul>
      ) : <div />}

      <div className="mt-auto flex flex-col justify-end px-3 pb-3 pt-3">
        {option.link && (
          <a
            data-testid="compare-link"
            href={option.link.url}
            target="_blank"
            rel="noreferrer"
            onClick={(e: MouseEvent<HTMLAnchorElement>) => {
              // Inside the app the page opens as a tab of the Topics browser,
              // like every other link in a chat; on the standalone page the
              // browser does what it always does.
              if (page) return;
              e.preventDefault();
              openLink(option.link!.url, { external: isExternalLinkGesture(e), origin: e.target });
            }}
            className="inline-flex min-h-9 items-center justify-center gap-1 rounded border border-app-border px-3 text-compact font-medium text-app-text hover:bg-app-hover coarse:min-h-11"
          >
            {option.link.label ?? tr('views.openLink')}
            <ArrowUpRight size={13} aria-hidden />
          </a>
        )}
      </div>
    </article>
  );
}

const RANK_CLASS: Record<'best' | 'worst', string> = {
  best: 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300',
  worst: 'bg-red-500/10 text-red-800 dark:text-red-300',
};

function Metric({ label, metric, rank }: { label: string; metric?: ViewMetric; rank: MetricRank }) {
  const tr = useT();
  return (
    <div
      data-testid="compare-metric"
      data-rank={rank ?? ''}
      // The term comes first in the DOM (a <dl> wants dt before dd) and second
      // on screen: the number is what the eye compares across cards.
      className={`flex flex-col-reverse rounded px-2 py-1.5 ${rank ? RANK_CLASS[rank] : 'bg-app-inset text-app-text'}`}
    >
      <dt className={`text-mini leading-tight ${rank ? '' : 'text-app-text-secondary'}`}>{label}</dt>
      <dd className="text-body-lg font-semibold leading-tight tabular-nums">
        {metric ? metric.value : <span className="text-app-text-muted">{tr('views.metric.missing')}</span>}
        {metric?.unit && <span className="ml-0.5 text-mini font-normal">{metric.unit}</span>}
        {rank && <span className="sr-only">, {tr(rank === 'best' ? 'views.metric.best' : 'views.metric.worst')}</span>}
      </dd>
    </div>
  );
}

/**
 * Photos as a snap strip with buttons: swipe on a phone, click or arrow keys
 * with a mouse. The counter says how many there are, which a strip alone hides.
 */
function Gallery({ images, title, tall }: { images: NonNullable<CompareOption['images']>; title: string; tall: boolean }) {
  const tr = useT();
  const strip = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(0);
  // While a button-driven scroll glides, the scroll events pass over the photos
  // in between: the counter would tick back before it ticks forward.
  const target = useRef<number | null>(null);
  const go = (delta: number) => {
    const el = strip.current;
    if (!el) return;
    const next = Math.max(0, Math.min(images.length - 1, at + delta));
    target.current = next;
    el.scrollTo({ left: next * el.clientWidth, behavior: 'smooth' });
    setAt(next);
  };
  return (
    <div className="relative bg-app-inset" data-testid="compare-gallery">
      <div
        ref={strip}
        tabIndex={0}
        role="group"
        aria-label={tr('views.gallery.label', { title })}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.clientWidth <= 0) return;
          const here = Math.round(el.scrollLeft / el.clientWidth);
          if (target.current !== null) {
            if (here === target.current) target.current = null;
            return;
          }
          setAt(here);
        }}
        className={`flex snap-x snap-mandatory overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${tall ? 'h-52' : 'h-40'}`}
      >
        {images.map((im, k) => (
          <figure key={k} className="relative h-full w-full shrink-0 snap-start">
            <img
              src={viewImageUrl(im.src)}
              alt={im.caption ? `${title}: ${im.caption}` : title}
              loading={k === 0 ? 'eager' : 'lazy'}
              decoding="async"
              className="h-full w-full object-cover"
            />
            {im.caption && (
              // Over a photo the ground is dark in both themes: white on a
              // dark veil is the one pairing that reads on any image.
              <figcaption className="absolute bottom-2 left-2 max-w-[80%] truncate rounded-sm bg-black/65 px-1.5 py-0.5 text-mini text-white">
                {im.caption}
              </figcaption>
            )}
          </figure>
        ))}
      </div>
      {images.length > 1 && (
        <>
          <span data-testid="compare-gallery-count" className="absolute right-2 top-2 rounded-sm bg-black/65 px-1.5 py-0.5 text-mini tabular-nums text-white">
            {tr('views.gallery.count', { i: at + 1, n: images.length })}
          </span>
          <button
            type="button"
            onClick={() => go(-1)}
            disabled={at === 0}
            aria-label={tr('views.gallery.prev')}
            className="absolute left-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white disabled:opacity-0 coarse:h-11 coarse:w-11"
          >
            <ChevronLeft size={16} aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => go(1)}
            disabled={at === images.length - 1}
            aria-label={tr('views.gallery.next')}
            className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white disabled:opacity-0 coarse:h-11 coarse:w-11"
          >
            <ChevronRight size={16} aria-hidden />
          </button>
        </>
      )}
    </div>
  );
}
