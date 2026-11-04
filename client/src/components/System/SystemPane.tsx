/**
 * THE SYSTEM PANE: what the usage hub knows, beside the work.
 *
 * Desktop: one more column to the right of the work area (`SystemDock`). It
 * never takes the place of the tab in front and never becomes a top-level
 * tab; "open full view" widens the same pane over the work area and back.
 * Phone: the same body in the client's bottom sheet (`SystemSheet`, the
 * shared `Menu` primitive), over the chat.
 *
 * Sections, in the order Attilio approved (varianti/2-editoriale-piccola.html):
 * waiting for you, agents with one line of quotas, alerts, red gates,
 * automations. Everything arrives on the socket (state/hubLive.ts); the only
 * request this file makes is the close of a waiting item, and the list of
 * failed jobs when the summary says there are some.
 *
 * Lazy: the module is imported only when the pane opens.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle, Bot, CheckCircle2, ExternalLink, Gauge, Hourglass, Maximize2, Minimize2, ShieldX, Workflow, X, XCircle,
} from 'lucide-react';
import { useT, useLocale } from '../../hooks/useT';
import { useHubLive, type HubLiveEntry } from '../../state/hubLive';
import { closeSystemPane, toggleSystemPaneMaximized, useSystemPane } from '../../state/systemPane';
import {
  automationsSummary, closeWaitingBody, failedJobs, firingAlerts, quotaLines, redGates, waitingItems,
  type FailedJob, type WaitingItem, type WaitingKind,
} from '../../lib/hubSystem';
import { apiFetch } from '../../lib/shell/net';
import { useSharedNow } from '../../state/useSharedNow';
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
        {count !== undefined && <span className="font-medium normal-case tracking-normal text-app-text-muted">{count}</span>}
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
      const resp = await apiFetch('/api/hub/attesa', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(closeWaitingBody(id)),
      });
      if (!resp.ok) {
        const body = (await resp.json().catch(() => null)) as { error?: string } | null;
        failure = body?.error ?? `HTTP ${resp.status}`;
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
 * `/api/automations` answer, which is large, so it is asked once per change of
 * the count and only while this pane is open.
 */
function useFailedJobs(broken: number | null): FailedJob[] | null {
  const [jobs, setJobs] = useState<FailedJob[] | null>(null);
  useEffect(() => {
    if (broken === null || broken === 0) return;
    let live = true;
    void apiFetch('/api/hub/automations')
      .then((r) => (r.ok ? r.json() : null))
      .then((body: unknown) => { if (live) setJobs(body === null ? null : failedJobs(body)); })
      .catch(() => { if (live) setJobs(null); });
    return () => { live = false; };
  }, [broken]);
  return broken === 0 ? [] : jobs;
}

function AutomationsSection({ entry, t, locale }: { entry: HubLiveEntry | undefined; t: Translate; locale: string }) {
  const summary = entry?.data !== undefined ? automationsSummary(entry.data) : null;
  const jobs = useFailedJobs(summary ? summary.broken : null);
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

/** The sections, shared by the desktop column and the phone sheet. */
function SystemPaneBody() {
  const t = useT();
  const locale = useLocale();
  const live = useHubLive();
  const hubDown = Object.keys(live).length > 0 && Object.values(live).every((e) => !e || e.data === undefined);
  return (
    <div className="flex flex-col">
      {hubDown && (
        <div data-testid="system-hub-down" role="status" className={`${SURFACE} mb-3.5 ${QUIET}`}>{t('hubSystem.pane.hubDown')}</div>
      )}
      <WaitingSection entry={live.attesa} t={t} locale={locale} />
      <AgentsSection pace={live.pace} t={t} />
      <AlertsSection entry={live.alerts} t={t} />
      <GatesSection entry={live.gates} t={t} />
      <AutomationsSection entry={live.automations} t={t} locale={locale} />
    </div>
  );
}

function waitingCount(entry: HubLiveEntry | undefined): number {
  return entry?.data !== undefined ? waitingItems(entry.data).length : 0;
}

/** Desktop: the pane as a column beside the work, with the chrome of a pane. */
export function SystemDock() {
  const t = useT();
  const { maximized } = useSystemPane();
  const live = useHubLive();
  const count = waitingCount(live.attesa);
  const ExpandIcon = maximized ? Minimize2 : Maximize2;
  return (
    <aside
      data-testid="system-pane"
      data-maximized={maximized ? 'true' : 'false'}
      aria-label={t('hubSystem.pane.label')}
      className={`flex min-h-0 min-w-0 flex-col border-l border-app-border bg-app-bg ${maximized ? 'flex-1' : 'shrink-0'}`}
      style={maximized ? undefined : { width: 'min(452px, 45%)' }}
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-app-border px-1.5">
        <div data-testid="system-pane-tab" className="edge-lit inline-flex h-7 min-w-0 max-w-[200px] items-center gap-[7px] rounded-lg bg-elevated pl-2.5 pr-1 text-compact text-app-text">
          <Gauge size={13} aria-hidden="true" className="shrink-0 text-app-text-secondary" />
          <span className="truncate">{t('hubSystem.title')}</span>
          {count > 0 && (
            <span data-testid="system-pane-count" className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold tabular-nums text-white">{count}</span>
          )}
          <button
            type="button"
            data-testid="system-pane-close"
            aria-label={t('hubSystem.pane.close')}
            title={t('hubSystem.pane.close')}
            onClick={closeSystemPane}
            className="ml-auto inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded text-app-text-faint hover:bg-app-hover hover:text-app-text"
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
        <span className="flex-1" />
        <button
          type="button"
          data-testid="system-pane-maximize"
          aria-label={t(maximized ? 'hubSystem.pane.restore' : 'hubSystem.pane.openFull')}
          title={t(maximized ? 'hubSystem.pane.restore' : 'hubSystem.pane.openFull')}
          onClick={toggleSystemPaneMaximized}
          className="inline-flex h-6 w-6 items-center justify-center rounded-lg text-app-text-secondary hover:bg-app-hover hover:text-app-text"
        >
          <ExpandIcon size={13} aria-hidden="true" />
        </button>
      </div>
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
          className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-compact font-medium text-primary transition-colors hover:bg-app-hover dark:text-primary-dark"
        >
          {t(maximized ? 'hubSystem.pane.restore' : 'hubSystem.pane.openFull')}
          {maximized ? <Minimize2 size={12} aria-hidden="true" /> : <Maximize2 size={12} aria-hidden="true" />}
        </button>
      </div>
    </aside>
  );
}

/** Phone: the same body in the client's bottom sheet. */
export function SystemSheet() {
  const t = useT();
  const { open } = useSystemPane();
  // The sheet has no trigger to anchor to on the phone (it is a sheet, not a
  // card): `Menu` only uses the ref to tell an inside press from an outside one.
  const anchorRef = useRef<HTMLElement | null>(null);
  return (
    <Menu
      open={open}
      anchorRef={anchorRef}
      onClose={closeSystemPane}
      role="dialog"
      unmanagedFocus
      ariaLabel={t('hubSystem.pane.label')}
      testId="system-sheet"
    >
      <div className="px-3.5 pb-2 pt-1">
        <div className="mb-2 flex items-center gap-2 text-body-lg font-semibold text-app-text-heading">
          <Gauge size={15} aria-hidden="true" className="text-app-text-secondary" />
          {t('hubSystem.title')}
        </div>
        <SystemPaneBody />
      </div>
    </Menu>
  );
}
