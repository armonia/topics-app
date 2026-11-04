/**
 * THE SYSTEM PANE: what the usage hub knows, beside the work.
 *
 * Desktop: a pane kind of its own (`system`, id `__system__`) that opens as
 * one more split cell beside the work (state/systemPane.ts), with the grid's
 * own tab, resize and persistence. It never takes the place of the tab in
 * front. «Open full view» is the grid's zoom on its cell: the other cells keep
 * their size and are only hidden, so no terminal is ever fitted to zero width.
 * Phone: the same body in the client's bottom sheet (`SystemSheet`, the shared
 * `Menu` primitive), over the chat.
 *
 * Sections, in the order Attilio approved (the small editorial mockup): the
 * lede, waiting for you, agents with one line of quotas, alerts, red gates,
 * automations. Everything arrives on the socket (state/hubLive.ts); the only
 * requests this file makes are the close of a waiting item, and the list of
 * failed jobs whenever the summary changes and says there are some.
 *
 * Lazy: the module is imported only when the pane opens.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle, ArrowRight, Bot, CheckCircle2, ExternalLink, Gauge, Hourglass, Minimize2, ShieldX, Workflow, XCircle,
} from 'lucide-react';
import { useT, useLocale } from '../../hooks/useT';
import { refreshHubLive, useHubLive, type HubLiveEntry } from '../../state/hubLive';
import { closeSystemSheet, toggleSystemPaneMaximized, useSystemPaneMaximized, useSystemSheetOpen } from '../../state/systemPane';
import {
  automationSummary, closeWaitingBody, failedJobs, firingAlerts, quotaLines, redGates, waitingItems,
  type FailedJob, type WaitingItem, type WaitingKind,
} from '../../lib/hubSystem';
import { apiFetch } from '../../lib/shell/net';
import { useSharedNow } from '../../state/useSharedNow';
import { shortcut } from '../../lib/shortcutLabel';
import { AgentLines } from '../Sidebar/AgentLines';
import { Menu } from '../Shared/Menu';

type Translate = ReturnType<typeof useT>;

const KIND_TONE: Record<WaitingKind, { pill: string; dot: string }> = {
  decisione: { pill: 'bg-violet-500/15 text-violet-700 dark:text-violet-300', dot: 'bg-violet-400' },
  spesa: { pill: 'bg-amber-500/15 text-amber-800 dark:text-amber-300', dot: 'bg-amber-500' },
  pubblico: { pill: 'bg-sky-500/15 text-sky-800 dark:text-sky-300', dot: 'bg-sky-400' },
  vista: { pill: 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300', dot: 'bg-emerald-500' },
};

const SURFACE = 'overflow-hidden rounded-lg border border-app-border bg-surface';
const ROW = 'flex items-center gap-2 border-t border-app-border px-3 py-2 text-compact text-app-text first:border-t-0';
const QUIET = 'px-3 py-2 text-mini text-app-text-secondary';
const PRIMARY_BUTTON = 'inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-lg bg-primary px-2.5 text-compact font-medium text-white transition-colors hover:bg-primary-hover active:scale-[0.97]';
const QUIET_BUTTON = 'inline-flex h-[26px] shrink-0 items-center gap-1 rounded-lg px-2 text-compact text-app-text-secondary transition-colors hover:bg-app-hover hover:text-app-text';

function Section({ id, icon, title, count, warm = false, children }: {
  id: string;
  icon: ReactNode;
  title: string;
  count?: number;
  warm?: boolean;
  children: ReactNode;
}) {
  return (
    <section data-testid={`system-section-${id}`} className="mt-3.5 first:mt-0">
      <h3 className={`flex h-7 items-center gap-2 text-mini font-semibold uppercase tracking-wide ${warm ? 'text-amber-700 dark:text-amber-300' : 'text-app-text-muted'}`}>
        {icon}
        {title}
        {count !== undefined && <span data-testid={`system-section-${id}-count`} className="font-medium normal-case tracking-normal text-app-text-muted">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

/** What a section says while its topic has no data: reading, or unreadable. */
function TopicState({ entry, t }: { entry: HubLiveEntry | undefined; t: Translate }) {
  return (
    <div className={`${SURFACE} ${QUIET}`} data-testid="system-topic-state" data-error={entry?.error ? 'true' : undefined}>
      {entry?.error ? t('hubSystem.pane.topicError') : t('hubSystem.pane.loading')}
    </div>
  );
}

function formatWhen(at: number, locale: string): string {
  return new Date(at).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function WaitingRow({ item, t, locale, onClose, error }: {
  item: WaitingItem;
  t: Translate;
  locale: string;
  onClose: (id: string) => void;
  error: string | null;
}) {
  const tone = KIND_TONE[item.kind];
  const now = useSharedNow();
  const overdue = item.due !== null && item.due < now;
  return (
    <div data-testid="system-waiting-item" data-id={item.id} data-kind={item.kind} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-t border-app-border px-3 py-2.5 first:border-t-0">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2 text-mini">
          <span className={`inline-flex h-[18px] shrink-0 items-center gap-1 rounded px-1.5 font-medium ${tone.pill}`}>
            <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
            {t(`hubSystem.waiting.kind.${item.kind}`)}
          </span>
          {item.due !== null && (
            <span className={`truncate font-mono tabular-nums ${overdue ? 'text-amber-700 dark:text-amber-300' : 'text-app-text-muted'}`}>
              {formatWhen(item.due, locale)}{overdue ? ` · ${t('hubSystem.waiting.overdue')}` : ''}
            </span>
          )}
        </div>
        <div className="mt-1 truncate text-compact font-medium text-app-text" title={item.title}>{item.title}</div>
        {item.why && <div className="mt-0.5 line-clamp-2 text-mini text-app-text-secondary">{item.why}</div>}
        {item.from && <div className="mt-0.5 truncate text-mini text-app-text-muted">{t('hubSystem.waiting.from', { from: item.from })}</div>}
        {error && <div role="alert" className="mt-1 text-mini text-red-700 dark:text-red-400">{t('hubSystem.waiting.closeFailed', { error })}</div>}
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          data-testid="system-waiting-close"
          title={t('hubSystem.waiting.closeTitle')}
          onClick={() => onClose(item.id)}
          className={item.link ? QUIET_BUTTON : PRIMARY_BUTTON}
        >
          <CheckCircle2 size={13} aria-hidden="true" />
          {t('hubSystem.waiting.close')}
        </button>
        {item.link && (
          <a data-testid="system-waiting-open" href={item.link} target="_blank" rel="noopener noreferrer" className={PRIMARY_BUTTON}>
            {t('hubSystem.waiting.open')}
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        )}
      </div>
    </div>
  );
}

function WaitingSection({ entry, t, locale }: { entry: HubLiveEntry | undefined; t: Translate; locale: string }) {
  // Hidden at once on "done", before the hub's next push confirms it; a
  // refused close brings the row back with the reason.
  const [closing, setClosing] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const items = entry?.data !== undefined ? waitingItems(entry.data).filter((i) => !closing.has(i.id)) : null;

  const close = async (id: string) => {
    setClosing((s) => new Set(s).add(id));
    setErrors((e) => { if (!(id in e)) return e; const n = { ...e }; delete n[id]; return n; });
    let failure: string | null = null;
    try {
      const resp = await apiFetch('/api/hub/attesa', { // allow-italian: the hub's own path
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(closeWaitingBody(id)),
      });
      if (!resp.ok) {
        const body = (await resp.json().catch(() => null)) as { error?: string } | null;
        failure = body?.error ?? `HTTP ${resp.status}`;
      } else {
        await refreshHubLive();
        // From here the list on screen is the hub's: drop the optimistic hide.
        setClosing((s) => { const n = new Set(s); n.delete(id); return n; });
      }
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    if (failure !== null) {
      const reason = failure;
      setClosing((s) => { const n = new Set(s); n.delete(id); return n; });
      setErrors((e) => ({ ...e, [id]: reason }));
    }
  };

  return (
    <Section id="waiting" icon={<Hourglass size={11} aria-hidden="true" />} title={t('hubSystem.waiting.title')} count={items?.length} warm={(items?.length ?? 0) > 0}>
      {items === null ? <TopicState entry={entry} t={t} /> : (
        <div className={SURFACE}>
          {items.length === 0
            ? <div className={QUIET}>{t('hubSystem.waiting.empty')}</div>
            : items.map((item) => <WaitingRow key={item.id} item={item} t={t} locale={locale} onClose={(id) => { void close(id); }} error={errors[item.id] ?? null} />)}
        </div>
      )}
    </Section>
  );
}

function QuotaLineRow({ entry, t }: { entry: HubLiveEntry | undefined; t: Translate }) {
  const quotas = quotaLines(entry?.data);
  if (quotas.length === 0) return null;
  return (
    <div data-testid="system-quota-line" className="mt-1 flex items-center gap-2.5 overflow-hidden whitespace-nowrap border-t border-app-border px-1 pt-2 text-mini text-app-text-muted">
      <b className="font-medium text-app-text-secondary">{t('hubSystem.agents.quota')}</b>
      {quotas.map((q) => (
        <span key={q.key} className="inline-flex items-center gap-1">
          {q.provider}
          {q.fiveHour !== null && <span className="font-mono tabular-nums">{t('hubSystem.agents.fiveHour')} {q.fiveHour}%</span>}
          <span className={`font-mono tabular-nums ${q.hot ? 'text-amber-700 dark:text-amber-300' : 'text-app-text'}`}>{t('hubSystem.agents.week')} {q.used}%</span>
        </span>
      ))}
    </div>
  );
}

function AgentsSection({ pace, t }: { pace: HubLiveEntry | undefined; t: Translate }) {
  return (
    <Section id="agents" icon={<Bot size={11} aria-hidden="true" />} title={t('hubSystem.agents.title')}>
      {/* The very rows of the user menu's agents level: one list of who works
          and who waits for an answer, not a second drawing of it. */}
      <div className={`${SURFACE} py-0.5`}>
        <AgentLines />
      </div>
      <QuotaLineRow entry={pace} t={t} />
    </Section>
  );
}

function AlertsSection({ entry, t }: { entry: HubLiveEntry | undefined; t: Translate }) {
  const alerts = entry?.data !== undefined ? firingAlerts(entry.data) : null;
  return (
    <Section id="alerts" icon={<AlertTriangle size={11} aria-hidden="true" />} title={t('hubSystem.alerts.title')} count={alerts?.length}>
      {alerts === null ? <TopicState entry={entry} t={t} /> : (
        <div className={SURFACE}>
          {alerts.length === 0
            ? <div className={QUIET}>{t('hubSystem.alerts.empty')}</div>
            : alerts.map((a) => (
              <div key={a.id} data-testid="system-alert" className={ROW}>
                <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                <span className="min-w-0 flex-1 line-clamp-2">{a.message}</span>
              </div>
            ))}
        </div>
      )}
    </Section>
  );
}

function GatesSection({ entry, t }: { entry: HubLiveEntry | undefined; t: Translate }) {
  const gates = entry?.data !== undefined ? redGates(entry.data) : null;
  return (
    <Section id="gates" icon={<ShieldX size={11} aria-hidden="true" />} title={t('hubSystem.gates.title')} count={gates?.length}>
      {gates === null ? <TopicState entry={entry} t={t} /> : (
        <div className={SURFACE}>
          {gates.length === 0
            ? <div className={QUIET}>{t('hubSystem.gates.empty')}</div>
            : gates.map((g) => (
              <div key={g.id} data-testid="system-gate" className={ROW}>
                <XCircle size={13} aria-hidden="true" className="shrink-0 text-red-600 dark:text-red-400" />
                <span className="min-w-0 flex-1 truncate">
                  <b className="font-medium">{g.kind === 'brake' ? t('hubSystem.gates.brake', { name: g.name }) : g.name}</b>
                  {g.reason && <span className="text-app-text-secondary"> {g.reason}</span>}
                </span>
              </div>
            ))}
        </div>
      )}
    </Section>
  );
}

/**
 * The failed jobs. The summary only counts them; their names are in the full
 * `/api/automations` answer, which is large, so it is asked only while this
 * pane is open and once per NEW reading of the summary (`readAt`): the server
 * pushes a reading only when the summary changed, so a failed job replaced by
 * another one with the same count is still read again.
 */
function useFailedJobs(broken: number | null, readAt: number | null): FailedJob[] | null {
  const [jobs, setJobs] = useState<FailedJob[] | null>(null);
  useEffect(() => {
    if (broken === null || broken === 0) return;
    let live = true;
    void apiFetch('/api/hub/automations')
      .then((r) => (r.ok ? r.json() : null))
      .then((body: unknown) => { if (live) setJobs(body === null ? null : failedJobs(body)); })
      .catch(() => { if (live) setJobs(null); });
    return () => { live = false; };
  }, [broken, readAt]);
  return broken === 0 ? [] : jobs;
}

function AutomationSection({ entry, t, locale }: { entry: HubLiveEntry | undefined; t: Translate; locale: string }) {
  const summary = entry?.data !== undefined ? automationSummary(entry.data) : null;
  const jobs = useFailedJobs(summary ? summary.broken : null, summary ? entry?.at ?? null : null);
  const counters: Array<{ key: string; label: string; value: number; bad?: boolean }> = summary ? [
    { key: 'needsYou', label: t('hubSystem.automations.needsYou'), value: summary.needsYou },
    { key: 'broken', label: t('hubSystem.automations.broken'), value: summary.broken, bad: summary.broken > 0 },
    { key: 'ok', label: t('hubSystem.automations.ok'), value: summary.ok },
    { key: 'runsToday', label: t('hubSystem.automations.runsToday'), value: summary.runsToday },
  ] : [];
  return (
    <Section id="automations" icon={<Workflow size={11} aria-hidden="true" />} title={t('hubSystem.automations.title')}>
      {summary === null ? <TopicState entry={entry} t={t} /> : (
        <div className={SURFACE}>
          <div className="grid grid-cols-4 divide-x divide-app-border">
            {counters.map((c) => (
              <div key={c.key} data-testid={`system-automations-${c.key}`} className="px-3 py-2">
                <div className="truncate text-mini text-app-text-muted">{c.label}</div>
                <div className={`font-mono text-body-lg font-medium tabular-nums ${c.bad ? 'text-red-700 dark:text-red-400' : 'text-app-text'}`}>{c.value}</div>
              </div>
            ))}
          </div>
          {summary.next && (
            <div className={`${ROW} text-mini text-app-text-secondary`}>
              {t('hubSystem.automations.next', { title: summary.next.title, when: formatWhen(summary.next.at, locale) })}
            </div>
          )}
          {summary.broken > 0 && jobs?.map((j) => (
            <div key={j.key} data-testid="system-failed-job" className={ROW}>
              <XCircle size={13} aria-hidden="true" className="shrink-0 text-red-600 dark:text-red-400" />
              <span className="min-w-0 flex-1 truncate font-medium">{j.title}</span>
              {j.at !== null && <span className="shrink-0 font-mono text-mini tabular-nums text-app-text-muted">{formatWhen(j.at, locale)}</span>}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function waitingCount(entry: HubLiveEntry | undefined): number {
  return entry?.data !== undefined ? waitingItems(entry.data).length : 0;
}

function plural(n: number): 'zero' | 'one' | 'other' {
  return n === 0 ? 'zero' : n === 1 ? 'one' : 'other';
}

/**
 * THE LEDE, the line that makes this the editorial variant: how many things
 * wait for you, and whether everything else is handled. "Handled" is said only
 * when no alert fires, no gate is red and no automation failed; otherwise the
 * line counts what else is below.
 */
function Lede({ live, t }: { live: ReturnType<typeof useHubLive>; t: Translate }) {
  if (live.attesa?.data === undefined) return null;
  const n = waitingCount(live.attesa);
  const summary = live.automations?.data !== undefined ? automationSummary(live.automations.data) : null;
  const issues = (live.alerts?.data !== undefined ? firingAlerts(live.alerts.data).length : 0)
    + (live.gates?.data !== undefined ? redGates(live.gates.data).length : 0)
    + (summary?.broken ?? 0);
  const runs = summary?.runsToday ?? 0;
  const form = plural(n);
  return (
    <div data-testid="system-lede" className="mb-1.5">
      <h2 className="text-[17px] font-semibold leading-[22px] tracking-[-0.015em] text-app-text-heading">
        <b className="font-semibold">{t(`hubSystem.lede.count.${form}`, { n })}</b>
        <span className="font-medium text-app-text-muted">{t(form === 'other' ? 'hubSystem.lede.verb.other' : 'hubSystem.lede.verb.one')}</span>
      </h2>
      {summary && (
        <p className="mt-0.5 text-compact text-app-text-secondary">
          {issues === 0
            ? t('hubSystem.lede.handled', { runs })
            : t(issues === 1 ? 'hubSystem.lede.issues.one' : 'hubSystem.lede.issues.other', { n: issues, runs })}
        </p>
      )}
    </div>
  );
}

/** «live · 17:52»: when the newest reading arrived, so a quiet pane reads as current. */
function LiveStamp({ live, locale, t }: { live: ReturnType<typeof useHubLive>; locale: string; t: Translate }) {
  const readings = Object.values(live).filter((e): e is HubLiveEntry => !!e && e.data !== undefined);
  if (readings.length === 0) return null;
  const at = Math.max(...readings.map((e) => e.at));
  const time = new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  return (
    <span data-testid="system-live" className="inline-flex shrink-0 items-center gap-1.5 font-mono text-mini text-app-text-muted">
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
      {t('hubSystem.pane.live', { time })}
    </span>
  );
}

/** The sections, shared by the desktop pane and the phone sheet. */
function SystemPaneBody() {
  const t = useT();
  const locale = useLocale();
  const live = useHubLive();
  const hubDown = Object.keys(live).length > 0 && Object.values(live).every((e) => !e || e.data === undefined);
  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1"><Lede live={live} t={t} /></div>
        <LiveStamp live={live} locale={locale} t={t} />
      </div>
      {hubDown && (
        <div data-testid="system-hub-down" role="status" className={`${SURFACE} mb-3.5 ${QUIET}`}>{t('hubSystem.pane.hubDown')}</div>
      )}
      <div className="mt-2">
        <WaitingSection entry={live.attesa} t={t} locale={locale} />
        <AgentsSection pace={live.pace} t={t} />
        <AlertsSection entry={live.alerts} t={t} />
        <GatesSection entry={live.gates} t={t} />
        <AutomationSection entry={live.automations} t={t} locale={locale} />
      </div>
    </div>
  );
}

/**
 * Desktop: the body of the `system` pane, inside the grid cell (the tab, its
 * close and the resize are the grid's). The foot opens the full view: the
 * grid's zoom on this cell, and back.
 */
export function SystemPane() {
  const t = useT();
  const maximized = useSystemPaneMaximized();
  const FootIcon = maximized ? Minimize2 : ArrowRight;
  return (
    <div
      data-testid="system-pane"
      data-maximized={maximized ? 'true' : 'false'}
      aria-label={t('hubSystem.pane.label')}
      className="flex h-full min-h-0 min-w-0 flex-col bg-app-bg"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-4 pt-3.5">
        <div className={maximized ? 'mx-auto max-w-[760px]' : undefined}>
          <SystemPaneBody />
        </div>
      </div>
      <div className="shrink-0 border-t border-app-border px-2 py-1.5">
        <button
          type="button"
          data-testid="system-pane-open-full"
          onClick={toggleSystemPaneMaximized}
          className="group flex h-8 w-full items-center gap-2 rounded-lg px-2 text-compact font-medium text-primary transition-colors hover:bg-app-hover dark:text-primary-dark"
        >
          {t(maximized ? 'hubSystem.pane.restore' : 'hubSystem.pane.openFull')}
          <FootIcon size={12} aria-hidden="true" className="transition-transform group-hover:translate-x-0.5" />
          <span className="ml-auto inline-flex items-center gap-1.5 text-mini font-normal text-app-text-muted">
            <kbd className="rounded border border-app-border px-1 font-mono text-[10px] text-app-text-secondary">{shortcut('K')}</kbd>
            {t('hubSystem.pane.paletteHint')}
          </span>
        </button>
      </div>
    </div>
  );
}

/** Phone: the same body in the client's bottom sheet, three quarters of the screen. */
export function SystemSheet() {
  const t = useT();
  const open = useSystemSheetOpen();
  // The sheet has no trigger to anchor to on the phone (it is a sheet, not a
  // card): `Menu` only uses the ref to tell an inside press from an outside one.
  const anchorRef = useRef<HTMLElement | null>(null);
  const live = useHubLive();
  const count = waitingCount(live.attesa);
  return (
    <Menu
      open={open}
      anchorRef={anchorRef}
      onClose={closeSystemSheet}
      role="dialog"
      unmanagedFocus
      ariaLabel={t('hubSystem.pane.label')}
      testId="system-sheet"
    >
      {/* The cap is on the content and not on the sheet: the sheet's own
          inline cap is the screen, and the approved mockup leaves the top
          quarter to the chat. */}
      <div className="overflow-y-auto overscroll-contain px-3.5 pb-2 pt-1" style={{ maxHeight: '72dvh' }}>
        <div className="mb-2 flex items-center gap-2 text-body-lg font-semibold text-app-text-heading">
          <Gauge size={15} aria-hidden="true" className="text-app-text-secondary" />
          {t('hubSystem.title')}
          {count > 0 && (
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold tabular-nums text-white">{count}</span>
          )}
        </div>
        <SystemPaneBody />
      </div>
    </Menu>
  );
}
