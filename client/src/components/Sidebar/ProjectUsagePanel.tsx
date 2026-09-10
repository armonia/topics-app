/**
 * WHAT EACH PROJECT HAS COST, in tokens and in the dollars that have a price.
 *
 * ── WHY IT IS A LEVEL OF ITS OWN, AND NOT A COLUMN ON THE INVENTORY ─────────
 * The panel above already answers "what is holding the memory", per project,
 * in megabytes. This answers a different question with the same subject, and in
 * a THIRD unit: megabytes, counts and tokens never share a column in this
 * subsystem, and the reason is written in `featureWeight.ts` - the type itself
 * exists to stop two of them being added. A token column pasted next to the MB
 * column would be read as its neighbour's dimension, which is exactly the
 * mistake the whole inventory was built to avoid. Different unit, different
 * level, one gesture away.
 *
 * ── ONE READ PER OPENING ────────────────────────────────────────────────────
 * The route is a GROUP BY over the whole message table (1,2 s cold, 91 ms warm,
 * cached 60 s server-side). It is read when this panel mounts and when the
 * window changes, and never on a timer. See `useProjectUsage`.
 *
 * ── THE MONEY IS A FLOOR ────────────────────────────────────────────────────
 * About a quarter of the consumption on this installation is board work whose
 * tokens carry no input/output split and therefore no price. The line under the
 * list says so whenever the payload declares it, because a dollar figure shown
 * on its own reads as the bill, and this one is not.
 */
import { FolderGit2 } from 'lucide-react';
import { useLocale, useT } from '@/hooks/useT';
import { useProjectUsage, type ProjectUsageRow, type UsageRange } from '@/hooks/useProjectUsage';

/** The windows offered, in the order a person narrows: today, the week, the
 *  month, everything. `all` is where the panel opens, because "what has this
 *  cost me" is the question that brings people here. */
const RANGES: UsageRange[] = ['1d', '7d', '30d', 'all'];

/** How many rows before the list stops being a list. Past this the tail is
 *  projects that consumed a rounding error, and it is `overflow-y-auto` anyway
 *  - the cap is about the reading, not about the height. */
const MAX_ROWS = 12;

export function ProjectUsagePanel({ range, onRange }: {
  range: UsageRange;
  onRange: (r: UsageRange) => void;
}) {
  const tr = useT();
  const locale = useLocale();
  const { usage, loading, error } = useProjectUsage(true, range);

  const compact = new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  });
  const money = new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });

  const rows = usage?.projects.slice(0, MAX_ROWS) ?? [];
  const hidden = (usage?.projects.length ?? 0) - rows.length;

  return (
    <div data-testid="project-usage-panel" className="min-w-0 p-2 text-[11px]">
      {/* THE WINDOW, as four buttons and not a dropdown: there are four of them,
          they are two characters each, and a dropdown would hide the current
          answer behind a gesture on a panel whose whole point is the number. */}
      <div className="mb-1.5 flex items-center gap-1">
        {RANGES.map((r) => (
          <button
            key={r}
            type="button"
            data-testid={`usage-range-${r}`}
            aria-pressed={r === range}
            onClick={() => onRange(r)}
            className={`rounded px-1.5 py-0.5 text-[10.5px] ${r === range
              ? 'bg-primary/15 font-medium text-primary'
              : 'text-app-text-secondary hover:bg-app-hover'}`}
          >
            {tr(`usage.range.${r}`)}
          </button>
        ))}
        {usage && (
          <span className="ml-auto flex-shrink-0 text-[10px] text-app-text-faint" title={usage.cachedAt}>
            {tr('usage.readAt', { time: formatTime(usage.cachedAt, locale) })}
          </span>
        )}
      </div>

      {error && <div className="px-1 py-2 text-app-text-secondary">{tr('usage.failed')}</div>}
      {!error && !usage && loading && (
        <div className="px-1 py-2 text-app-text-muted">{tr('common.loading')}</div>
      )}
      {!error && usage && rows.length === 0 && (
        <div className="px-1 py-2 text-app-text-secondary">{tr('usage.none')}</div>
      )}

      {rows.length > 0 && (
        <div className="max-h-[280px] overflow-y-auto">
          {/* A HEADER, because this one IS a table: two numeric columns that
              have to be read down, not across. The inventory above is a list
              and has none, and the difference is the point. */}
          <div className="flex items-center gap-2 px-1 pb-1 text-[10px] uppercase tracking-wide text-app-text-faint">
            <span className="min-w-0 flex-1">{tr('usage.colProject')}</span>
            <span className="w-14 flex-shrink-0 text-right">{tr('usage.colTokens')}</span>
            <span className="w-12 flex-shrink-0 text-right">{tr('usage.colCost')}</span>
          </div>
          {rows.map((p) => (
            <Row key={p.projectId} p={p} compact={compact} money={money} tr={tr} />
          ))}
          {hidden > 0 && (
            <div className="px-1 pt-1 text-[10px] text-app-text-faint">
              {tr('usage.more', { n: hidden })}
            </div>
          )}
        </div>
      )}

      {/* THE FLOOR, SAID OUT LOUD. `cost.partial` is a field and not an
          inference: the payload knows which half it could not price. */}
      {usage?.cost.partial && (
        <div data-testid="usage-partial" className="mt-1.5 border-t border-app-border pt-1.5 text-[10px] leading-snug text-app-text-secondary">
          {tr('usage.costFloor', {
            tokens: compact.format(usage.cost.excluded.taskTokens),
            total: compact.format(usage.totals.totalTokens),
          })}
          {usage.cost.excluded.models.length > 0 && (
            <> {tr('usage.unpricedModels', { models: usage.cost.excluded.models.join(', ') })}</>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ p, compact, money, tr }: {
  p: ProjectUsageRow;
  compact: Intl.NumberFormat;
  money: Intl.NumberFormat;
  tr: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <div
      data-testid="usage-project-row"
      className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-app-hover"
      // The breakdown that makes the total honest: chats and board work are two
      // different kinds of spending, and only one of them can be priced.
      title={[
        p.projectPath ?? p.projectId,
        tr('usage.rowChats', { tokens: compact.format(p.chatTokens), n: p.messageCount }),
        tr('usage.rowTasks', { tokens: compact.format(p.taskTokens), n: p.taskCount }),
        p.unpricedMessages > 0 ? tr('usage.rowUnpriced', { n: p.unpricedMessages }) : '',
      ].filter(Boolean).join('\n')}
    >
      <FolderGit2 size={11} className="flex-shrink-0 text-app-text-muted" />
      <span className="min-w-0 flex-1 truncate text-app-text">{projectName(p)}</span>
      <span className="w-14 flex-shrink-0 text-right tabular-nums text-app-text">
        {compact.format(p.totalTokens)}
      </span>
      <span className="w-12 flex-shrink-0 text-right tabular-nums text-app-text-secondary">
        {p.costUsd > 0 ? money.format(p.costUsd) : '-'}
      </span>
    </div>
  );
}

/** The name a person uses for the project: the last segment of the path, or the
 *  id when only board rows exist and the path is not recoverable. */
function projectName(p: ProjectUsageRow): string {
  if (!p.projectPath) return p.projectId;
  const parts = p.projectPath.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p.projectPath;
}

function formatTime(iso: string, locale: string): string {
  try {
    return new Date(iso).toLocaleTimeString(locale === 'it' ? 'it-IT' : 'en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
