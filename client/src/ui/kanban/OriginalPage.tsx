import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import type { CrumbModel } from '../types';
import { BackButton, PaneHeader } from '../shell/PaneHeader';
import { FOCUS_RING } from '../shell/pressable';
import type { OriginalModel, QuoteMarkModel } from './model';
import { OriginalSheet } from './OriginalSheet';
import { ORIGINAL_ICON } from './glyphs';

/** Under this confidence a value reads amber. */
const SURE = 85;

export interface OriginalValueModel {
  id: string;
  label: string;
  value: string;
  confidence: number;
  corrected?: boolean;
}

/**
 * One original of a card, large, on a desk: the page as it was received,
 * with the words of every value read on it marked. Beside it (above it on a
 * phone) the values read here: pressing one marks its words strongly, as
 * pressing a mark does. Under them, the other originals of the same card. On
 * a phone the values sit two to a row and the originals wrap, so none hides
 * past the edge.
 */
export function OriginalPage({ back, crumbs, original, marks, active, onMark, values, others, onOther, copy, phone }: {
  back: { label: string; onClick: () => void };
  crumbs: CrumbModel[];
  original: OriginalModel;
  marks: QuoteMarkModel[];
  active?: string;
  onMark: (id: string) => void;
  values: OriginalValueModel[];
  others: Array<{ id: string; name: string; kind: OriginalModel['kind']; current?: boolean }>;
  onOther: (id: string) => void;
  copy: UiCopy;
  phone?: boolean;
}) {
  const o = copy.kanban.original;
  const Icon = ORIGINAL_ICON[original.kind];
  const aside = (
    <div className="flex flex-col gap-4">
      <section aria-label={o.values}>
        <h2 className="text-prose font-semibold text-app-text">{o.values}</h2>
        <p className="mb-2 text-compact text-app-text-tertiary">{values.length ? o.valuesHint : o.none}</p>
        <div className={clsx('gap-1.5', phone ? 'grid grid-cols-2' : 'flex flex-col')}>
          {values.map((v) => {
            const on = v.id === active;
            const sure = v.confidence >= SURE;
            return (
              <button
                key={v.id}
                type="button"
                aria-pressed={on}
                data-value={v.id}
                data-tip={v.corrected ? undefined : copy.kanban.detail.confidence(v.confidence)}
                onClick={() => onMark(v.id)}
                className={clsx(
                  'flex min-w-0 shrink-0 flex-col rounded-md border px-2.5 py-1.5 text-left transition-colors',
                  on ? 'border-amber-500/70 bg-amber-500/10' : 'border-app-border bg-surface hover:bg-app-hover',
                  FOCUS_RING,
                )}
              >
                <span className="flex items-center gap-2 text-mini text-app-text-tertiary">
                  <span className="min-w-0 flex-1 truncate">{v.label}</span>
                  <span className={clsx('shrink-0 font-semibold tabular-nums', v.corrected ? 'text-amber-700 dark:text-amber-400' : sure ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400')}>
                    {v.corrected ? copy.inbox.correctedByYou : `${v.confidence}%`}
                  </span>
                </span>
                <span className="text-prose font-medium leading-5 text-app-text [overflow-wrap:break-word]">{v.value}</span>
              </button>
            );
          })}
        </div>
      </section>
      {others.length > 1 && (
        <section aria-label={o.others}>
          <h2 className="mb-1.5 text-prose font-semibold text-app-text">{o.others}</h2>
          <div role="tablist" aria-label={o.others} className={clsx('flex gap-1', phone ? 'flex-wrap' : 'flex-col')}>
            {others.map((x) => {
              const XIcon = ORIGINAL_ICON[x.kind];
              return (
                <button
                  key={x.id}
                  type="button"
                  role="tab"
                  aria-selected={Boolean(x.current)}
                  onClick={() => onOther(x.id)}
                  className={clsx(
                    'inline-flex h-8 min-w-0 shrink-0 items-center gap-2 rounded-md px-2 text-left text-compact transition-colors',
                    x.current ? 'bg-primary/10 font-medium text-primary dark:text-primary-dark' : 'text-app-text-secondary hover:bg-app-hover hover:text-app-text',
                    FOCUS_RING,
                  )}
                >
                  <XIcon size={14} className="shrink-0" aria-hidden="true" />
                  <span className="truncate">{x.name}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <PaneHeader leading={<BackButton label={back.label} onClick={back.onClick} copy={copy} />} crumbs={phone ? crumbs.slice(-1) : crumbs} />
      <div className={clsx('flex min-h-0 flex-1', phone ? 'flex-col overflow-y-auto' : 'flex-row')}>
        {phone && <div className="border-b border-app-border px-4 py-3">{aside}</div>}
        {/* The desk tint only where it fills the pane: on a phone the page grows with the sheet and a tinted band would stop short of the bottom. */}
        <div className={clsx('min-w-0 flex-1', phone ? 'px-3 py-4' : 'overflow-y-auto bg-app-inset px-8 py-8')}>
          <div className="mx-auto mb-3 flex max-w-[720px] min-w-0 items-center gap-2 text-compact text-app-text-secondary">
            <Icon size={14} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />
            <span className="font-medium text-app-text">{original.kindLabel}</span>
            <span className="min-w-0 truncate">· {original.from}</span>
          </div>
          <OriginalSheet original={original} marks={marks} active={active} onMark={onMark} size="page" photoLabel={o.photo} />
        </div>
        {!phone && <aside className="w-[320px] shrink-0 overflow-y-auto border-l border-app-border px-4 py-5">{aside}</aside>}
      </div>
    </div>
  );
}
