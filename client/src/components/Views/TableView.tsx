/**
 * The `table` view (GENUI-06): rows read across columns.
 *
 * Two layouts of the same data, chosen by the CONTAINER like `compare`:
 *  - wide: a real `<table>`, numbers right-aligned in tabular figures, the
 *    recommended row outlined, the best value of a ranked column tinted;
 *  - narrow (a chat column, a phone): one card per row, the first cell as its
 *    name and the others as label/value pairs, because a 5-column table at
 *    390 px is either unreadable or a sideways scroll.
 * Both are in the DOM and one is `display: none`, so assistive tech reads one.
 */
import { useMemo } from 'react';
import { Check } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { rankColumns, type CellRank, type TableCell, type TableColumn, type TableViewSpec } from '../../../../shared/views-table';
import { cellText } from '../../../../shared/views-format';
import { ViewHeader, ViewLink, type ViewVariant } from './ViewChrome';

function Cell({ value, col, rank, locale }: { value: TableCell; col: TableColumn; rank: CellRank; locale: string }) {
  const tr = useT();
  const text = cellText(value, col, locale);
  if (text === null) return <span className="text-app-text-muted">{tr('views.metric.missing')}</span>;
  return (
    <span
      data-testid="table-cell-value"
      data-rank={rank ?? ''}
      className={rank === 'best' ? 'rounded bg-emerald-500/10 px-1 font-semibold text-emerald-800 dark:text-emerald-300' : undefined}
    >
      {text}
      {rank === 'best' && <span className="sr-only">, {tr('views.metric.best')}</span>}
    </span>
  );
}

export function TableView({ spec, variant, locale }: { spec: TableViewSpec; variant: ViewVariant; locale: string }) {
  const tr = useT();
  const ranks = useMemo(() => rankColumns(spec), [spec]);
  const [first, ...rest] = spec.columns;
  const linkClass = 'inline-flex min-h-9 items-center gap-1 rounded px-1.5 text-compact font-medium text-app-text-secondary underline-offset-2 hover:bg-app-hover hover:text-app-text coarse:min-h-11';

  return (
    <section data-testid="table-view" data-variant={variant} data-rows={spec.rows.length} className="@container min-w-0">
      <ViewHeader kind="table" title={spec.title} subtitle={spec.subtitle} verdict={spec.verdict} variant={variant} />

      {/* Wide: the table. */}
      <div className="hidden overflow-hidden rounded-lg border border-app-border bg-surface @xl:block">
        <table data-testid="table-grid" className="w-full border-collapse text-compact text-app-text">
          <caption className="sr-only">{spec.title}</caption>
          <thead className="bg-app-inset text-mini text-app-text-secondary">
            <tr>
              {spec.columns.map((c, j) => (
                <th key={j} scope="col" className={`px-3 py-2 font-semibold ${c.align === 'end' ? 'text-right' : 'text-left'}`}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {spec.rows.map((r, i) => (
              <tr
                key={i}
                data-testid="table-row"
                data-recommended={r.recommended ? 'true' : 'false'}
                className={`border-t border-app-border align-top ${r.recommended ? 'bg-primary/5 shadow-[inset_3px_0_0_var(--primary)]' : ''}`}
              >
                {r.cells.map((v, j) => {
                  const col = spec.columns[j];
                  const Tag = j === 0 ? 'th' : 'td';
                  return (
                    <Tag
                      key={j}
                      {...(j === 0 ? { scope: 'row' } : {})}
                      className={`px-3 py-2 ${j === 0 ? 'text-left font-semibold text-app-text-heading' : ''} ${col.align === 'end' ? 'text-right tabular-nums' : ''}`}
                    >
                      {j === 0 && r.recommended && <RecommendedBadge />}
                      <Cell value={v} col={col} rank={ranks[i][j]} locale={locale} />
                      {j === 0 && r.note && <span className="block text-mini font-normal text-app-text-muted">{r.note}</span>}
                      {/* On a line of its own: inline, the label ran into the row's name. */}
                      {j === 0 && r.link && (
                        <div>
                          <ViewLink url={r.link.url} variant={variant} testId="table-link" className={`-ml-1.5 ${linkClass}`}>
                            {r.link.label ?? tr('views.openLink')}
                          </ViewLink>
                        </div>
                      )}
                    </Tag>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Narrow: a card per row. */}
      <ul data-testid="table-cards" aria-label={spec.title} className="space-y-2 @xl:hidden">
        {spec.rows.map((r, i) => (
          <li
            key={i}
            data-testid="table-card"
            data-recommended={r.recommended ? 'true' : 'false'}
            className={`rounded-lg border bg-surface px-3 py-2.5 ${r.recommended ? 'border-primary ring-1 ring-primary' : 'border-app-border'}`}
          >
            {r.recommended && <RecommendedBadge />}
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="min-w-0 text-body-lg font-semibold leading-snug text-app-text-heading">
                <Cell value={r.cells[0]} col={first} rank={ranks[i][0]} locale={locale} />
              </h3>
              {r.link && (
                <ViewLink url={r.link.url} variant={variant} testId="table-link" className={`shrink-0 ${linkClass}`}>
                  {r.link.label ?? tr('views.openLink')}
                </ViewLink>
              )}
            </div>
            {r.note && <p className="text-mini text-app-text-muted">{r.note}</p>}
            <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-compact">
              {rest.map((c, k) => (
                <div key={k} className="flex min-w-0 flex-col-reverse">
                  <dt className="text-mini text-app-text-secondary">{c.label}</dt>
                  <dd className="tabular-nums text-app-text">
                    <Cell value={r.cells[k + 1]} col={c} rank={ranks[i][k + 1]} locale={locale} />
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>

      {spec.footnote && <p data-testid="table-footnote" className="mt-2 text-mini text-app-text-muted">{spec.footnote}</p>}
    </section>
  );
}

function RecommendedBadge() {
  const tr = useT();
  return (
    <span data-testid="table-recommended" className="mb-1 mr-1.5 inline-flex items-center gap-1 rounded-sm bg-primary px-1.5 py-0.5 align-middle text-mini font-semibold text-white">
      <Check size={11} strokeWidth={3} aria-hidden />
      {tr('views.recommended')}
    </span>
  );
}
