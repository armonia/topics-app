/**
 * CONSUMI: the Dashboard where the usage hub is part of the installation
 * (hub-smistamento, HUBBR-12). Loaded as its own chunk, only then.
 *
 * From the top: the decision that is yours (a project past the cap you set),
 * the pickers that narrow the window to a folder, a model or an account with
 * the CSV of its rows, the window's five numbers in euro and its input,
 * output and requests, the Claude tokens per model over time, per model, per
 * account and per project, per git folder and branch, Muse per folder and how
 * the proxy attributed its requests, the saving against the list price
 * (Claude only: the proxy sees nothing else) and what Muse took off Claude,
 * then the board's own work in one box and whatever the Dashboard passes
 * below it (its chart, the usage per project of Topics' own chats).
 *
 * The truth stays in the hub and in the proxy: the one write here, the raised
 * cap, goes to the hub and the view shows what it reads back. With the hub
 * silent the numbers keep their last reading under a pill that says since when.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle, BarChart3, Bot, CheckCircle, Clock, Coins, Hourglass, KeyRound, Loader, PiggyBank, Receipt, RefreshCw,
} from 'lucide-react';
import { useLocale, useT } from '../../hooks/useT';
import { addCatalogue } from '../../lib/i18n';
import HUB_USAGE_IT from '../../lib/i18n-hub-usage-it';
import HUB_USAGE_EN from '../../lib/i18n-hub-usage-en';
import { apiFetch } from '../../lib/shell/net';
import { useHubLive, refreshHubLive } from '../../state/hubLive';
import { startVisibleInterval } from '../../state/documentVisibility';
import {
  HUB_USAGE_DAYS, bucketTotals, chartLayers, formatCurrency, museFolders, museJobs, museWeekTokens, overCap, planCostForWindow, projectDetails, projectShares,
  proxyAttribution, readHubUsage, savingOf, tokenParts, exchangeRateOf, type HubUsage, type HubUsageDays, type HubUsageFilter,
} from '../../lib/hubUsage';
import { NO_USAGE_FILTER, usageFilterQuery } from '../../../../shared/hub-usage';
import type { DashboardKPIs } from '../../lib/api';
import { WARNING_TEXT } from '../../lib/popoverStyles';
import { BUTTON, Box, CARD, Tokens } from './hubUsageUi';
import { TONES, modelName, niceMax, tokensShort, type Tr } from './hubUsageFormat';
import { ByAccount, ByModel, ByProject, Saving } from './HubUsageBoxes';
import { ByRepo, MuseByFolder, ProxyAttributionBox, SplitStrip, UsageFilters } from './HubUsageMore';
import { readJson } from '../../lib/readJson';

// The section's strings travel with its chunk, before its first render.
addCatalogue('it', HUB_USAGE_IT);
addCatalogue('en', HUB_USAGE_EN);

/** The proxy's sum is cached a minute on the server: reading more often buys nothing. */
const POLL_MS = 60_000;

interface Reads {
  usage: HubUsage | null;
  usageFailed: boolean;
  profiles: unknown;
  settings: unknown;
  live: unknown;
  queue: unknown;
  projects: unknown;
  at: number;
}

/** Every read of the section, again every POLL_MS while visible, after a write and on a new window. */
function useReads(days: HubUsageDays, filter: HubUsageFilter): { reads: Reads | null; reread: () => Promise<void> } {
  const [reads, setReads] = useState<Reads | null>(null);
  const alive = useRef(true);
  const read = useCallback(async () => {
    const [usageRaw, profiles, settings, live, queue, projects] = await Promise.all([
      readJson(`/api/hub-usage?days=${days}${usageFilterQuery(filter)}`), readJson('/api/switchboard/profiles'), readJson('/api/switchboard/settings'),
      readJson('/api/hub/live'), readJson('/api/hub/queue'), readJson('/api/hub/projects'),
    ]);
    if (!alive.current) return;
    const usage = readHubUsage(usageRaw);
    // A failed read keeps the last good one: the pill says how old it is.
    setReads((prev) => {
      const keepUsage = usage ?? (prev?.usage?.days === days ? prev.usage : null);
      return {
        usage: keepUsage,
        usageFailed: usage === null,
        profiles: profiles ?? prev?.profiles ?? null,
        settings: settings ?? prev?.settings ?? null,
        live: live ?? prev?.live ?? null,
        queue: queue ?? prev?.queue ?? null,
        projects: projects ?? prev?.projects ?? null,
        at: usage || live ? Date.now() : prev?.at ?? 0,
      };
    });
  }, [days, filter]);
  useEffect(() => {
    alive.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- first read on mount, then polling: the state is set after the fetch resolves
    void read();
    const stop = startVisibleInterval(() => { void read(); void refreshHubLive(); }, POLL_MS);
    return () => { alive.current = false; stop(); };
  }, [read]);
  return { reads, reread: read };
}

/** A clock that moves every 5 s, for «12 s fa». */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => startVisibleInterval(() => setNow(Date.now()), 5_000), []);
  return now;
}

export function HubUsageSection({ kpis, children }: { kpis: DashboardKPIs | null; children?: ReactNode }) {
  const tr = useT();
  const locale = useLocale();
  const [days, setDays] = useState<HubUsageDays>(7);
  const [filter, setFilter] = useState<HubUsageFilter>(NO_USAGE_FILTER);
  const { reads, reread } = useReads(days, filter);
  const live = useHubLive();
  const now = useNow();
  const answering = live.pace?.data !== undefined;
  // An unchanged hub reading is not pushed again, so this view's own reads count as answers too.
  const hubAt = answering ? Math.max(live.pace?.at ?? 0, reads?.at ?? 0) || null : (reads?.at || null);
  const [failure, setFailure] = useState<string | null>(null);

  const exchangeRate = exchangeRateOf(reads?.settings);
  const money = useCallback((usd: number) => formatCurrency(usd, exchangeRate, locale), [exchangeRate, locale]);
  const usage = reads?.usage ?? null;
  // Narrowed to one account, the saving is its tokens against its own plan.
  const planCost = useMemo(() => planCostForWindow(reads?.profiles, days, filter.account), [reads?.profiles, days, filter.account]);
  const saving = usage && planCost ? savingOf(usage.totals.listUsd, planCost.usd) : null;
  const projects = useMemo(() => projectShares(reads?.live), [reads?.live]);
  const decision = overCap(projects);
  const jobs = usage ? museJobs(reads?.queue, usage.sinceMs) : null;
  const details = useMemo(() => projectDetails(reads?.projects), [reads?.projects]);

  const raise = useCallback(async (name: string, budgetPct: number) => {
    setFailure(null);
    try {
      const r = await apiFetch('/api/hub/project-settings', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, budgetPct }),
      });
      if (!r.ok) {
        const why = await r.json().then((b: { error?: unknown }) => String(b.error ?? r.status)).catch(() => String(r.status));
        setFailure(tr('hubUsage.failed', { why }));
      }
    } catch (e) {
      setFailure(tr('hubUsage.failed', { why: e instanceof Error ? e.message : String(e) }));
    } finally {
      await reread();
    }
  }, [reread, tr]);

  return (
    <div data-testid="hub-usage-section" className="@container flex flex-col">
      <header className="sticky top-0 z-[2] flex h-[38px] flex-none items-center gap-2 border-b border-app-border bg-app-bg px-4 @max-2xl:px-3">
        <BarChart3 size={14} className="flex-none text-app-text-muted" aria-hidden="true" />
        <h1 className="m-0 text-prose font-semibold text-app-text">{tr('usage.open')}</h1>
        <span className="flex-1" />
        <LivePill answering={answering} at={hubAt} now={now} locale={locale} onRetry={async () => { await Promise.all([refreshHubLive(), reread()]); }} />
        <div role="group" aria-label={tr('usage.open')} className="inline-flex gap-0.5 rounded-sm border border-app-border bg-surface p-0.5 tabular-nums">
          {HUB_USAGE_DAYS.map((d) => (
            <button
              key={d}
              type="button"
              data-testid={`hub-usage-range-${d}`}
              aria-pressed={d === days}
              onClick={() => setDays(d)}
              className={`rounded-xs px-2 py-0.5 text-mini font-medium ${d === days ? 'bg-primary text-white' : 'text-app-text-muted hover:text-app-text'} @max-2xl:px-2.5 @max-2xl:py-1 @max-2xl:text-compact`}
            >
              {tr(`hubUsage.range.${d}`)}
            </button>
          ))}
        </div>
      </header>

      <div className="flex max-w-[1240px] flex-col gap-3 px-4 pb-6 pt-3.5 @max-2xl:px-3">
        {failure && <div role="alert" data-testid="hub-usage-failure" className="rounded border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-compact text-red-600 dark:text-red-400">{failure}</div>}
        {decision && <Decide name={decision.project.title} pct={decision.project.claude} cap={decision.project.budgetPct ?? 0} raiseTo={decision.raiseTo} onRaise={() => raise(decision.project.name, decision.raiseTo)} />}

        {reads?.usageFailed && !usage && <p data-testid="hub-usage-proxy-down" className="text-compact text-app-text-secondary">{tr('hubUsage.proxyDown')}</p>}

        <UsageFilters usage={usage} filter={filter} days={days} onChange={setFilter} tr={tr} />

        <div data-testid="hub-usage-kpis" className="grid grid-cols-5 gap-2 @max-2xl:grid-cols-2">
          <Kpi testId="hub-usage-kpi-tokens" icon={<Coins size={14} />} top={tr('hubUsage.kpi.tokensTop')} label={tr(`hubUsage.kpi.tokens.${days}`)}
            value={usage ? <Tokens n={usage.totals.tokens} locale={locale} unit={tr('hubUsage.kpi.tokensUnit')} /> : null} />
          <Kpi testId="hub-usage-kpi-list" icon={<Receipt size={14} />} top={tr('hubUsage.kpi.listTop')} label={tr('hubUsage.kpi.list')}
            value={usage ? money(usage.totals.listUsd) : null} />
          <Kpi testId="hub-usage-kpi-paid" icon={<KeyRound size={14} />} label={tr('hubUsage.kpi.paid')}
            top={planCost ? (planCost.plans === 1 ? tr('hubUsage.kpi.paidOne') : tr('hubUsage.kpi.paidMany', { n: planCost.plans })) : ''}
            value={planCost ? money(planCost.usd) : null} />
          <Kpi testId="hub-usage-kpi-saved" icon={<PiggyBank size={14} />} label={tr('hubUsage.kpi.saved')} good
            top={saving?.ratio != null ? tr('hubUsage.kpi.ratio', { ratio: saving.ratio.toLocaleString(locale === 'it' ? 'it-IT' : 'en-US', { maximumFractionDigits: 1 }) }) : ''}
            value={saving ? money(saving.savedUsd) : null} />
          <Kpi testId="hub-usage-kpi-muse" icon={<Bot size={14} />} top={tr('hubUsage.kpi.museTop')} label={tr('hubUsage.kpi.muse')} wide
            value={jobs === null ? null : <>{jobs}<small className="ml-[3px] text-mini font-normal text-app-text-muted">{tr('hubUsage.kpi.museUnit')}</small></>} />
        </div>
        <SplitStrip usage={usage} tr={tr} />

        {usage?.coverage.partial && usage.coverage.fromMs !== null && (
          <p data-testid="hub-usage-cut" className="text-mini text-app-text-secondary">
            {tr('hubUsage.cut', { when: new Date(usage.coverage.fromMs).toLocaleString(locale === 'it' ? 'it-IT' : 'en-US', { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })}
          </p>
        )}

        <ModelChart usage={usage} locale={locale} money={money} tr={tr} />

        <div className="grid grid-cols-3 gap-3 @max-4xl:grid-cols-1">
          <ByModel usage={usage} money={money} tr={tr} />
          <ByAccount profiles={reads?.profiles} usage={usage} pace={live.pace?.data} gates={live.gates?.data} money={money} tr={tr} />
          <ByProject live={reads?.live} details={details} tr={tr} />
        </div>

        <div className="grid grid-cols-3 gap-3 @max-4xl:grid-cols-1">
          <ByRepo usage={usage} money={money} tr={tr} />
          <MuseByFolder folders={museFolders(reads?.projects)} tr={tr} />
          <ProxyAttributionBox data={proxyAttribution(reads?.projects)} tr={tr} />
        </div>

        <Saving usage={usage} planCost={planCost} saved={saving?.savedUsd ?? null} museTokens={museWeekTokens(reads?.projects)} money={money} tr={tr} />

        <BoardWork kpis={kpis} locale={locale} tr={tr} />
        {children}
      </div>
    </div>
  );
}

function LivePill({ answering, at, now, locale, onRetry }: { answering: boolean; at: number | null; now: number; locale: string; onRetry: () => Promise<void> }) {
  const tr = useT();
  const [busy, setBusy] = useState(false);
  const ago = at === null ? 0 : Math.max(0, Math.round((now - at) / 1000));
  const text = answering
    ? (ago < 60 ? tr('hubUsage.liveSeconds', { n: ago }) : tr('hubUsage.liveMinutes', { n: Math.round(ago / 60) }))
    : at === null ? tr('hubUsage.hubDownNever') : tr('hubUsage.hubDown', { time: new Date(at).toLocaleTimeString(locale === 'it' ? 'it-IT' : 'en-US', { hour: '2-digit', minute: '2-digit' }) });
  return (
    <span className="flex items-center gap-1.5 @max-2xl:hidden" data-testid="hub-usage-live" data-live={answering ? 'true' : 'false'}>
      <span className="inline-flex h-[22px] items-center gap-[5px] whitespace-nowrap rounded-full border border-app-border px-2 text-mini tabular-nums text-app-text-muted">
        <span className={`h-1.5 w-1.5 flex-none rounded-full ${answering ? 'bg-emerald-500 dark:bg-emerald-400' : 'bg-amber-500'}`} />
        {text}
      </span>
      {!answering && (
        <button type="button" disabled={busy} className={BUTTON} onClick={() => { setBusy(true); void onRetry().finally(() => setBusy(false)); }}>
          <RefreshCw size={12} aria-hidden="true" />{tr('hubUsage.retry')}
        </button>
      )}
    </span>
  );
}

function Decide({ name, pct, cap, raiseTo, onRaise }: { name: string; pct: number; cap: number; raiseTo: number; onRaise: () => Promise<void> }) {
  const tr = useT();
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const p = (v: number) => `${v.toLocaleString(locale === 'it' ? 'it-IT' : 'en-US', { maximumFractionDigits: 1 })}%`;
  return (
    <section data-testid="hub-usage-decide" className={`${CARD} border-amber-500/45`}>
      <h2 className={`m-0 flex items-center gap-1.5 px-3 pt-2 text-mini font-semibold ${WARNING_TEXT}`}>
        <AlertTriangle size={13} aria-hidden="true" />{tr('hubUsage.decide', { n: 1 })}
      </h2>
      <div className="flex items-center gap-2.5 px-3 py-2 @max-2xl:flex-col @max-2xl:items-stretch">
        <div className="min-w-0 flex-1">
          <div className="text-compact text-app-text"><b>{name}</b> {tr('hubUsage.overCap', { pct: p(pct), cap: p(cap) })}</div>
          <div className="mt-0.5 text-mini text-app-text-muted">{tr('hubUsage.overCapHint')}</div>
        </div>
        <button type="button" data-testid="hub-usage-raise" disabled={busy} className={BUTTON} onClick={() => { setBusy(true); void onRaise().finally(() => setBusy(false)); }}>
          {tr('hubUsage.raise', { pct: p(raiseTo) })}
        </button>
      </div>
    </section>
  );
}

function Kpi({ testId, icon, top, label, value, good = false, wide = false }: {
  testId: string; icon: ReactNode; top: string; label: string; value: ReactNode | null; good?: boolean; wide?: boolean;
}) {
  return (
    <div data-testid={testId} className={`${CARD} flex min-w-0 flex-col gap-[3px] px-3 py-2.5 ${wide ? '@max-2xl:col-span-2' : ''}`}>
      <div className="flex items-center justify-between gap-2 text-app-text-muted">
        <span aria-hidden="true">{icon}</span>
        <span className={`truncate text-mini tabular-nums ${good && top ? 'text-emerald-600 dark:text-emerald-400' : ''}`}>{top}</span>
      </div>
      <div className={`whitespace-nowrap text-headline font-semibold tabular-nums ${value === null ? 'text-app-text-muted' : good ? 'text-emerald-600 dark:text-emerald-400' : 'text-app-text'}`}>
        {value === null ? '-' : value}
      </div>
      <div className="truncate text-mini text-app-text-muted">{label}</div>
    </div>
  );
}

/** The Claude tokens (or their list price) per model over the window, stacked. */
function ModelChart({ usage, locale, money, tr }: { usage: HubUsage | null; locale: string; money: (usd: number) => string; tr: Tr }) {
  const [metric, setMetric] = useState<'tokens' | 'listUsd'>('tokens');
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => { for (const e of entries) setWidth(e.contentRect.width); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const layers = usage ? chartLayers(usage, metric) : [];
  const H = 190;
  const P = { l: 40, r: 8, t: 8, b: 20 };
  const cw = Math.max(10, width - P.l - P.r);
  const ch = H - P.t - P.b;
  const n = usage?.buckets.length ?? 0;
  const totals = usage ? usage.buckets.map((_, i) => layers.reduce((s, l) => s + (l.values[i] ?? 0), 0)) : [];
  const max = niceMax(Math.max(0, ...totals));
  const xStep = n <= 1 ? 0 : cw / (n - 1);
  const x = (i: number) => (n <= 1 ? P.l + cw / 2 : P.l + xStep * i);
  const y = (v: number) => P.t + ch - (max > 0 ? (ch * v) / max : 0);
  const fmtAxis = (v: number) => (metric === 'tokens' ? `${tokenParts(v, locale).value}${tokenParts(v, locale).unit}` : money(v));
  const displayLocale = locale === 'it' ? 'it-IT' : 'en-US';
  const label = (ms: number) => (usage?.unit === 'hour'
    ? new Date(ms).toLocaleTimeString(displayLocale, { hour: '2-digit' })
    : new Date(ms).toLocaleDateString(displayLocale, { weekday: 'short', day: 'numeric' }));
  const bucketLabel = (ms: number) => (usage?.unit === 'hour'
    ? new Date(ms).toLocaleTimeString(displayLocale, { hour: '2-digit', minute: '2-digit' })
    : new Date(ms).toLocaleDateString(displayLocale, { weekday: 'short', day: 'numeric', month: 'short' }));
  const step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(cw / 70))));
  const paths: { key: string; d: string; tone: (typeof TONES)[number] }[] = [];
  let base = new Array<number>(n).fill(0);
  for (const [li, l] of layers.entries()) {
    const below = base;
    const top = below.map((b, i) => b + (l.values[i] ?? 0));
    const up = top.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' L');
    const down = below.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).reverse().join(' L');
    paths.push({ key: l.key, d: `M${up} L${down} Z`, tone: TONES[li % TONES.length]! });
    base = top;
  }
  return (
    <section data-testid="hub-usage-chart" className={`${CARD} px-3 pb-2 pt-2.5`}>
      <div className="flex flex-wrap items-center gap-1.5">
        {(['tokens', 'listUsd'] as const).map((m) => (
          <button key={m} type="button" aria-pressed={m === metric} onClick={() => setMetric(m)}
            className={`rounded-xs px-2 py-0.5 text-mini ${m === metric ? 'bg-primary/10 font-medium text-blue-700 dark:text-primary' : 'text-app-text-muted hover:text-app-text'}`}>
            {tr(m === 'tokens' ? 'hubUsage.chart.tokens' : 'hubUsage.chart.list')}
          </button>
        ))}
      </div>
      <div ref={box} className="mt-1.5">
        {usage && layers.length === 0 ? (
          <div className="flex items-center justify-center text-compact text-app-text-muted" style={{ height: H }}>{tr('hubUsage.chart.empty')}</div>
        ) : (
          <svg width={width} height={H} role="img" aria-label={tr(metric === 'tokens' ? 'hubUsage.chart.tokens' : 'hubUsage.chart.list')} className="block">
            {[0, 1, 2, 3, 4].map((t) => {
              const v = (max * t) / 4;
              return (
                <g key={t}>
                  <line x1={P.l} x2={width - P.r} y1={y(v)} y2={y(v)} className="stroke-app-border" strokeWidth={1} />
                  <text x={P.l - 6} y={y(v) + 3} textAnchor="end" fontSize={10} className="fill-app-text-muted">{usage ? fmtAxis(v) : ''}</text>
                </g>
              );
            })}
            {usage?.buckets.map((ms, i) => (i % step === 0 || i === n - 1) && (i === n - 1 || n - 1 - i >= step / 2) ? (
              <text key={ms} x={x(i)} y={H - 5} fontSize={10} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} className="fill-app-text-muted">{label(ms)}</text>
            ) : null)}
            {paths.map((p) => (
              <path key={p.key} d={p.d} className={`${p.tone.fill} stroke-surface`} fillOpacity={0.9} strokeWidth={1}>
                <title>{modelName(p.key, tr)}</title>
              </path>
            ))}
            {/* One band per hour or day over the areas: hovered, it says that bucket's tokens and list price. */}
            {usage?.buckets.map((ms, i) => {
              const t = bucketTotals(usage, i);
              const half = n <= 1 ? cw / 2 : xStep / 2;
              const left = Math.max(P.l, x(i) - half);
              return (
                <rect key={ms} data-testid="hub-usage-bucket" x={left} y={P.t} width={Math.max(1, Math.min(P.l + cw, x(i) + half) - left)} height={ch}
                  fill="transparent">
                  <title>{tr('hubUsage.chart.bucket', { when: bucketLabel(ms), tokens: tokensShort(t.tokens, locale), money: money(t.listUsd) })}</title>
                </rect>
              );
            })}
          </svg>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-mini text-app-text-muted">
        {paths.map((p) => (
          <span key={p.key} className="inline-flex items-center gap-[5px]"><i className={`inline-block h-2 w-2 rounded-[2px] ${p.tone.bg}`} />{modelName(p.key, tr)}</span>
        ))}
      </div>
    </section>
  );
}

/** The board's KPIs of the Dashboard, compact: what the board did, next to what it cost. */
function BoardWork({ kpis, locale, tr }: { kpis: DashboardKPIs | null; locale: string; tr: Tr }) {
  const oneDecimal = (v: number) => v.toLocaleString(locale === 'it' ? 'it-IT' : 'en-US', { maximumFractionDigits: 1 });
  const cells: Array<{ key: string; icon: ReactNode; label: string; value: string | null; empty?: boolean }> = [
    { key: 'doneToday', icon: <CheckCircle size={12} />, label: tr('hubUsage.board.doneToday'), value: kpis ? String(kpis.throughputDay) : null },
    { key: 'doneWeek', icon: <CheckCircle size={12} />, label: tr('hubUsage.board.doneWeek'), value: kpis ? String(kpis.throughputWeek) : null },
    { key: 'cycle', icon: <Clock size={12} />, label: tr('hubUsage.board.cycle'), value: kpis ? tr('hubUsage.hours', { n: oneDecimal(kpis.avgCycleTimeHours) }) : null },
    { key: 'wip', icon: <Loader size={12} />, label: tr('hubUsage.board.wip'), value: kpis ? String(kpis.wipCount) : null },
    { key: 'errors', icon: <AlertTriangle size={12} />, label: tr('hubUsage.board.errors'), value: kpis ? `${oneDecimal(kpis.errorRate * 100)}%` : null },
    { key: 'approvals', icon: <Hourglass size={12} />, label: tr('hubUsage.board.approvals'), value: kpis ? (kpis.pendingApprovals > 0 ? String(kpis.pendingApprovals) : tr('hubUsage.board.none')) : null, empty: kpis?.pendingApprovals === 0 },
  ];
  return (
    <Box testId="hub-usage-board" icon={<BarChart3 size={13} />} title={tr('hubUsage.board')} meta={tr('hubUsage.boardMeta')}>
      <div className="grid grid-cols-6 tabular-nums @max-4xl:grid-cols-3 @max-2xl:grid-cols-2">
        {cells.map((c) => (
          <div key={c.key} className="flex flex-col gap-0.5 border-l border-app-border-subtle px-3 py-2 first:border-l-0">
            <span className="flex items-center gap-1 truncate text-mini text-app-text-muted"><span aria-hidden="true">{c.icon}</span>{c.label}</span>
            <b className={`text-prose font-semibold ${c.empty ? 'font-normal text-app-text-muted' : 'text-app-text'}`}>{c.value ?? '-'}</b>
          </div>
        ))}
      </div>
    </Box>
  );
}
