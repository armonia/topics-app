/**
 * THE PROJECT'S QUOTA METER on its sidebar row: "7/10", the points the project
 * spent in the last 24 hours over its limit. Amber from 80% of the limit, red
 * above it (`quotaTone`, the same rule the Dashboard table uses).
 *
 * It says nothing when it has nothing true to say: no reading yet, no quota
 * history, or a project with no limit and no spend.
 */
import { useT } from '../../hooks/useT';
import { useProjectQuota } from '../../hooks/useProjectQuota';
import { boardIdForPath } from '../../lib/board';
import { formatPoints, quotaTone, type QuotaTone } from '../../lib/projectQuotaMeter';
import { DANGER_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import { ON_FILL_TEXT_SOFT } from '../../lib/selectionStyles';


const TONE_INK: Record<QuotaTone, string> = { ok: 'text-app-text-faint/70', warn: WARNING_TEXT, over: DANGER_TEXT };

export function ProjectQuotaMeter({ projectPath, onFill }: { projectPath: string; onFill?: boolean }) {
  const tr = useT();
  const { quota } = useProjectQuota();
  const row = quota?.projects.find((p) => p.projectId === boardIdForPath(projectPath));
  if (!row || row.points24h === null || row.limit === null) return null;
  const tone = quotaTone(row.points24h, row.limit);
  const points = formatPoints(row.points24h);
  return (
    <span
      data-testid="project-quota-meter"
      data-tone={tone}
      title={tr('projectQuota.meter', { points, limit: row.limit })}
      className={`ml-0.5 flex-shrink-0 text-mini leading-none tabular-nums ${onFill ? ON_FILL_TEXT_SOFT : TONE_INK[tone]}`}
    >
      {points}/{row.limit}
    </span>
  );
}
