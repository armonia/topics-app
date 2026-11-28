/**
 * THE PROJECT'S QUOTA METER on its sidebar row: "7/10", the points the project
 * spent in the last 24 hours over its limit. Amber from 80% of the limit, red
 * above it (`quotaTone`, the same rule the Dashboard table uses).
 *
 * It says nothing when it has nothing true to say: no reading yet, no quota
 * history, or a project with no limit and no spend. With spend but no limit it
 * shows the points alone, in the neutral tone.
 */
import { useT } from '../../hooks/useT';
import { useProjectQuota } from '../../hooks/useProjectQuota';
import { useProjectPause } from '../../hooks/useProjectPause';
import { boardIdForPath } from '../../lib/board';
import { formatPoints, quotaTone, type QuotaTone } from '../../lib/projectQuotaMeter';
import { DANGER_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import { ON_FILL_TEXT_SOFT } from '../../lib/selectionStyles';


const TONE_INK: Record<QuotaTone, string> = { ok: 'text-app-text-faint/70', warn: WARNING_TEXT, over: DANGER_TEXT };

export function ProjectQuotaMeter({ projectPath, onFill }: { projectPath: string; onFill?: boolean }) {
  const tr = useT();
  const { quota } = useProjectQuota();
  const projectId = boardIdForPath(projectPath);
  const row = quota?.projects.find((p) => p.projectId === projectId);
  const pause = useProjectPause(projectId);
  if (pause.paused) {
    return (
      <span
        data-testid="project-quota-meter"
        data-tone="over"
        data-paused="true"
        title={tr('projectPause.title.' + (pause.reason === 'hold-until-tomorrow' ? 'hold' : 'limit'))}
        className={`ml-0.5 flex-shrink-0 text-mini leading-none ${onFill ? ON_FILL_TEXT_SOFT : DANGER_TEXT}`}
      >
        {tr('projectPause.meter')}
      </span>
    );
  }
  if (!row || row.points24h === null) return null;
  if (row.limit === null) {
    if (row.points24h <= 0) return null;
    const spent = formatPoints(row.points24h);
    return (
      <span
        data-testid="project-quota-meter"
        data-tone="ok"
        title={tr('projectQuota.meterNoLimit', { points: spent })}
        className={`ml-0.5 flex-shrink-0 text-mini leading-none tabular-nums ${onFill ? ON_FILL_TEXT_SOFT : TONE_INK.ok}`}
      >
        {spent}
      </span>
    );
  }
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
