/**
 * AGENTS AND JOBS, the level of System (hub-smistamento, HUBBR-13).
 *
 * Who works, in one list with three filters: In corso, In attesa, Finiti. The
 * sessions of Topics are the rows the card's badge counts (they lived under
 * Performance until this level took them: "who is running" has its own door
 * now, "what it costs" stays there). With the usage hub, the same list adds
 * the Claude proxy's sessions that run outside Topics, the hub's queue of
 * delegated jobs (in line, held by a quota, done or failed, and the one you
 * take out of the line) and the workflows. The cards of the Board are not
 * listed again: the night's cards stay on the Board, and the footer says so.
 *
 * Loaded as its own chunk when the level opens; its strings come with it.
 * The reads poll every 15 s while the level is open and the window visible.
 * With the hub silent, a band says so and the level shows Topics alone.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Check, ChevronDown, ChevronRight, Clock, CloudOff, Hourglass, MessageCircleQuestion, MessageSquare, Pause, Route,
  SquareKanban, SquareTerminal, Workflow, Wrench, X, type LucideIcon,
} from 'lucide-react';
import { useLocale, useT } from '../../hooks/useT';
import { useMobile } from '../../hooks/useMobile';
import { addCatalogue } from '../../lib/i18n';
import AGENTS_JOBS_IT from '../../lib/i18n-agents-jobs-it';
import AGENTS_JOBS_EN from '../../lib/i18n-agents-jobs-en';
import { apiFetch } from '../../lib/shell/net';
import { useHubEverRead } from '../../state/hubLive';
import { startVisibleInterval } from '../../state/documentVisibility';
import { useSharedNow } from '../../state/useSharedNow';
import { useActiveAgentRows } from '../../state/signals';
import { useTopics, useTerminalSessions } from '../../contexts/TopicsContext';
import { DANGER_TEXT, SUCCESS_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import { SparkLoader } from '../Layout/StreamingIndicator';
import { PALLINO_ATTESA, PALLINO_OK } from './chromeSignals';
import {
  agentsJobs, cancelRequest, openingFilter,
  type AgentsJobsView, type JobFilter, type JobRow, type JobSection, type SectionId,
} from '../../lib/agentsJobs';

addCatalogue('it', AGENTS_JOBS_IT);
addCatalogue('en', AGENTS_JOBS_EN);

type Tr = ReturnType<typeof useT>;

const POLL_MS = 15_000;
/** Rows of «Oggi» shown before «Altri N»: the level is a menu, not a log. */
const TODAY_VISIBLE = 6;
const FILTERS: JobFilter[] = ['running', 'waiting', 'finished'];

interface HubReads {
  queue: unknown;
  diary: unknown;
  proxy: unknown;
  /** reading: nothing answered yet; ok: the hub answered; down: it did not. */
  state: 'reading' | 'ok' | 'down';
}

async function readJson(path: string): Promise<unknown> {
  try {
    const r = await apiFetch(path, { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** The hub's queue and diary and the proxy's sessions, while the level is open. */
function useHubJobs(enabled: boolean): HubReads & { reread: () => void } {
  const [reads, setReads] = useState<HubReads>({ queue: null, diary: null, proxy: null, state: 'reading' });
  const alive = useRef(true);
  const read = useCallback(async () => {
    const [queue, diary, proxy] = await Promise.all([
      readJson('/api/hub/queue'),
      readJson('/api/hub/diario?days=2'),
      readJson('/api/switchboard/sessions'),
    ]);
    if (!alive.current) return;
    const answered = queue !== null || diary !== null;
    setReads({ queue, diary, proxy, state: answered ? 'ok' : 'down' });
  }, []);
  useEffect(() => {
    alive.current = true;
    if (!enabled) return () => { alive.current = false; };
    void read();
    const stop = startVisibleInterval(() => { void read(); }, POLL_MS);
    return () => { alive.current = false; stop(); };
  }, [enabled, read]);
  return { ...reads, reread: () => { void read(); } };
}

function useClock(locale: string) {
  return useMemo(() => {
    const time = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'it-IT', { hour: '2-digit', minute: '2-digit' });
    return (at: number) => time.format(at);
  }, [locale]);
}

function elapsed(tr: Tr, ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return tr('agentsJobs.min', { n: min });
  return tr('agentsJobs.hours', { h: Math.floor(min / 60), m: String(min % 60).padStart(2, '0') });
}

function shortTokens(n: number, locale: string): string {
  const fmt = (v: number) => v.toLocaleString(locale === 'en' ? 'en-GB' : 'it-IT', { maximumFractionDigits: 1 });
  if (n >= 1_000_000) return `${fmt(n / 1_000_000)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

const SOURCE_ICON: Record<JobRow['source'], LucideIcon> = {
  topic: MessageSquare,
  terminal: SquareTerminal,
  proxy: Route,
  queue: Wrench,
  workflow: Workflow,
};

/** The glyph says the kind of thing; a waiting, held or ended row says its state instead. */
function leadOf(row: JobRow): { Icon: LucideIcon; tone: string } {
  if (row.tone === 'you') return { Icon: MessageCircleQuestion, tone: WARNING_TEXT };
  if (row.tone === 'quota') return { Icon: Pause, tone: 'text-app-text-secondary' };
  if (row.tone === 'line') return { Icon: row.source === 'workflow' ? Clock : SOURCE_ICON[row.source], tone: 'text-app-text-secondary' };
  if (row.tone === 'ok') return { Icon: Check, tone: SUCCESS_TEXT };
  if (row.tone === 'failed') return { Icon: X, tone: DANGER_TEXT };
  return { Icon: SOURCE_ICON[row.source], tone: 'text-app-text-secondary' };
}

function titleOf(tr: Tr, row: JobRow): string {
  if (row.title) return row.title;
  if (row.fallback === 'proxy') return tr('agentsJobs.fallback.proxy');
  return row.project ? tr('agentsJobs.fallback.jobOn', { project: row.project }) : tr('agentsJobs.fallback.job');
}

function metaOf(tr: Tr, row: JobRow, locale: string): string {
  const parts: string[] = [];
  if (row.source === 'topic' || row.source === 'terminal') {
    parts.push(tr(row.source === 'topic' ? 'agentsJobs.src.topic' : 'agentsJobs.src.terminal'));
    if (row.tone === 'you') parts.push(tr('agentsJobs.meta.waitsYou'));
    if (row.tone === 'ok') parts.push(tr('agentsJobs.meta.finishedTurn'));
  } else if (row.source === 'proxy') {
    parts.push(tr('agentsJobs.src.proxy'));
    if (row.model) parts.push(row.model);
    if (row.requests) parts.push(row.requests === 1 ? tr('agentsJobs.meta.requestsOne') : tr('agentsJobs.meta.requests', { n: row.requests }));
    if (row.tokens) parts.push(tr('agentsJobs.meta.tokens', { n: shortTokens(row.tokens, locale) }));
    if (row.tone === 'ok' && row.durationMs) parts.push(elapsed(tr, row.durationMs));
  } else if (row.source === 'queue') {
    // A job still in line has no executor yet: it is the hub's, and says so.
    parts.push(row.provider ?? tr(row.tone === 'line' || row.tone === 'quota' ? 'agentsJobs.src.queue' : 'agentsJobs.meta.noExecutor'));
    if (row.project && row.title) parts.push(row.project);
    if (row.tone === 'quota') parts.push(tr('agentsJobs.meta.restarts'));
    if (row.tone === 'failed' && row.exit !== null && row.exit !== undefined) parts.push(tr('agentsJobs.meta.exit', { n: row.exit }));
    if ((row.tone === 'ok' || row.tone === 'failed') && row.durationMs) parts.push(elapsed(tr, row.durationMs));
  } else {
    parts.push(tr('agentsJobs.src.workflow'));
    if (row.what) parts.push(row.what);
  }
  return parts.join(' · ');
}

function rightOf(tr: Tr, row: JobRow, clock: (at: number) => string, now: number): string {
  if (row.tone === 'line' && row.rank) return tr('agentsJobs.rank', { n: row.rank });
  if (row.at === null) return '';
  if (row.tone === 'live') return elapsed(tr, now - row.at);
  return clock(row.at);
}

const SECTION_TEXT: Record<SectionId, { label: string; hint?: string; tone?: string; Icon?: LucideIcon }> = {
  topics: { label: 'agentsJobs.section.topics', hint: 'agentsJobs.section.topics.hint' },
  proxy: { label: 'agentsJobs.section.proxy', hint: 'agentsJobs.section.proxy.hint' },
  queue: { label: 'agentsJobs.section.queue', hint: 'agentsJobs.section.queue.hint' },
  workflows: { label: 'agentsJobs.section.workflows' },
  decide: { label: 'agentsJobs.section.decide', hint: 'agentsJobs.section.decide.hint', tone: WARNING_TEXT, Icon: Hourglass },
  line: { label: 'agentsJobs.section.line', hint: 'agentsJobs.section.line.hint' },
  quota: { label: 'agentsJobs.section.quota', hint: 'agentsJobs.section.quota.hint' },
  failed: { label: 'agentsJobs.section.failed', hint: 'agentsJobs.section.failed.hint', tone: DANGER_TEXT, Icon: X },
  today: { label: 'agentsJobs.section.today' },
  yesterday: { label: 'agentsJobs.section.yesterday' },
};

/** The testid a Topics row keeps from the list it came from (BGVIS-03 counts them). */
function rowTestId(row: JobRow): string {
  if (row.source === 'topic' || row.source === 'terminal') {
    return row.tone === 'live' ? 'active-agent-row' : row.tone === 'you' ? 'awaiting-agent-row' : 'finished-agent-row';
  }
  return 'agents-jobs-row';
}

function openTarget(row: JobRow, onNavigate?: () => void): void {
  const t = row.target;
  if (!t) return;
  onNavigate?.();
  if (t.kind === 'topic') {
    window.dispatchEvent(new CustomEvent('topics:open-topic', { detail: { topicId: t.id, mode: 'permanent', reveal: true } }));
  } else {
    window.dispatchEvent(new CustomEvent('topics:open-terminal-pane', { detail: { sessionId: t.id, name: t.name } }));
  }
}

export interface AgentsJobsLevelProps {
  /** Closes the menu: a row that opens a pane leaves it. */
  onNavigate?: () => void;
}

export function AgentsJobsLevel({ onNavigate }: AgentsJobsLevelProps) {
  const tr = useT();
  const locale = useLocale();
  const { isMobile } = useMobile();
  const now = useSharedNow();
  const clock = useClock(locale);
  const hubPresent = useHubEverRead();
  const hub = useHubJobs(hubPresent);
  const topics = useActiveAgentRows(useTerminalSessions(), useTopics());
  const view: AgentsJobsView = useMemo(
    () => agentsJobs({ topics, queue: hub.queue, diary: hub.diary, proxy: hub.proxy, now }),
    [topics, hub.queue, hub.diary, hub.proxy, now],
  );
  const [chosen, setChosen] = useState<JobFilter | null>(null);
  const filter = chosen ?? openingFilter(view);
  const [withdrawn, setWithdrawn] = useState<Set<string>>(() => new Set());
  const [failedWithdraw, setFailedWithdraw] = useState<string | null>(null);
  const [showAllToday, setShowAllToday] = useState(false);

  const withdraw = useCallback(async (id: string) => {
    const req = cancelRequest(id);
    setFailedWithdraw(null);
    try {
      const r = await apiFetch(req.path, req.init);
      const body = r.ok ? await r.json() as { ok?: boolean } : null;
      if (!body?.ok) throw new Error('not removed');
      setWithdrawn((s) => new Set(s).add(id));
      hub.reread();
    } catch {
      setFailedWithdraw(id);
    }
  }, [hub]);

  const sections = (filter === 'running' ? view.running : filter === 'waiting' ? view.waiting : view.finished)
    .map((s) => ({ ...s, rows: s.rows.filter((r) => !r.cancelId || !withdrawn.has(r.cancelId)) }))
    .filter((s) => s.rows.length > 0);
  const hubDown = hubPresent && hub.state === 'down';

  const pad = isMobile ? 'px-4' : 'px-3';
  return (
    <div data-testid="agents-jobs-level" data-filter={filter} className="flex min-w-0 flex-col">
      <div className={`flex items-center gap-2 ${pad} pb-1.5 pt-2.5`}>
        <span className={`flex-1 font-semibold text-app-text ${isMobile ? 'text-body-lg' : 'text-compact'}`}>{tr('agentsJobs.open')}</span>
        {hubPresent && (
          <span data-testid="agents-jobs-freshness" className="flex items-center gap-1.5 text-mini text-app-text-secondary">
            <span className={`h-1.5 w-1.5 rounded-full ${hubDown ? PALLINO_ATTESA : PALLINO_OK}`} />
            {hub.state === 'reading' ? tr('agentsJobs.reading') : hubDown ? tr('agentsJobs.hubDown') : tr('agentsJobs.updated')}
          </span>
        )}
      </div>

      <div role="tablist" className="mx-2.5 mb-1.5 grid grid-cols-3 gap-0.5 rounded border border-app-border bg-app-inset p-0.5">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={f === filter}
            data-testid={`agents-jobs-filter-${f}`}
            onClick={() => { setChosen(f); setShowAllToday(false); }}
            className={`flex items-center justify-center gap-1.5 rounded-sm ${isMobile ? 'min-h-11 text-body-lg' : 'h-7 text-compact coarse:min-h-11'} transition-colors ${
              f === filter ? 'border border-app-border-light bg-elevated text-app-text' : 'border border-transparent text-app-text-secondary hover:text-app-text'
            }`}
          >
            {f === 'waiting' && view.decide > 0 && <span className={`h-1.5 w-1.5 rounded-full ${PALLINO_ATTESA}`} />}
            <span>{tr(`agentsJobs.filter.${f}`)}</span>
            <span data-testid={`agents-jobs-count-${f}`} className="tabular-nums text-app-text-muted">{view.counts[f]}</span>
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-1">
        {filter === 'running' && view.decide > 0 && (
          <div data-testid="agents-jobs-band" className={`mx-2.5 mb-1 flex items-center gap-2 rounded border border-amber-500/30 bg-amber-500/10 ${pad} py-1.5 text-compact`}>
            <span className={`h-1.5 w-1.5 flex-none rounded-full ${PALLINO_ATTESA}`} />
            <span className="flex-1 font-semibold text-app-text">{view.decide === 1 ? tr('agentsJobs.bandOne') : tr('agentsJobs.band', { n: view.decide })}</span>
            <button type="button" className="inline-flex items-center gap-0.5 text-primary hover:underline" onClick={() => setChosen('waiting')}>
              {tr('agentsJobs.filter.waiting')}<ChevronRight size={12} aria-hidden="true" />
            </button>
          </div>
        )}
        {hubDown && (
          <div data-testid="agents-jobs-hub-down" className={`flex items-center gap-2 ${pad} py-1.5 text-mini ${WARNING_TEXT}`}>
            <CloudOff size={12} className="flex-none" aria-hidden="true" />
            <span className="flex-1">{tr('agentsJobs.hubDown')}</span>
            <button type="button" className="text-primary hover:underline" onClick={hub.reread}>{tr('agentsJobs.retry')}</button>
          </div>
        )}
        {sections.length === 0 && (
          <div data-testid="agents-jobs-empty" className={`${pad} py-3 text-mini text-app-text-secondary`}>{tr(`agentsJobs.empty.${filter}`)}</div>
        )}
        {sections.map((s) => (
          <Section
            key={s.id}
            section={s}
            tr={tr}
            pad={pad}
            limit={s.id === 'today' && !showAllToday ? TODAY_VISIBLE : null}
            onMore={() => setShowAllToday(true)}
            renderRow={(row) => (
              <Row
                key={row.key}
                row={row}
                tr={tr}
                pad={pad}
                isMobile={isMobile}
                meta={metaOf(tr, row, locale)}
                right={rightOf(tr, row, clock, now)}
                failedWithdraw={row.cancelId !== undefined && failedWithdraw === row.cancelId}
                onOpen={row.target ? () => openTarget(row, onNavigate) : undefined}
                onWithdraw={row.cancelId ? () => { void withdraw(row.cancelId!); } : undefined}
              />
            )}
          />
        ))}
      </div>

      <div className={`flex items-center gap-1.5 border-t border-app-border ${pad} py-2 text-mini text-app-text-secondary`}>
        <SquareKanban size={12} className="flex-none" aria-hidden="true" />
        <span>{tr('agentsJobs.footer')}</span>
        <button
          type="button"
          data-testid="agents-jobs-board"
          className="text-primary hover:underline"
          onClick={() => { onNavigate?.(); window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: 'board' } })); }}
        >
          {tr('agentsJobs.footer.board')}
        </button>
      </div>
    </div>
  );
}

function Section({ section, tr, pad, limit, onMore, renderRow }: {
  section: JobSection;
  tr: Tr;
  pad: string;
  limit: number | null;
  onMore: () => void;
  renderRow: (row: JobRow) => ReactNode;
}) {
  const text = SECTION_TEXT[section.id];
  const rows = limit !== null ? section.rows.slice(0, limit) : section.rows;
  const hidden = section.rows.length - rows.length;
  const decide = section.id === 'decide';
  return (
    <div data-testid={`agents-jobs-section-${section.id}`} className="mt-1.5 first:mt-0.5">
      <div className={`flex items-center gap-1.5 ${pad} pb-1 pt-1.5 text-mini font-semibold uppercase tracking-wide ${text.tone ?? 'text-app-text-secondary'}`}>
        {text.Icon && <text.Icon size={12} className="flex-none" aria-hidden="true" />}
        <span>{tr(text.label)}</span>
        <span className="tabular-nums font-normal">{section.rows.length}</span>
        {text.hint && <span className="ml-auto font-normal normal-case tracking-normal text-app-text-muted">{tr(text.hint)}</span>}
      </div>
      {decide
        ? rows.map((r) => (
          <div key={r.key} className="mx-2 mb-1.5 rounded border border-amber-500/40 bg-amber-500/[0.07]">{renderRow(r)}</div>
        ))
        : rows.map(renderRow)}
      {hidden > 0 && (
        <button type="button" data-testid="agents-jobs-more" onClick={onMore} className={`flex w-full items-center gap-1.5 ${pad} py-1 text-mini text-app-text-secondary hover:text-app-text`}>
          <ChevronDown size={12} aria-hidden="true" />{tr('agentsJobs.more', { n: hidden })}
        </button>
      )}
    </div>
  );
}

function Row({ row, tr, pad, isMobile, meta, right, failedWithdraw, onOpen, onWithdraw }: {
  row: JobRow;
  tr: Tr;
  pad: string;
  isMobile: boolean;
  meta: string;
  right: string;
  failedWithdraw: boolean;
  onOpen?: () => void;
  onWithdraw?: () => void;
}) {
  const { Icon, tone } = leadOf(row);
  const title = titleOf(tr, row);
  const live = row.tone === 'live';
  const body = (
    <>
      <span className="mt-0.5 flex h-4 w-4 flex-none items-center justify-center">
        {live ? <SparkLoader /> : <Icon size={14} className={tone} aria-hidden="true" />}
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={`min-w-0 truncate text-app-text ${isMobile ? 'text-body-lg' : 'text-compact'}`} title={title}>{title}</span>
          {row.fold && row.fold > 1 && (
            <span className="flex-none rounded-xs border border-app-border-light px-1 text-mini tabular-nums text-app-text-secondary">×{row.fold}</span>
          )}
          {row.tone === 'quota' && <span className={`flex-none rounded-xs bg-amber-500/15 px-1 text-mini font-semibold ${WARNING_TEXT}`}>{tr('agentsJobs.chip.quota')}</span>}
          {row.tone === 'failed' && <span className={`flex-none rounded-xs bg-red-500/10 px-1 text-mini font-semibold ${DANGER_TEXT}`}>{tr('agentsJobs.chip.failed')}</span>}
        </span>
        {meta && <span className="block truncate text-mini text-app-text-secondary" title={meta}>{meta}</span>}
        {failedWithdraw && <span className={`block text-mini ${DANGER_TEXT}`}>{tr('agentsJobs.withdrawFailed')}</span>}
      </span>
      {right && <span className="mt-0.5 flex-none text-mini tabular-nums text-app-text-secondary">{right}</span>}
    </>
  );
  const rowClass = `flex w-full items-start gap-2 ${pad} ${isMobile ? 'py-2.5' : 'py-1.5'}`;
  return (
    <div data-testid={rowTestId(row)} data-kind={row.source} data-tone={row.tone} className="group flex items-start">
      {onOpen && row.tone !== 'you'
        ? <button type="button" onClick={onOpen} className={`${rowClass} hover:bg-app-hover`}>{body}</button>
        : <div className={rowClass}>{body}</div>}
      {onWithdraw && (
        <button
          type="button"
          data-testid="agents-jobs-withdraw"
          aria-label={tr('agentsJobs.withdraw')}
          title={tr('agentsJobs.withdraw')}
          onClick={onWithdraw}
          className={`mr-2 mt-1 flex flex-none items-center justify-center rounded-sm text-app-text-muted hover:bg-app-hover hover:text-app-text ${isMobile ? 'h-11 w-11' : 'h-6 w-6 coarse:h-11 coarse:w-11'}`}
        >
          <X size={13} aria-hidden="true" />
        </button>
      )}
      {onOpen && row.tone === 'you' && <OpenButton tr={tr} row={row} onOpen={onOpen} isMobile={isMobile} />}
    </div>
  );
}

function OpenButton({ tr, row, onOpen, isMobile }: { tr: Tr; row: JobRow; onOpen: () => void; isMobile: boolean }) {
  return (
    <button
      type="button"
      data-testid="agents-jobs-open"
      onClick={onOpen}
      className={`mr-2 mt-1 inline-flex flex-none items-center gap-1 whitespace-nowrap rounded-sm bg-primary px-2.5 font-medium text-white hover:bg-primary/90 ${isMobile ? 'h-11 text-body-lg' : 'h-[26px] text-compact coarse:h-11'}`}
    >
      {tr(row.source === 'terminal' ? 'agentsJobs.openTerminal' : 'agentsJobs.openChat')}
      <ChevronRight size={12} aria-hidden="true" />
    </button>
  );
}
