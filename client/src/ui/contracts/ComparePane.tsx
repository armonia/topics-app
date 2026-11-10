import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { FOCUS_RING } from '../shell/pressable';
import type { CompareRowModel, DiffPartModel } from './model';

/** One run of words: removed struck through in red, added lit in green, the rest as is. */
function Parts({ parts }: { parts: DiffPartModel[] }) {
  return (
    <>
      {parts.map((p, i) => {
        const gap = i < parts.length - 1 ? ' ' : '';
        if (p.kind === 'removed') {
          return <span key={i}><del data-diff="del" className="rounded-sm bg-rose-500/15 text-rose-800 decoration-rose-600/70 dark:text-rose-300">{p.text}</del>{gap}</span>; // allow-italian: test hook named by the brief, not shown
        }
        if (p.kind === 'added') {
          return <span key={i}><ins data-diff="add" className="rounded-sm bg-emerald-500/20 text-emerald-900 no-underline dark:text-emerald-200">{p.text}</ins>{gap}</span>;
        }
        return <span key={i}>{p.text}{gap}</span>;
      })}
    </>
  );
}

const STATUS_TONE: Record<CompareRowModel['status'], string> = {
  same: 'text-app-text-tertiary',
  changed: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  added: 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300',
  removed: 'bg-rose-500/15 text-rose-800 dark:text-rose-300',
};

/**
 * Two versions of a contract side by side, aligned by clause number: the
 * older text on the left with what it loses, the newer on the right with what
 * it gains, word by word. A changed clause carries `data-changed`; the one the
 * arrows point at is ringed and scrolled to. On a phone the two become one
 * column with the differences inline.
 */
export function ComparePane({ rows, fromLabel, toLabel, focusId, focusKey, onOpenClause, copy, phone }: {
  rows: CompareRowModel[];
  fromLabel: string;
  toLabel: string;
  /** The clause the arrows point at. */
  focusId?: string;
  /** Changes every time the arrows move, so the same clause is scrolled to again. */
  focusKey?: string;
  onOpenClause: (id: string) => void;
  copy: UiCopy;
  phone: boolean;
}) {
  const t = copy.contracts.compare;
  const scrollTo = (id: string) => (el: HTMLElement | null) => {
    // Brings the clause the arrows point at into view, once per move.
    if (el && id === focusId && focusKey && el.dataset.seen !== focusKey) {
      el.dataset.seen = focusKey;
      el.scrollIntoView?.({ block: 'center' });
    }
  };
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-app-border bg-surface">
      {!phone && (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] border-b border-app-border bg-app-inset text-compact font-medium text-app-text-secondary">
          <span className="border-r border-app-border px-4 py-2">{fromLabel}</span>
          <span className="px-4 py-2">{toLabel}</span>
        </div>
      )}
      <ol>
        {rows.map((r) => {
          const changed = r.status !== 'same';
          return (
            <li
              key={r.id}
              data-compare-clause={r.id}
              data-changed={changed ? 'true' : undefined}
              ref={scrollTo(r.id)}
              className={clsx('border-b border-app-border last:border-b-0', r.id === focusId && 'ring-2 ring-inset ring-sky-500/50')}
            >
              <div className="flex items-start gap-2 px-4 pt-2.5">
                <button type="button" onClick={() => onOpenClause(r.id)} className={clsx('min-w-0 rounded text-left text-prose font-semibold leading-5 text-app-text [overflow-wrap:break-word] hover:underline', FOCUS_RING)}>
                  {copy.contracts.page.clauseHeading(r.n, r.title)}
                </button>
                <span className={clsx('inline-flex h-5 shrink-0 items-center rounded px-1.5 text-mini', STATUS_TONE[r.status])}>{t.status[r.status]}</span>
              </div>
              {phone ? (
                <p className="px-4 pb-3 pt-1 font-serif text-body-lg leading-7 text-app-text"><Parts parts={r.inline} /></p>
              ) : (
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  <p className={clsx('border-r border-app-border px-4 pb-3 pt-1 font-serif text-body-lg leading-7', changed ? 'text-app-text' : 'text-app-text-secondary')}>
                    {r.status === 'added' ? <span className="font-sans text-compact italic text-app-text-tertiary">{t.notThere}</span> : <Parts parts={r.left} />}
                  </p>
                  <p className={clsx('px-4 pb-3 pt-1 font-serif text-body-lg leading-7', changed ? 'text-app-text' : 'text-app-text-secondary')}>
                    {r.status === 'removed' ? <span className="font-sans text-compact italic text-app-text-tertiary">{t.notThere}</span> : <Parts parts={r.right} />}
                  </p>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
