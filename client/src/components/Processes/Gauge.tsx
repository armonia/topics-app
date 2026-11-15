import { useT } from '../../hooks/useT';
import { WARNING_TEXT } from '../../lib/popoverStyles';
import type { HistoryPoint } from '../../lib/machineProcesses';
import { FAINT } from './processesStyles';

const TRACK = 'bg-black/[0.07] dark:bg-white/[0.08]';

/**
 * The last 24 h of one gauge as a line, scaled to 0..100 %: the shape of the
 * day, not a second number.
 */
function Spark({ points, warn }: { points: HistoryPoint[]; warn: boolean }) {
  const tr = useT();
  const t0 = points[0].t;
  const span = Math.max(1, points[points.length - 1].t - t0);
  const W = 100;
  const H = 18;
  const xy = points.map((p) => `${((p.t - t0) / span * W).toFixed(1)},${(H - Math.max(0, Math.min(100, p.v)) / 100 * H).toFixed(1)}`);
  const peak = Math.round(Math.max(...points.map((p) => p.v)));
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={`mt-1.5 block h-[18px] w-full ${warn ? 'text-amber-500' : 'text-app-text-tertiary'}`}
      role="img"
      aria-label={tr('processes.history', { peak })}
      data-testid="machine-gauge-history"
    >
      <title>{tr('processes.history', { peak })}</title>
      <polygon points={`0,${H} ${xy.join(' ')} ${W},${H}`} fill="currentColor" opacity={0.12} />
      <polyline points={xy.join(' ')} fill="none" stroke="currentColor" strokeWidth={1.2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

export function Gauge({ label, value, unit, share, warn = false, history = [], note = null, testId }: { label: string; value: string; unit?: string; share: number | null; warn?: boolean; history?: HistoryPoint[]; note?: string | null; testId?: string }) {
  return (
    <div className="min-w-0 border-r border-app-border-subtle px-2.5 pb-2.5 pt-[9px] last:border-r-0 @max-3xl:[&:nth-child(3)]:border-r-0 @max-3xl:[&:nth-child(n+4)]:border-t" data-testid={testId} title={note ?? undefined}>
      <div className={`text-mini uppercase tracking-[0.04em] ${FAINT}`}>{label}</div>
      <div className="mt-0.5 whitespace-nowrap text-body-lg text-app-text @max-3xl:text-prose">
        {value}{unit && <span className={`text-mini ${FAINT}`}> {unit}</span>}
      </div>
      {note && <div className={`truncate text-mini ${warn ? WARNING_TEXT : FAINT}`} data-testid="machine-gauge-note">{note}</div>}
      {/* With a day of samples the line replaces the bar. */}
      {history.length >= 2 ? <Spark points={history} warn={warn} /> : (
        <div className={`mt-1.5 h-[3px] overflow-hidden rounded-sm ${TRACK}`}>
          {share !== null && <i className={`block h-full rounded-sm ${warn ? 'bg-amber-500' : 'bg-app-text-tertiary'}`} style={{ width: `${Math.round(Math.min(1, share) * 100)}%` }} />}
        </div>
      )}
    </div>
  );
}

