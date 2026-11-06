/**
 * CONSUMI: the Dashboard where the usage hub is part of the installation
 * (hub-smistamento, HUBBR-12). Loaded as its own chunk, only then.
 *
 * From the top: the decision that is yours (a project past the cap you set),
 * the window's five numbers in euro, the Claude tokens per model over time,
 * per model, per account and per project, the saving against the list price
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
  AlertTriangle, BarChart3, Bot, CheckCircle, Clock, Coins, Cpu, FolderOpen, Hourglass, KeyRound, Loader, PauseCircle, PiggyBank, Receipt, RefreshCw, UserRound,
} from 'lucide-react';
import { useLocale, useT } from '../../hooks/useT';
import { addCatalogue } from '../../lib/i18n';
import HUB_USAGE_IT from '../../lib/i18n-hub-usage-it';
import HUB_USAGE_EN from '../../lib/i18n-hub-usage-en';
import { apiFetch } from '../../lib/shell/net';
import { useHubLive, refreshHubLive } from '../../state/hubLive';
import { startVisibleInterval } from '../../state/documentVisibility';
import { friendlyModelLabel } from '../../lib/modelLabel';
import { meteredProviders, type QuotaWindow } from '../../lib/accountQuotas';
import {
  HUB_USAGE_DAYS, accountShares, chartLayers, formatCurrency, headAndRest, museJobs, museWeekTokens, overCap, planCostForWindow, projectShares,
  readHubUsage, savingOf, sharePct, tokenParts, exchangeRateOf, type HubUsage, type HubUsageDays,
} from '../../lib/hubUsage';
import type { DashboardKPIs } from '../../lib/api';
import { WARNING_TEXT } from '../../lib/popoverStyles';

// The section's strings travel with its chunk, before its first render.
addCatalogue('it', HUB_USAGE_IT);
addCatalogue('en', HUB_USAGE_EN);

type Tr = ReturnType<typeof useT>;

/** The proxy's sum is cached a minute on the server: reading more often buys nothing. */
const POLL_MS = 60_000;
/** A quota from here up is drawn amber, as everywhere else in Topics. */
const HOT_AT = 80;

/** The five model tones of the mockup, light and dark, for the chart, the legend and the bars. */
const TONES = [
  { fill: 'fill-[#0066ff] dark:fill-[#4d94ff]', bg: 'bg-[#0066ff] dark:bg-[#4d94ff]' },
  { fill: 'fill-[#8b5cf6] dark:fill-[#a78bfa]', bg: 'bg-[#8b5cf6] dark:bg-[#a78bfa]' },
  { fill: 'fill-[#d97706] dark:fill-[#fbbf24]', bg: 'bg-[#d97706] dark:bg-[#fbbf24]' },
  { fill: 'fill-[#10b981] dark:fill-[#34d399]', bg: 'bg-[#10b981] dark:bg-[#34d399]' },
  { fill: 'fill-[#db2777] dark:fill-[#f472b6]', bg: 'bg-[#db2777] dark:bg-[#f472b6]' },
] as const;

const CARD = 'rounded-lg border border-app-border bg-surface';
const BOX_HEAD = 'flex items-center gap-[7px] border-b border-app-border-subtle px-3 py-[9px]';
const BOX_TITLE = 'flex-1 text-compact font-semibold text-app-text';
const LINE = 'flex h-[34px] items-center gap-2 border-t border-app-border-subtle px-3 first:border-t-0';
const BUTTON = 'inline-flex h-[26px] flex-none items-center gap-[5px] whitespace-nowrap rounded-sm border border-app-border-light bg-elevated px-2.5 text-mini text-app-text hover:bg-app-hover disabled:opacity-50 @max-2xl:h-9 @max-2xl:flex-1 @max-2xl:justify-center @max-2xl:text-compact';
const CHIP = 'inline-flex h-[18px] flex-none items-center whitespace-nowrap rounded-xs px-1.5 text-mini';

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

async function readJson(path: string): Promise<unknown> {
  try {
    const r = await apiFetch(path);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** Every read of the section, again every POLL_MS while visible, after a write and on a new window. */
function useReads(days: HubUsageDays): { reads: Reads | null; reread: () => Promise<void> } {
  const [reads, setReads] = useState<Reads | null>(null);
  const alive = useRef(true);
  const read = useCallback(async () => {
    const [usageRaw, profiles, settings, live, queue, projects] = await Promise.all([
      readJson(`/api/hub-usage?days=${days}`), readJson('/api/switchboard/profiles'), readJson('/api/switchboard/settings'),
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
  }, [days]);
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
  const { reads, reread } = useReads(days);
  const live = useHubLive();
  const now = useNow();
  const answering = live.pace?.data !== undefined;
  // An unchanged hub reading is not pushed again, so this view's own reads count as answers too.
  const hubAt = answering ? Math.max(live.pace?.at ?? 0, reads?.at ?? 0) || null : (reads?.at || null);
  const [failure, setFailure] = useState<string | null>(null);

  const exchangeRate = exchangeRateOf(reads?.settings);
  const money = useCallback((usd: number) => formatCurrency(usd, exchangeRate, locale), [exchangeRate, locale]);
  const usage = reads?.usage ?? null;
  const planCost = useMemo(() => planCostForWindow(reads?.profiles, days), [reads?.profiles, days]);
  const saving = usage && planCost ? savingOf(usage.totals.listUsd, planCost.usd) : null;
  const projects = useMemo(() => projectShares(reads?.live), [reads?.live]);
  const decision = overCap(projects);
  const jobs = usage ? museJobs(reads?.queue, usage.sinceMs) : null;

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
        {decision && <Decide name={decision.project.title} pct={decision.project.total} cap={decision.project.budgetPct ?? 0} raiseTo={decision.raiseTo} onRaise={() => raise(decision.project.name, decision.raiseTo)} />}

        {reads?.usageFailed && !usage && <p data-testid="hub-usage-proxy-down" className="text-compact text-app-text-secondary">{tr('hubUsage.proxyDown')}</p>}

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

        {usage?.coverage.partial && usage.coverage.fromMs !== null && (
          <p data-testid="hub-usage-cut" className="text-mini text-app-text-secondary">
            {tr('hubUsage.cut', { when: new Date(usage.coverage.fromMs).toLocaleString(locale === 'it' ? 'it-IT' : 'en-US', { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })}
          </p>
        )}

        <ModelChart usage={usage} locale={locale} money={money} tr={tr} />

        <div className="grid grid-cols-3 gap-3 @max-4xl:grid-cols-1">
          <ByModel usage={usage} locale={locale} tr={tr} />
          <ByAccount profiles={reads?.profiles} usage={usage} pace={live.pace?.data} gates={live.gates?.data} tr={tr} />
          <ByProject live={reads?.live} tr={tr} />
        </div>

        <Saving usage={usage} planCost={planCost} saved={saving?.savedUsd ?? null} museTokens={museWeekTokens(reads?.projects)} money={money} locale={locale} tr={tr} />

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

function Tokens({ n, locale, unit }: { n: number; locale: string; unit: string }) {
  const t = tokenParts(n, locale);
  return <>{t.value}<small className="ml-[3px] text-mini font-normal text-app-text-muted">{t.unit ? `${t.unit} ${unit}` : unit}</small></>;
}

function modelName(key: string, tr: Tr): string {
  return key === 'other' ? tr('hubUsage.other') : friendlyModelLabel(key);
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

/** A round top for the axis: 1, 2 or 5 times a power of ten. */
function niceMax(v: number): number {
  if (v <= 0) return 0;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function Box({ testId, icon, title, meta, children, foot }: { testId: string; icon: ReactNode; title: string; meta: string; children: ReactNode; foot?: ReactNode }) {
  return (
    <section data-testid={testId} className={`${CARD} flex min-w-0 flex-col`}>
      <div className={BOX_HEAD}>
        <span className="text-app-text-muted" aria-hidden="true">{icon}</span>
        <h2 className={`m-0 ${BOX_TITLE}`}>{title}</h2>
        <span className="text-mini text-app-text-muted">{meta}</span>
      </div>
      <div className="flex-1">{children}</div>
      {foot && <div className="flex items-center gap-1.5 border-t border-app-border-subtle px-3 py-2 text-mini text-app-text-muted">{foot}</div>}
    </section>
  );
}

function Bar({ pct, hot = false, tone, cap }: { pct: number; hot?: boolean; tone?: string; cap?: number | null }) {
  return (
    <span className="relative h-1.5 min-w-0 flex-1 rounded-full bg-app-hover">
      <i className={`block h-full rounded-full ${tone ?? (hot ? 'bg-amber-500 dark:bg-amber-400' : 'bg-primary')}`} style={{ width: `${Math.max(pct > 0 ? 2 : 0, Math.min(100, pct))}%` }} />
      {cap != null && <u aria-hidden="true" className="absolute -top-[3px] h-3 w-0.5 rounded-[1px] bg-app-text-secondary" style={{ left: `${Math.min(100, cap)}%` }} />}
    </span>
  );
}

function ByModel({ usage, locale, tr }: { usage: HubUsage | null; locale: string; tr: Tr }) {
  const top = usage ? usage.models.slice(0, 4) : [];
  const rest = usage ? usage.models.slice(4) : [];
  const rows = [
    ...top.map((m) => ({ key: m.key, tokens: m.tokens, pct: usage ? sharePct(m, usage) : 0 })),
    ...(rest.length && usage ? [{ key: 'other', tokens: rest.reduce((s, m) => s + m.tokens, 0), pct: Math.round((100 * rest.reduce((s, m) => s + m.tokens, 0)) / Math.max(1, usage.totals.tokens)) }] : []),
  ];
  return (
    <Box testId="hub-usage-models" icon={<Cpu size={13} />} title={tr('hubUsage.byModel')} meta={tr('hubUsage.byModelMeta')}>
      {rows.map((r, i) => {
        const t = tokenParts(r.tokens, locale);
        return (
          <div key={r.key} data-testid="hub-usage-model-row" className={`${LINE} tabular-nums`}>
            <span className="flex w-[112px] flex-none items-center gap-1.5 truncate text-mini text-app-text">
              <i className={`h-2 w-2 flex-none rounded-[2px] ${TONES[i % TONES.length]!.bg}`} />
              <span className="truncate">{modelName(r.key, tr)}</span>
            </span>
            <Bar pct={r.pct} tone={TONES[i % TONES.length]!.bg} />
            <span className="w-[86px] flex-none text-right text-mini text-app-text-muted"><b className="font-semibold text-app-text">{r.pct}%</b> · {t.value}{t.unit}</span>
          </div>
        );
      })}
    </Box>
  );
}

function windowPct(w: QuotaWindow | null): number | null {
  return w ? w.pct : null;
}

function QuotaRow({ label, pct }: { label: string; pct: number | null }) {
  if (pct === null) return null;
  const hot = pct >= HOT_AT;
  return (
    <div className="flex h-5 items-center gap-2 tabular-nums">
      <span className="w-9 flex-none text-mini text-app-text-muted">{label}</span>
      <Bar pct={pct} hot={hot} />
      <span className={`w-9 flex-none text-right text-mini ${hot ? WARNING_TEXT : 'text-app-text-muted'}`}>{pct}%</span>
    </div>
  );
}

function ByAccount({ profiles, usage, pace, gates, tr }: { profiles: unknown; usage: HubUsage | null; pace: unknown; gates: unknown; tr: Tr }) {
  const accounts = accountShares(profiles, usage).filter((a) => !a.disabled);
  // One row per provider: the reader lists the active account first, the Accounts view shows the rest.
  const metered = meteredProviders(pace, gates).filter((m, i, all) => all.findIndex((o) => o.provider === m.provider) === i);
  return (
    <Box
      testId="hub-usage-accounts" icon={<UserRound size={13} />} title={tr('hubUsage.byAccount')} meta={tr('hubUsage.byAccountMeta')}
      foot={<>
        <span>{tr('hubUsage.rulesIn')}</span>
        <button type="button" data-testid="hub-usage-accounts-link" className={`${CHIP} bg-app-hover text-app-text-secondary hover:text-app-text`}
          onClick={() => window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: 'accounts' } }))}>
          {tr('hubUsage.accountsLink')}
        </button>
      </>}
    >
      {accounts.length === 0 && metered.length === 0 && <p className="px-3 py-2 text-mini text-app-text-muted">{tr('hubUsage.noAccounts')}</p>}
      {accounts.map((a) => (
        <div key={a.label} data-testid="hub-usage-account-row" className="border-t border-app-border-subtle px-3 py-2 first:border-t-0">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-compact text-app-text">{a.label}</span>
            {a.inUse && <span className={`${CHIP} bg-primary/10 text-blue-800 dark:text-primary`}>{tr('hubUsage.inUse')}</span>}
            {a.share !== null && <span className="text-mini tabular-nums text-app-text-muted" title={tr('hubUsage.shareTitle', { pct: `${a.share}%` })}>{a.share}%</span>}
          </div>
          <QuotaRow label={tr('hubUsage.fiveH')} pct={windowPct(a.fiveH)} />
          <QuotaRow label={tr('hubUsage.week')} pct={windowPct(a.week)} />
        </div>
      ))}
      {metered.map((m) => (
        <div key={m.provider} data-testid="hub-usage-metered-row" className="border-t border-app-border-subtle px-3 py-2 first:border-t-0">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-compact text-app-text">{m.provider === 'codex' ? 'Codex' : 'Muse'}</span>
            <span className={`${CHIP} bg-app-hover text-app-text-secondary`}>{tr('hubUsage.readOnly')}</span>
          </div>
          <QuotaRow label={tr('hubUsage.fiveH')} pct={m.fiveH} />
          <QuotaRow label={tr('hubUsage.week')} pct={m.week} />
        </div>
      ))}
    </Box>
  );
}

function ByProject({ live, tr }: { live: unknown; tr: Tr }) {
  const locale = useLocale();
  const { head, rest } = headAndRest(projectShares(live));
  const p = (v: number) => `${v.toLocaleString(locale === 'it' ? 'it-IT' : 'en-US', { maximumFractionDigits: 1 })}%`;
  return (
    <Box
      testId="hub-usage-projects" icon={<FolderOpen size={13} />} title={tr('hubUsage.byProject')} meta={tr('hubUsage.byProjectMeta')}
      foot={head.some((r) => r.budgetPct !== null) ? <><span className="inline-block h-3 w-0.5 rounded-[1px] bg-app-text-secondary" aria-hidden="true" /><span>{tr('hubUsage.capLegend')}</span></> : undefined}
    >
      {head.length === 0 && <p className="px-3 py-2 text-mini text-app-text-muted">{tr('hubUsage.noProjects')}</p>}
      {head.map((r) => (
        <div key={r.name} data-testid="hub-usage-project-row" data-over={r.over ? 'true' : undefined} className={`${LINE} tabular-nums`}
          title={[tr('hubUsage.projectTitle', { claude: p(r.claude), codex: p(r.codex), muse: p(r.muse) }), r.budgetPct !== null ? tr('hubUsage.projectCapTitle', { cap: p(r.budgetPct) }) : ''].filter(Boolean).join(' · ')}>
          <span className="flex w-[112px] flex-none items-center gap-1 truncate text-mini text-app-text">
            <span className="truncate">{r.title}</span>
            {r.over && <PauseCircle size={12} className={`flex-none ${WARNING_TEXT}`} aria-hidden="true" />}
          </span>
          <Bar pct={r.total} hot={r.over} cap={r.budgetPct} />
          <span className="w-[86px] flex-none text-right text-mini text-app-text-muted">
            <b className={`font-semibold ${r.over ? WARNING_TEXT : 'text-app-text'}`}>{p(r.total)}</b>{r.budgetPct !== null ? ` / ${p(r.budgetPct)}` : ''}
          </span>
        </div>
      ))}
      {rest && (
        <div data-testid="hub-usage-project-rest" className={`${LINE} tabular-nums`}>
          <span className="w-[112px] flex-none truncate text-mini text-app-text-muted">{tr('hubUsage.rest', { n: rest.count })}</span>
          <Bar pct={rest.total} />
          <span className="w-[86px] flex-none text-right text-mini"><b className="font-semibold text-app-text">{p(rest.total)}</b></span>
        </div>
      )}
    </Box>
  );
}

function Saving({ usage, planCost, saved, museTokens, money, locale, tr }: {
  usage: HubUsage | null; planCost: ReturnType<typeof planCostForWindow>; saved: number | null; museTokens: number | null; money: (usd: number) => string; locale: string; tr: Tr;
}) {
  const m = museTokens === null ? null : tokenParts(museTokens, locale);
  return (
    <Box testId="hub-usage-saving" icon={<PiggyBank size={13} />} title={tr('hubUsage.saving')} meta={tr('hubUsage.savingMeta')}>
      <div className="grid grid-cols-2 gap-4 px-3 py-2.5 tabular-nums @max-2xl:grid-cols-1">
        <div>
          <div className="text-mini text-app-text-muted">{tr('hubUsage.savingClaude')}</div>
          <div className="text-title font-semibold text-app-text">{saved === null ? '-' : money(saved)} <span className="text-mini font-normal text-app-text-muted">{tr('hubUsage.saved')}</span></div>
          {usage && planCost && <div className="text-mini text-app-text-muted">{tr('hubUsage.savingLine', { list: money(usage.totals.listUsd), paid: money(planCost.usd) })}</div>}
          {planCost && planCost.unpriced > 0 && <div className="text-mini text-app-text-muted">{tr('hubUsage.unpriced', { n: planCost.unpriced })}</div>}
        </div>
        <div>
          <div className="text-mini text-app-text-muted">{tr('hubUsage.savingMuse')}</div>
          {m ? (
            <>
              <div className="text-title font-semibold text-app-text">{m.value}{m.unit} <span className="text-mini font-normal text-app-text-muted">{tr('hubUsage.museTokens')}</span></div>
              <div className="text-mini text-app-text-muted">{tr('hubUsage.museLine')}</div>
            </>
          ) : <div className="text-mini text-app-text-muted">{tr('hubUsage.museNone')}</div>}
        </div>
      </div>
    </Box>
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
