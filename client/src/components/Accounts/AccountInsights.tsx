/**
 * What the bars of «Account e quote» do not say on their own (hub-smistamento,
 * HUBBR-10), drawn the way the hub's page drew it and in the cards' language:
 *
 * - under each window, the strip of its slices (through the proxy, spent
 *   outside it, idle, not measured), the trend of the last 24 hours or 7 days,
 *   and the tokens, list price and internal/external split of the window;
 * - the hub's pace dial with its zone, when the quota runs out at the last 24
 *   hours' pace and the tokens left, the 24 hours against the daily share, the
 *   per-model windows and the bonus credit;
 * - one click away, the login and how the windows reset, the subscription
 *   page, and who spent the last 24 hours;
 * - a card for an account whose login died (no quota, so no other card);
 * - in the header, the proxy's probes of the week and its queue now.
 */
import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, ExternalLink, Radar, Rows3 } from 'lucide-react';
import { useLocale, useT } from '../../hooks/useT';
import { hubProse } from '../../lib/accountQuotas';
import { tokenParts } from '../../lib/hubUsage';
import {
  attributionVerdict, loginBroken, type AttributionBand, type AttributionWindow, type BoardAccount, type ProxyHealth, type TrendPoint,
} from '../../lib/accountInsights';
import { DANGER_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import { Bar, CHIP, CHIP_TONE, CardHead, CardShell } from './accountCardParts';

type Money = (usd: number) => string;

const HOUR_MS = 3_600_000;
const SPAN_MS = { fiveH: 24 * HOUR_MS, week: 7 * 24 * HOUR_MS } as const;
/** The track of a bar starts after its 36 px label and the 6 px gap: what sits under a bar starts there too. */
const UNDER_BAR = 'pl-[42px] pr-[42px]';

/** A quiet chip of the header line, left-aligned and in the regular weight. */
const HEALTH_CHIP = 'inline-flex h-5 flex-none items-center gap-1 whitespace-nowrap rounded-xs px-1.5 text-mini';

const TONE_TEXT = { ok: 'text-app-text-secondary', warn: WARNING_TEXT, bad: DANGER_TEXT, mut: 'text-app-text-secondary' } as const;

function tok(n: number, locale: string): string {
  const t = tokenParts(n, locale);
  return t.unit ? `${t.value} ${t.unit}` : t.value;
}

function bandClass(b: AttributionBand): string {
  if (b.kind === 'mine') return 'bg-primary';
  if (b.kind === 'outside') return 'bg-amber-500';
  if (b.kind === 'idle') return 'bg-black/[0.08] dark:bg-white/[0.1]';
  return 'bg-transparent outline outline-1 -outline-offset-1 outline-black/[0.12] dark:outline-white/[0.14]';
}

/** The window in slices, oldest first: the hub's strip, with each slice's own sentence on hover. */
function Strip({ window: w, money }: { window: AttributionWindow; money: Money }) {
  const tr = useT();
  const locale = useLocale();
  const peak = Math.max(0, ...w.bands.map((b) => b.tokens));
  const when = (ms: number) => new Date(ms).toLocaleString(locale === 'en' ? 'en-GB' : 'it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const title = (b: AttributionBand) => (b.kind === 'mine'
    ? tr('accounts.band.mine', { when: when(b.toMs), tokens: tok(b.tokens, locale), n: b.requests, money: money(b.usd) })
    : b.kind === 'outside' ? tr('accounts.band.outside', { when: when(b.toMs), pct: b.deltaPct ?? 0 })
      : tr(`accounts.band.${b.kind}`, { when: when(b.toMs) }));
  return (
    <div className="mt-[3px] flex h-[5px] gap-px" data-testid="account-strip">
      {w.bands.map((b) => (
        <i key={b.fromMs} data-band={b.kind} title={title(b)} className={`min-w-0 flex-1 rounded-[1px] ${bandClass(b)}`}
          style={b.kind === 'mine' && peak > 0 ? { opacity: 0.35 + (0.65 * b.tokens) / peak } : undefined} />
      ))}
    </div>
  );
}

/** The window's share over its span, as a step line: a 92% with the trend that brought it there. */
function Spark({ points, span, now }: { points: TrendPoint[]; span: 'fiveH' | 'week'; now: number }) {
  const tr = useT();
  const t0 = now - SPAN_MS[span];
  const pts = points.filter((p) => p.ts >= t0 && p.ts <= now);
  if (pts.length === 0) return null;
  const W = 300;
  const H = 22;
  const x = (t: number) => (((t - t0) / SPAN_MS[span]) * W).toFixed(1);
  const y = (pct: number) => (H - 1 - (Math.min(100, Math.max(0, pct)) / 100) * (H - 2)).toFixed(1);
  let line = `M${x(pts[0]!.ts)},${y(pts[0]!.pct)}`;
  pts.forEach((p, i) => {
    const next = pts[i + 1];
    line += ` L${x(next ? next.ts : now)},${y(p.pct)}`;
    if (next) line += ` L${x(next.ts)},${y(next.pct)}`;
  });
  const area = `${line} L${x(now)},${H} L${x(pts[0]!.ts)},${H} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-[3px] block h-[22px] w-full" data-testid="account-spark" data-span={span} data-points={pts.length}
      role="img" aria-label={tr(`accounts.spark.${span}`, { from: pts[0]!.pct, to: pts[pts.length - 1]!.pct })}>
      <title>{tr(`accounts.spark.${span}`, { from: pts[0]!.pct, to: pts[pts.length - 1]!.pct })}</title>
      <path d={area} className="fill-primary/15" />
      <path d={line} fill="none" className="stroke-primary" strokeWidth={1} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** The window's own figures: tokens through the proxy and their list price, I/O against cache, internal against external. */
function Figures({ window: w, span, money }: { window: AttributionWindow; span: 'fiveH' | 'week'; money: Money }) {
  const tr = useT();
  const locale = useLocale();
  const v = attributionVerdict(w);
  const tip = tr('accounts.figures.title', { n: w.requests });
  return (
    <div className="mt-[3px] text-mini leading-snug tabular-nums text-app-text-secondary" data-testid="account-figures" data-verdict={v.kind} title={tip}>
      <div>{tr('accounts.figures.tokens', { tokens: tok(w.tokens, locale), money: money(w.usd), period: tr(`accounts.figures.period.${span}`) })}</div>
      <div>
        {v.kind === 'unmeasured' && <span>{tr('accounts.verdict.unmeasured')}</span>}
        {v.kind === 'partial' && <span>{tr('accounts.verdict.partial', { cov: v.coveragePct, ext: v.externalPct })}</span>}
        {v.kind === 'measured' && <><b className="font-semibold text-app-text">{tr('accounts.verdict.internal', { pct: v.internalPct })}</b> · {tr('accounts.verdict.external', { pct: v.externalPct })}</>}
        {w.tokens > 0 && <span title={tr('accounts.figures.splitTitle')}> · {tr('accounts.figures.split', { io: tok(w.io, locale), cache: tok(w.cache, locale) })}</span>}
      </div>
    </div>
  );
}

/** Under a window's bar: its slices, its trend, its figures. */
export function WindowTrail({ window: w, trend, span, readAt, money }: { window: AttributionWindow | null; trend: TrendPoint[]; span: 'fiveH' | 'week'; readAt: number; money: Money }) {
  if (!w && trend.length === 0) return null;
  return (
    <div className={`mb-1.5 ${UNDER_BAR}`} data-testid="account-trail" data-span={span}>
      {w && w.bands.length > 0 && <Strip window={w} money={money} />}
      <Spark points={trend} span={span} now={readAt} />
      {w && <Figures window={w} span={span} money={money} />}
    </div>
  );
}

export function TrailLegend() {
  const tr = useT();
  const item = (cls: string, key: string) => (
    <span className="inline-flex items-center gap-1"><i className={`inline-block h-[5px] w-2.5 rounded-[1px] ${cls}`} />{tr(`accounts.trail.${key}`)}</span>
  );
  return (
    <div className="mb-1.5 flex flex-wrap gap-x-2.5 gap-y-0.5 text-mini text-app-text-secondary" data-testid="account-trail-legend">
      {item('bg-primary', 'mine')}{item('bg-amber-500', 'outside')}{item('outline outline-1 -outline-offset-1 outline-black/[0.12] dark:outline-white/[0.14]', 'unknown')}
    </div>
  );
}

/** The hub's pace dial, as the tray draws it: green up to the pace, red past it, the needle in the zone's colour. */
export function PaceDial({ needle, zone, label }: { needle: number; zone: string; label: string }) {
  const w = 30;
  const h = 18;
  const cx = w / 2;
  const cy = h - 2;
  const r = w / 2 - 4;
  const pt = (v: number) => {
    const a = Math.PI * (1 - Math.min(Math.max(v, 0), 2) / 2);
    return [cx + r * Math.cos(a), cy - r * Math.sin(a)] as const;
  };
  const arc = (a: number, b: number) => {
    const p = pt(a);
    const q = pt(b);
    return `M${p[0].toFixed(1)} ${p[1].toFixed(1)}A${r} ${r} 0 0 1 ${q[0].toFixed(1)} ${q[1].toFixed(1)}`;
  };
  const n = pt(needle);
  const over = zone === 'sopra' || zone === 'frenato'; // allow-italian: the hub's zone ids
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label} data-testid="account-dial" data-zone={zone} className="flex-none">
      <path d={arc(0, 1)} fill="none" strokeWidth={3} className="stroke-emerald-500/70" />
      <path d={arc(1, 2)} fill="none" strokeWidth={3} className="stroke-red-500/70" />
      <line x1={cx} y1={cy} x2={n[0].toFixed(1)} y2={n[1].toFixed(1)} strokeWidth={1.5} strokeLinecap="round" className={over ? 'stroke-red-600 dark:stroke-red-400' : 'stroke-app-text'} />
      <circle cx={cx} cy={cy} r={2} className="fill-app-text" />
    </svg>
  );
}

/** The hub's forecast on a card: the dial and its state, when it runs out, the tokens left; then the 24 hours, the per-model windows, the bonus. */
export function BoardExtras({ board: b }: { board: BoardAccount }) {
  const tr = useT();
  const locale = useLocale();
  const state = hubProse(b.state.text, locale);
  const end = b.end ? hubProse(b.end.text, locale) : null;
  return (
    <div className="mb-1" data-testid="account-board">
      {(b.dial || state || end || b.tokens) && (
        <div className="mb-1 flex min-h-[20px] flex-wrap items-center gap-x-2 gap-y-0.5 text-mini tabular-nums" data-testid="account-outlook" title={hubProse(b.reason, locale) ?? undefined}>
          {b.dial && <PaceDial needle={b.dial.needle} zone={b.dial.zone} label={tr('accounts.dial.label', { state: state ?? '' })} />}
          {state && <span className={`font-semibold ${TONE_TEXT[b.state.tone]}`} data-testid="account-outlook-state">{state}</span>}
          {end && <span className="text-app-text-secondary" title={hubProse(b.end!.hint, locale) ?? undefined} data-testid="account-outlook-end">{tr('accounts.outlook.end')} <b className={`font-semibold ${b.end!.tone === 'ok' ? 'text-app-text' : TONE_TEXT[b.end!.tone]}`}>{end}</b></span>}
          {b.tokens && (
            <span className="text-app-text-secondary" title={hubProse(b.tokens.hint, locale) ?? undefined} data-testid="account-outlook-tokens">
              {tr('accounts.outlook.tokens')} <b className="font-semibold text-app-text">{b.tokens.left}</b> · {b.tokens.perDay}
            </span>
          )}
        </div>
      )}
      {b.windows.map((w) => (
        <Bar key={w.key} label={w.label} pct={Math.round(w.used)} mark={w.mark} testId="account-bar-extra"
          markTitle={w.key === 'day' && w.mark !== null ? tr('accounts.bar.day', { pct: w.mark }) : undefined} />
      ))}
      {b.bonus && (
        <>
          <Bar label={tr('accounts.bonus')} pct={b.bonus.used} testId="account-bar-bonus" />
          <div className={`${UNDER_BAR} text-mini tabular-nums text-app-text-secondary`} data-testid="account-bonus">
            {[
              tr('accounts.bonus.left', { left: Math.round(b.bonus.left), limit: b.bonus.limit }),
              b.bonus.renews ? tr('accounts.bonus.renews', { date: b.bonus.renews }) : null,
              b.bonus.stale ? tr('accounts.bonus.stale') : null,
            ].filter(Boolean).join(' · ')}
          </div>
        </>
      )}
    </div>
  );
}

/** One click away, as the hub had it under the card: why the dial says what it says, the login and the resets, who spent the last 24 hours. */
export function AccessAndSpend({ board: b }: { board: BoardAccount }) {
  const tr = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const Icon = open ? ChevronDown : ChevronRight;
  const reason = hubProse(b.reason, locale);
  const lines = b.access ? [b.access.say, b.access.fiveH, b.access.week].map((t) => hubProse(t, locale)).filter((t): t is string => !!t) : [];
  const broken = loginBroken(b);
  return (
    <div className="mt-2 border-t border-app-border-subtle pt-1.5">
      <button type="button" data-testid="account-more-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 text-left text-mini font-semibold text-app-text-secondary hover:text-app-text">
        <Icon size={12} aria-hidden="true" />{tr('accounts.access.toggle')}
        {broken && <AlertTriangle size={11} className={`ml-0.5 ${DANGER_TEXT}`} aria-hidden="true" />}
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-1 text-mini leading-snug text-app-text-secondary" data-testid="account-access">
          {reason && <p className="m-0">{reason}</p>}
          {lines.length > 0 && (
            <ul className="m-0 list-none p-0" data-testid="account-access-lines">
              {lines.map((t, i) => <li key={t} className={i === 0 && broken ? `font-semibold ${DANGER_TEXT}` : undefined}>{t}</li>)}
            </ul>
          )}
          {b.access?.link && (
            <a href={b.access.link} target="_blank" rel="noopener noreferrer" data-testid="account-access-link" className="inline-flex w-fit items-center gap-1 text-primary underline-offset-2 hover:underline">
              <ExternalLink size={11} aria-hidden="true" />{tr('accounts.access.link')}
            </a>
          )}
          <p className="m-0 mt-0.5 flex items-center gap-1 font-semibold"><Rows3 size={11} aria-hidden="true" />{tr('accounts.top.title')}</p>
          {b.top && b.top.length > 0 ? (
            <ol className="m-0 list-none p-0" data-testid="account-top">
              {b.top.map((t) => (
                <li key={t.name} className="grid grid-cols-[minmax(0,1fr)_64px_44px_32px] items-center gap-1.5 tabular-nums" data-testid="account-top-row">
                  <span className="truncate text-app-text">{t.name}</span>
                  <span className="relative h-[4px] rounded-[2px] bg-black/[0.08] dark:bg-white/[0.1]"><i className="block h-full rounded-[2px] bg-primary" style={{ width: `${Math.min(100, t.pct)}%` }} /></span>
                  <span className="text-right">{tok(t.tokens, locale)}</span>
                  <span className="text-right">{t.pct}%</span>
                </li>
              ))}
            </ol>
          ) : <p className="m-0">{hubProse(b.topNote, locale) ?? tr('accounts.top.none')}</p>}
        </div>
      )}
    </div>
  );
}

/** An account whose login died: no quota to read, so its own card says it and where to log in again. */
export function LoginCard({ board: b }: { board: BoardAccount }) {
  const tr = useT();
  const locale = useLocale();
  const name = ['claude', 'codex', 'muse'].includes(b.provider) ? tr(`accounts.provider.${b.provider}`) : b.provider;
  const say = b.access ? hubProse(b.access.say, locale) : null;
  return (
    <CardShell current={false} testId="login-card" data={{ provider: b.provider, account: b.account, login: b.access?.state ?? '' }}>
      <CardHead name={name} plan={b.account} chip={<span className={`${CHIP} ${CHIP_TONE[loginBroken(b) ? 'bad' : 'quiet']}`}>{hubProse(b.state.text, locale) ?? tr('accounts.login.chip')}</span>} />
      <div className={`mb-[9px] min-h-[17px] leading-snug ${loginBroken(b) ? DANGER_TEXT : 'text-app-text-secondary'}`}>{say ?? tr('accounts.login.caption')}</div>
      <AccessAndSpend board={b} />
    </CardShell>
  );
}

/** The proxy's probes of the week and its queue now, beside the header: what the conserve strategy costs and how deep the line is. */
export function ProxyHealthLine({ health }: { health: ProxyHealth }) {
  const tr = useT();
  const locale = useLocale();
  if (!health.probes && !health.queue) return null;
  const n = (v: number) => v.toLocaleString(locale === 'en' ? 'en-GB' : 'it-IT');
  return (
    <div className="mb-2.5 flex flex-wrap items-center gap-1.5 text-mini tabular-nums" data-testid="accounts-proxy-health">
      {health.probes && (
        <span className={`${HEALTH_CHIP} ${CHIP_TONE.quiet}`} data-testid="accounts-probes" title={tr('accounts.probes.title')}>
          <Radar size={11} aria-hidden="true" />{tr('accounts.probes', { n: n(health.probes.count), tokens: tok(health.probes.tokens, locale) })}
        </span>
      )}
      {health.queue && (
        <span className={`${HEALTH_CHIP} ${health.queue.waiting > 0 ? CHIP_TONE.warn : CHIP_TONE.quiet}`} data-testid="accounts-queue">
          {tr(health.queue.balance ? 'accounts.queue.balance' : 'accounts.queue.line', { running: health.queue.running, waiting: health.queue.waiting })}
        </span>
      )}
    </div>
  );
}
