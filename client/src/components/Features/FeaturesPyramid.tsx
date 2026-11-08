/**
 * The two parts of the feature map that say what Jarvis itself needs
 * (hub-smistamento, HUBBR-18), drawn above the comparison with the others.
 *
 * The pyramid: seven levels from the channels up, each a row as wide as its
 * place (the base holds up what sits on it), with a four-colour bar and how
 * many of the functions it needs are covered. A level opens in place, one at a
 * time, with what the level is and its functions: outcome, where they live in
 * the code, their real use over fourteen days.
 *
 * What is missing, decided: one tile per decision taken on the features Jarvis
 * does not fully have, and the list of the ones still to build, by priority.
 */
import { useState } from 'react';
import type { useT } from '../../hooks/useT';
import { BAND_OF, PYRAMID_BANDS, type PyramidBand, type PyramidLevel, type PyramidView } from '../../lib/hubPyramid';
import type { FeaturesView, PlanKind } from '../../lib/hubFeatures';
import { PLAN_CHIP } from './featureStyles';

type Tr = ReturnType<typeof useT>;

export const SECTION = 'mb-1.5 mt-[18px] flex items-center gap-2 text-mini font-semibold uppercase tracking-[0.04em] text-app-text-tertiary';
export const SECTION_COUNT = 'font-medium normal-case tracking-normal text-app-text-muted tabular-nums';
export const SECTION_REST = 'ml-auto truncate font-normal normal-case tracking-normal text-app-text-muted';
export const BOX = 'overflow-hidden rounded border border-app-border bg-surface';

const BAND_FILL: Record<PyramidBand, string> = {
  ok: 'bg-emerald-500 dark:bg-emerald-400',
  warn: 'bg-amber-500 dark:bg-amber-400',
  bad: 'bg-red-500 dark:bg-red-400',
  off: 'bg-app-text-faint/40',
};

const BAND_CHIP: Record<PyramidBand, string> = {
  ok: 'bg-emerald-500/[0.12] text-emerald-700 dark:text-emerald-400',
  warn: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  bad: 'bg-red-500/10 text-red-700 dark:text-red-400',
  off: 'bg-app-hover text-app-text-secondary',
};


const PLAN_DOT: Record<PlanKind, string> = {
  sviluppo: 'bg-primary',
  topics: 'bg-sky-500',
  altro: 'bg-emerald-500',
  scelta: 'bg-app-text-faint',
  fatto: 'bg-emerald-500',
};

const PLAN_TILES: readonly PlanKind[] = ['sviluppo', 'topics', 'altro', 'scelta', 'fatto'];

export function Pyramid({ pyramid, tr, day }: { pyramid: PyramidView; tr: Tr; day: (at: number) => string }) {
  const [open, setOpen] = useState<number | null>(null);
  const updated = pyramid.updated ? Date.parse(pyramid.updated) : NaN;
  const steps = Math.max(1, pyramid.levels.length - 1);
  const tail = [
    pyramid.doneToday > 0 ? tr('feat.pyr.today', { n: pyramid.doneToday }) : null,
    pyramid.moving > 0 ? tr('feat.pyr.moving', { n: pyramid.moving }) : null,
    pyramid.missing > 0 ? tr('feat.pyr.missing', { n: pyramid.missing }) : null,
    pyramid.dropped > 0 ? tr('feat.pyr.dropped', { n: pyramid.dropped }) : null,
  ].filter(Boolean);
  return (
    <div data-testid="features-pyramid">
      <h2 className={SECTION}>
        {tr('feat.pyr.title')}
        <span className={SECTION_COUNT}>{pyramid.covered}/{pyramid.needed}</span>
        {Number.isFinite(updated) && <span className={SECTION_REST} data-testid="features-pyramid-updated">{tr('feat.pyr.updated', { date: day(updated) })}</span>}
      </h2>
      <p className="m-0 mb-2 text-compact tabular-nums text-app-text-secondary" data-testid="features-pyramid-summary">
        {tr('feat.pyr.covered', { covered: pyramid.covered, needed: pyramid.needed })}
        {tail.length > 0 ? `; ${tail.join('; ')}. ` : '. '}
        <span className="text-app-text-muted">{tr('feat.pyr.tap')}</span>
      </p>
      <div className={`${BOX} flex flex-col items-center gap-1 px-3 py-2.5`}>
        {pyramid.levels.map((l, k) => (
          <LevelRow
            key={l.n}
            level={l}
            tr={tr}
            width={46 + (k * 54) / steps}
            open={open === l.n}
            onToggle={() => setOpen(open === l.n ? null : l.n)}
          />
        ))}
      </div>
      <p className="m-0 mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-mini text-app-text-muted" data-testid="features-pyramid-legend">
        {PYRAMID_BANDS.map((b) => (
          <span key={b} className="inline-flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-xs ${BAND_FILL[b]}`} aria-hidden="true" />
            {tr(`feat.pyr.band.${b}`)}
          </span>
        ))}
      </p>
    </div>
  );
}

function LevelRow({ level, tr, width, open, onToggle }: { level: PyramidLevel; tr: Tr; width: number; open: boolean; onToggle: () => void }) {
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        data-testid="features-pyramid-level"
        data-level={level.n}
        style={{ '--py-w': `${width}%` } as React.CSSProperties}
        className={`flex h-7 w-[var(--py-w)] items-center gap-2.5 rounded-sm px-2 text-left hover:bg-app-hover @max-2xl:h-9 @max-2xl:w-full ${open ? 'bg-primary/[0.06] shadow-[0_0_0_1px_var(--border)]' : ''}`}
      >
        <span className="w-[112px] flex-none truncate text-compact text-app-text">
          <span className="mr-1.5 tabular-nums text-app-text-muted">{level.n}</span>{level.name}
        </span>
        <span className="flex h-1.5 min-w-0 flex-1 gap-px overflow-hidden rounded-full bg-app-border" data-testid="features-pyramid-bar">
          {PYRAMID_BANDS.map((b) => level.counts[b] > 0 && (
            <span key={b} data-band={b} className={`block h-full ${BAND_FILL[b]}`} style={{ flexGrow: level.counts[b] }} />
          ))}
        </span>
        <span className="w-12 flex-none text-right text-mini tabular-nums text-app-text-secondary" data-testid="features-pyramid-count">{level.covered}/{level.needed}</span>
      </button>
      {open && (
        <div data-testid="features-pyramid-detail" className="mb-1 w-full rounded-sm border border-app-border-subtle bg-app-inset px-3 py-2 text-mini">
          {level.desc && <p className="m-0 mb-1.5 text-compact text-app-text-body">{level.desc}</p>}
          {level.items.map((i, x) => (
            <div key={x} data-testid="features-pyramid-item" data-status={i.status} className="flex items-start gap-2.5 border-t border-app-border-subtle py-1.5 first-of-type:border-t-0">
              <span className={`mt-px w-[92px] flex-none truncate rounded-xs px-1.5 py-px text-center font-medium ${BAND_CHIP[BAND_OF[i.status]]}`}>{tr(`feat.pyr.st.${i.status}`)}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-compact text-app-text">{i.name}</span>
                {i.outcome && <span className="mt-0.5 block text-app-text-body">{i.outcome}</span>}
                {(i.where || i.use) && (
                  <span className="mt-0.5 block text-app-text-muted">
                    {i.where && <span className="font-mono">{i.where}</span>}
                    {i.where && i.use && ' · '}
                    {i.use && <span className="tabular-nums" data-testid="features-pyramid-use">{tr('feat.pyr.use', { use: i.use })}</span>}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function Decided({ view, tr }: { view: FeaturesView; tr: Tr }) {
  const total = PLAN_TILES.reduce((n, k) => n + view.plans[k], 0);
  if (total === 0) return null;
  return (
    <div data-testid="features-decided">
      <h2 className={SECTION}>
        {tr('feat.plan.title')}
        <span className={SECTION_COUNT}>{total}</span>
        <span className={`${SECTION_REST} @max-2xl:hidden`}>{tr('feat.plan.hint')}</span>
      </h2>
      <div className={`${BOX} grid grid-cols-5 divide-x divide-app-border-subtle @max-2xl:grid-cols-2 @max-2xl:divide-x-0`}>
        {PLAN_TILES.map((k) => (
          <div key={k} data-testid="features-decided-tile" data-plan={k} className="min-w-0 px-3 py-2 @max-2xl:border-t @max-2xl:border-app-border-subtle">
            <div className="text-title font-semibold tabular-nums text-app-text">{view.plans[k]}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-mini text-app-text-secondary">
              <span className={`h-1.5 w-1.5 flex-none rounded-full ${PLAN_DOT[k]}`} aria-hidden="true" />
              <span className="truncate">{tr(`feat.plan.tile.${k}`)}</span>
            </div>
          </div>
        ))}
      </div>
      {view.todo.length > 0 ? (
        <div className={`${BOX} mt-1.5`} data-testid="features-todo">
          {view.todo.map((l) => (
            <div key={l.id} data-testid="features-todo-row" className="flex items-baseline gap-2.5 border-t border-app-border-subtle px-3 py-2 first:border-t-0">
              <span className={`flex-none rounded-xs px-1.5 py-px text-mini font-medium tabular-nums ${PLAN_CHIP.sviluppo}`}>{l.plan?.prio != null ? tr('feat.plan.prio', { n: l.plan.prio }) : tr('feat.plan.sviluppo')}</span>
              <span className="min-w-0 flex-1 text-compact">
                <span className="font-medium text-app-text">{l.name}</span>
                {l.plan?.why && <span className="text-app-text-secondary"> · {l.plan.why}</span>}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="m-0 mt-1.5 text-mini text-app-text-muted" data-testid="features-todo-none">{tr('feat.plan.none')}</p>
      )}
    </div>
  );
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
