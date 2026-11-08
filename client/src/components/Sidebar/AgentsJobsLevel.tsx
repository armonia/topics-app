/**
 * AGENTS AND JOBS, the level of System (hub-smistamento, HUBBR-13).
 *
 * Who works, in one list with three filters: running, waiting, finished. The
 * sessions of Topics are the rows the card's badge counts (they lived under
 * Performance until this level took them: "who is running" has its own door
 * now, "what it costs" stays there). With the usage hub, the same list adds
 * the Claude proxy's sessions that run outside Topics, the hub's queue of
 * delegated jobs (in line, held by a quota, done or failed, and the one you
 * take out of the line) and the workflows with the bar of their phases, and
 * what the hub sees at work outside Topics: Claude Code elsewhere, Codex,
 * Muse, the sub-agents and the live workflows, each with its project's icon,
 * its tokens and its share of the week. A session of the proxy says the tool
 * it runs, its account, since when it waits for input, and opens on its
 * timeline (the summaries, never the prompts); two sessions editing one file
 * raise a band. What waits on you comes first and says what it asks: the
 * chat's question, the workflow's gate. The cards of the Board are not listed
 * again: the night's cards stay on the Board, and the footer says so, with
 * the way to Automazioni > Calendario.
 *
 * Loaded as its own chunk when the level opens; its strings come with it.
 * The reads poll every 15 s while the level is open and the window visible.
 * With the hub silent, a band says since when, the hub's last answer stays
 * on screen, and the retry reads again. On the phone the level is the one
 * sheet in sight, with its own way back to System and its own close.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle, Bot, Check, ChevronDown, ChevronLeft, ChevronRight, Clock, CloudOff, Hourglass, MessageCircleQuestion, MessageSquare, Pause, Route,
  SquareKanban, SquareTerminal, Terminal, Workflow, Wrench, X, type LucideIcon,
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
import { attentionOf, terminalSubject, topicSubject, useAttentionRows } from '../../state/attention';
import { openAutomation, openAutomationsCalendar } from '../../state/automationTarget';
import { peekAgentsJobsFilter, takeAgentsJobsFilter } from '../../lib/agentsJobsLink';
import { exchangeRateOf, formatCurrency } from '../../lib/hubUsage';
import { JobProjectIcon } from './JobProjectIcon';
import { useCloseLevel } from '../Shared/levelClose';
import { setGateWaits } from '../../state/gateWaits';
import { useTopics, useTerminalSessions } from '../../contexts/TopicsContext';
import { DANGER_TEXT, SUCCESS_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import { SparkLoader } from '../Layout/StreamingIndicator';
import { PALLINO_ATTESA, PALLINO_OK } from './chromeSignals';
import {
  agentsJobs, cancelRequest, openingFilter,
  type AgentsJobsView, type JobFilter, type JobRow, type JobSection, type SectionId, type StepMark,
} from '../../lib/agentsJobs';

addCatalogue('it', AGENTS_JOBS_IT);
addCatalogue('en', AGENTS_JOBS_EN);

type Tr = ReturnType<typeof useT>;

const POLL_MS = 15_000;
/** The automations are read one round in four: once a minute. */
const AUTOMATIONS_EVERY = 4;
/** Rows of today shown before the "N more" row: the level is a menu, not a log. */
const TODAY_VISIBLE = 6;
const FILTERS: JobFilter[] = ['running', 'waiting', 'finished'];

interface HubReads {
  queue: unknown;
  diary: unknown;
  proxy: unknown;
  automations: unknown;
  /** The hub's board and live agents: who works outside Topics. */
  board: unknown;
  live: unknown;
  /** The proxy's dollar to euro rate, for a session's cost. */
  rate: number;
  /** reading: nothing answered yet; ok: the hub answered; down: it did not. */
  state: 'reading' | 'ok' | 'down';
  /** The hub's last answer, kept on screen while it is silent. */
  okAt: number | null;
  /** The first read the hub did not answer, since it last did. */
  downSince: number | null;
}

async function readJson(path: string): Promise<unknown> {
  try {
    const r = await apiFetch(path, { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/**
 * The hub's queue, diary and automations and the proxy's sessions, while the
 * level is open. The automations answer last (their first read after a cold
 * start takes seconds): they arrive on their own and never hold the rest. They
 * weigh most of a megabyte, so they are read once a minute, not every round.
 */
function useHubJobs(enabled: boolean): HubReads & { reread: () => void } {
  const [reads, setReads] = useState<HubReads>({ queue: null, diary: null, proxy: null, automations: null, board: null, live: null, rate: exchangeRateOf(null), state: 'reading', okAt: null, downSince: null });
  const alive = useRef(true);
  const round = useRef(0);
  const read = useCallback(async (force = false) => {
    const first = round.current === 0;
    if (force || round.current++ % AUTOMATIONS_EVERY === 0) {
      void readJson('/api/hub/automations').then((automations) => {
        if (alive.current && automations !== null) setReads((r) => ({ ...r, automations }));
      });
    }
    if (first) {
      void readJson('/api/switchboard/settings').then((settings) => {
        if (alive.current && settings !== null) setReads((r) => ({ ...r, rate: exchangeRateOf(settings) }));
      });
    }
    const [queue, diary, proxy, board, live] = await Promise.all([
      readJson('/api/hub/queue'),
      readJson('/api/hub/diario?days=2'),
      readJson('/api/switchboard/sessions'),
      readJson('/api/hub/board'),
      readJson('/api/hub/live'),
    ]);
    if (!alive.current) return;
    if (queue !== null || diary !== null) {
      setReads((r) => ({ ...r, queue, diary, proxy, board, live, state: 'ok', okAt: Date.now(), downSince: null }));
    } else {
      setReads((r) => ({ ...r, state: 'down', downSince: r.downSince ?? Date.now() }));
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    if (!enabled) return () => { alive.current = false; };
    // eslint-disable-next-line react-hooks/set-state-in-effect -- first read on mount, then polling: the state is set after the fetch resolves
    void read();
    const stop = startVisibleInterval(() => { void read(); }, POLL_MS);
    return () => { alive.current = false; stop(); };
  }, [enabled, read]);
  return { ...reads, reread: () => { void read(true); } };
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

const STEP_FILL: Record<StepMark, string> = {
  done: 'bg-emerald-600 dark:bg-emerald-400',
  active: 'bg-primary',
  failed: 'bg-red-600 dark:bg-red-400',
  todo: 'bg-app-border-light',
};

const SOURCE_ICON: Record<JobRow['source'], LucideIcon> = {
  topic: MessageSquare,
  terminal: SquareTerminal,
  proxy: Route,
  queue: Wrench,
  workflow: Workflow,
  outside: Terminal,
  subagent: Bot,
};

/** The kind of each source, said in the glyph's tooltip as the hub's «tipo» column did. */
const SOURCE_KIND: Record<JobRow['source'], string> = {
  topic: 'agentsJobs.kind.topic',
  terminal: 'agentsJobs.kind.terminal',
  proxy: 'agentsJobs.kind.proxy',
  queue: 'agentsJobs.kind.queue',
  workflow: 'agentsJobs.kind.workflow',
  outside: 'agentsJobs.kind.outside',
  subagent: 'agentsJobs.kind.subagent',
};

/** The glyph says the kind of thing; a waiting, held or ended row says its state instead. */
function leadOf(row: JobRow): { Icon: LucideIcon; tone: string } {
  if (row.tone === 'you') return { Icon: row.source === 'workflow' ? Workflow : MessageCircleQuestion, tone: WARNING_TEXT };
  if (row.tone === 'quota') return { Icon: Pause, tone: 'text-app-text-secondary' };
  if (row.tone === 'line') return { Icon: row.source === 'workflow' ? Clock : SOURCE_ICON[row.source], tone: 'text-app-text-secondary' };
  if (row.tone === 'ok') return { Icon: Check, tone: SUCCESS_TEXT };
  if (row.tone === 'failed') return { Icon: X, tone: DANGER_TEXT };
  // At work but waiting: for its next input (proxy), on a live command (hub).
  if (row.idleSince || row.onCommand) return { Icon: Hourglass, tone: 'text-app-text-secondary' };
  return { Icon: SOURCE_ICON[row.source], tone: 'text-app-text-secondary' };
}

function titleOf(tr: Tr, row: Pick<JobRow, 'title' | 'repairOf' | 'fallback' | 'project' | 'channel' | 'runner'>): string {
  if (row.title) return row.title;
  if (row.fallback === 'outside' || row.fallback === 'subagent' || row.fallback === 'workflow') {
    const on = row.project ? 'On' : '';
    return tr(`agentsJobs.fallback.${row.fallback}${on}`, { runner: row.runner ?? 'Claude', project: row.project ?? '' });
  }
  if (row.repairOf) return tr('agentsJobs.repair', { name: row.repairOf });
  if (row.fallback === 'jarvis') return tr('agentsJobs.fallback.jarvis', { channel: row.channel ?? '' });
  if (row.fallback === 'workflowAgent') return tr('agentsJobs.fallback.workflowAgent');
  if (row.fallback === 'proxy') return tr('agentsJobs.fallback.proxy');
  return row.project ? tr('agentsJobs.fallback.jobOn', { project: row.project }) : tr('agentsJobs.fallback.job');
}

function pct(n: number, locale: string): string {
  if (n > 0 && n < 0.1) return locale === 'en' ? '<0.1' : '<0,1';
  return n.toLocaleString(locale === 'en' ? 'en-GB' : 'it-IT', { maximumFractionDigits: 1 });
}

/** Tokens and share of the week, the cost of a row: the same words for every source. */
function spend(tr: Tr, row: JobRow, locale: string, rate: number): string[] {
  const parts: string[] = [];
  if (row.tokens) parts.push(tr('agentsJobs.meta.tokens', { n: shortTokens(row.tokens, locale) }));
  if (row.weekPct) parts.push(tr('agentsJobs.meta.week', { n: pct(row.weekPct, locale) }));
  if (row.costUsd && row.tone !== 'live') parts.push(tr('agentsJobs.meta.cost', { eur: formatCurrency(row.costUsd, rate, locale) }));
  return parts;
}

function metaOf(tr: Tr, row: JobRow, locale: string, now: number, rate: number): string {
  const parts: string[] = [];
  if (row.source === 'topic' || row.source === 'terminal') {
    parts.push(tr(row.source === 'topic' ? 'agentsJobs.src.topic' : 'agentsJobs.src.terminal'));
    if (row.project) parts.push(row.project);
    if (row.tone === 'you') parts.push(row.at !== null ? tr('agentsJobs.meta.waitingFor', { t: elapsed(tr, now - row.at) }) : tr('agentsJobs.meta.waitsYou'));
    if (row.tone === 'ok') parts.push(tr('agentsJobs.meta.finishedTurn'));
  } else if (row.source === 'outside' || row.source === 'subagent') {
    parts.push(row.runner ?? 'Claude');
    if (row.model) parts.push(row.model);
    if (row.project && row.title) parts.push(row.project);
    if (row.onCommand) parts.push(tr('agentsJobs.meta.onCommand'));
    parts.push(...spend(tr, row, locale, rate));
  } else if (row.source === 'proxy') {
    parts.push(tr('agentsJobs.src.proxy'));
    if (row.account) parts.push(row.account);
    if (row.model) parts.push(row.model);
    if (row.project) parts.push(row.project);
    if (row.idleSince) parts.push(tr('agentsJobs.meta.idle', { t: elapsed(tr, now - row.idleSince) }));
    else if (row.activity) parts.push(row.activity.file ? tr(`agentsJobs.act.${row.activity.verb}.file`, { file: row.activity.file }) : tr(`agentsJobs.act.${row.activity.verb}`));
    if (row.requests) parts.push(row.requests === 1 ? tr('agentsJobs.meta.requestsOne') : tr('agentsJobs.meta.requests', { n: row.requests }));
    parts.push(...spend(tr, row, locale, rate));
    if (row.tone === 'ok' && row.durationMs) parts.push(elapsed(tr, row.durationMs));
  } else if (row.source === 'queue') {
    // A job still in line has no executor yet: it is the hub's, and says so.
    parts.push(row.provider ?? tr(row.tone === 'line' || row.tone === 'quota' ? 'agentsJobs.src.queue' : 'agentsJobs.meta.noExecutor'));
    // A job in line says what it waits on; the others where they work.
    const w = row.tone === 'line' ? row.waitsOn : undefined;
    if (w?.kind === 'reason') parts.push(tr('agentsJobs.meta.waitsOn', { why: w.why }));
    else if (w?.kind === 'macFree') parts.push(tr('agentsJobs.meta.macFree'));
    else if (w?.kind === 'after') parts.push(tr('agentsJobs.meta.after', { title: titleOf(tr, w.row) }));
    else if (w?.kind === 'next') parts.push(tr('agentsJobs.meta.next'));
    else if (row.project && (row.title || row.repairOf)) parts.push(row.project);
    // How long it has waited in line: the hub's «when» column for a queued job.
    if ((row.tone === 'line' || row.tone === 'quota') && row.queuedAt) parts.push(tr('agentsJobs.meta.queuedFor', { t: elapsed(tr, now - row.queuedAt) }));
    if (row.tone === 'quota') parts.push(row.pausedWhy ? tr('agentsJobs.meta.paused', { why: row.pausedWhy }) : tr('agentsJobs.meta.restarts'));
    if (row.tone === 'failed' && row.exit !== null && row.exit !== undefined) parts.push(tr('agentsJobs.meta.exit', { n: row.exit }));
    if ((row.tone === 'ok' || row.tone === 'failed') && row.durationMs) parts.push(elapsed(tr, row.durationMs));
  } else {
    parts.push(tr('agentsJobs.src.workflow'));
    if (row.tone === 'you') {
      parts.push(row.at !== null ? tr('agentsJobs.meta.waitingFor', { t: elapsed(tr, now - row.at) }) : tr('agentsJobs.meta.waitsYou'));
    } else if (row.step) {
      parts.push(tr('agentsJobs.meta.step', { n: row.step.n, of: row.step.of }));
      if (row.step.title) parts.push(row.step.title);
    } else if (row.steps && row.steps.length && row.tone !== 'live') {
      parts.push(row.steps.length === 1 ? tr('agentsJobs.meta.phasesOne') : tr('agentsJobs.meta.phases', { n: row.steps.length }));
    }
    if (row.agents) parts.push(row.agents === 1 ? tr('agentsJobs.meta.agentsOne') : tr('agentsJobs.meta.agents', { n: row.agents }));
    parts.push(...spend(tr, row, locale, rate));
    if (row.tone !== 'live' && row.tone !== 'you' && row.durationMs) parts.push(elapsed(tr, row.durationMs));
  }
  return parts.join(' · ');
}

function rightOf(tr: Tr, row: JobRow, clock: (at: number) => string, now: number): string {
  if (row.tone === 'line' && row.rank) return tr('agentsJobs.rank', { n: row.rank });
  if (row.at === null) return '';
  if (row.tone === 'live' || row.tone === 'you') return elapsed(tr, now - row.at);
  return clock(row.at);
}

const SECTION_TEXT: Record<SectionId, { label: string; hint?: string; tone?: string; Icon?: LucideIcon }> = {
  topics: { label: 'agentsJobs.section.topics', hint: 'agentsJobs.section.topics.hint' },
  outside: { label: 'agentsJobs.section.outside', hint: 'agentsJobs.section.outside.hint' },
  subagents: { label: 'agentsJobs.section.subagents', hint: 'agentsJobs.section.subagents.hint' },
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
  const topicsById = useTopics();
  const rows = useActiveAgentRows(useTerminalSessions(), topicsById);
  const attention = useAttentionRows();
  // What a row waiting on you asks, and since when it works, waits or finished: the attention
  // store has it, one line. A chat's project is its folder: its icon and its name.
  const topics = useMemo(() => {
    const withState = (r: (typeof rows.working)[number]) => {
      const a = attentionOf(attention, r.kind === 'topic' ? topicSubject(r.id) : terminalSubject(r.id));
      const t = r.kind === 'topic' ? topicsById[r.id] : undefined;
      return { ...r, question: a.detail, since: a.since || null, projectPath: t && !t.standalone ? t.projectPath ?? null : null };
    };
    return { working: rows.working.map(withState), awaitingInput: rows.awaitingInput.map(withState), finished: rows.finished.map(withState) };
  }, [rows, attention, topicsById]);
  const view: AgentsJobsView = useMemo(
    () => agentsJobs({ topics, queue: hub.queue, diary: hub.diary, proxy: hub.proxy, automations: hub.automations, board: hub.board, live: hub.live, now }),
    [topics, hub.queue, hub.diary, hub.proxy, hub.automations, hub.board, hub.live, now],
  );
  // The row of System counts the gates too, from the same read.
  const gates = view.decide - topics.awaitingInput.length;
  useEffect(() => { setGateWaits(gates); }, [gates]);
  const closeLevel = useCloseLevel();
  // A link (`/lavori/<filter>`) or a door of the app may ask for a filter. Read in
  // render, consumed only once mounted: a render React throws away (a child that
  // suspends on its chunk, seen on WebKit) would otherwise eat the request.
  const [chosen, setChosen] = useState<JobFilter | null>(() => peekAgentsJobsFilter());
  useEffect(() => { takeAgentsJobsFilter(); }, []);
  const [timelineOpen, setTimelineOpen] = useState<string | null>(null);
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
  const downFor = hub.downSince !== null ? elapsed(tr, now - hub.downSince) : '';
  const freshness = hubPresent && (
    <span data-testid="agents-jobs-freshness" className="flex items-center gap-1.5 text-mini text-app-text-secondary">
      <span className={`h-1.5 w-1.5 rounded-full ${hubDown ? PALLINO_ATTESA : PALLINO_OK}`} />
      {hub.state === 'reading' ? tr('agentsJobs.reading') : hubDown ? tr('agentsJobs.hubDownFor', { t: downFor }) : tr('agentsJobs.updated')}
    </span>
  );

  const pad = isMobile ? 'px-4' : 'px-3';
  return (
    <div data-testid="agents-jobs-level" data-filter={filter} className="flex min-w-0 flex-col">
      {isMobile ? (
        // The phone: one sheet in sight, the way back to System and the close of the whole menu.
        <>
          <div className="relative flex h-11 items-center px-1">
            <button type="button" data-testid="agents-jobs-back" onClick={closeLevel} className="flex h-11 items-center gap-0.5 px-2 text-body-lg text-primary">
              <ChevronLeft size={18} aria-hidden="true" />{tr('agentsJobs.back')}
            </button>
            <span className="pointer-events-none absolute inset-x-0 text-center text-body-lg font-semibold text-app-text">{tr('agentsJobs.open')}</span>
            <button type="button" data-testid="agents-jobs-close" aria-label={tr('agentsJobs.close')} onClick={() => onNavigate?.()} className="ml-auto grid h-11 w-11 place-items-center text-app-text-secondary">
              <X size={18} aria-hidden="true" />
            </button>
          </div>
          <div className="flex justify-center pb-2">{freshness}</div>
        </>
      ) : (
        <div className={`flex items-center gap-2 ${pad} pb-1.5 pt-2.5`}>
          <span className="flex-1 text-compact font-semibold text-app-text">{tr('agentsJobs.open')}</span>
          {freshness}
        </div>
      )}

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
        {filter === 'running' && view.conflicts.map((c) => (
          // Two sessions editing one file: the proxy's warning, as the hub's sessions page raised it.
          <div key={c.path} data-testid="agents-jobs-conflict" title={c.path} className={`mx-2.5 mb-1 flex items-center gap-2 rounded border border-amber-500/30 bg-amber-500/10 ${pad} py-1.5 text-compact`}>
            <AlertTriangle size={12} className={`flex-none ${WARNING_TEXT}`} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-app-text">{tr('agentsJobs.conflict', { n: c.count, file: c.file })}</span>
          </div>
        ))}
        {hubPresent && hub.state === 'ok' && filter !== 'waiting' && view.proxyState !== 'ok' && (
          <div data-testid="agents-jobs-proxy-state" className={`flex items-center gap-2 ${pad} py-1.5 text-mini text-app-text-secondary`}>
            <Route size={12} className="flex-none" aria-hidden="true" />
            <span className="flex-1">{tr(view.proxyState === 'monitorOff' ? 'agentsJobs.proxyMonitorOff' : 'agentsJobs.proxySilent')}</span>
          </div>
        )}
        {hubDown && (
          <div data-testid="agents-jobs-hub-down" className={`flex items-center gap-2 ${pad} py-1.5 text-mini ${WARNING_TEXT}`}>
            <CloudOff size={12} className="flex-none" aria-hidden="true" />
            <span className="flex-1">{hub.okAt !== null ? tr('agentsJobs.hubDownSince', { t: downFor, time: clock(hub.okAt) }) : tr('agentsJobs.hubDown')}</span>
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
                meta={metaOf(tr, row, locale, now, hub.rate)}
                right={rightOf(tr, row, clock, now)}
                onAutomation={row.automationKey ? () => { onNavigate?.(); openAutomation(row.automationKey!); } : undefined}
                timelineOpen={timelineOpen === row.key}
                onTimeline={row.timeline?.length ? () => setTimelineOpen(timelineOpen === row.key ? null : row.key) : undefined}
                failedWithdraw={row.cancelId !== undefined && failedWithdraw === row.cancelId}
                onOpen={row.target ? () => openTarget(row, onNavigate) : undefined}
                onWithdraw={row.cancelId ? () => { void withdraw(row.cancelId!); } : undefined}
              />
            )}
          />
        ))}
      </div>

      <div className={`flex min-w-0 items-center gap-1.5 border-t border-app-border ${pad} ${isMobile ? 'py-2.5 text-body' : 'py-2 text-mini'} text-app-text-secondary`}>
        <SquareKanban size={12} className="flex-none" aria-hidden="true" />
        <span className="min-w-0 truncate">
          {tr(isMobile ? 'agentsJobs.footer.short' : 'agentsJobs.footer')}{' '}
          <button
            type="button"
            data-testid="agents-jobs-board"
            className="text-primary hover:underline"
            onClick={() => { onNavigate?.(); window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: 'board' } })); }}
          >
            {tr('agentsJobs.footer.board')}
          </button>
          {hubPresent && (
            <>
              {' · '}{tr(isMobile ? 'agentsJobs.footer.calendarShort' : 'agentsJobs.footer.calendar')}{' '}
              {/* Topics' own Automazioni, on its Calendar tab: the dated reminders and the jobs that end. */}
              <button
                type="button"
                data-testid="agents-jobs-automations"
                className="text-primary hover:underline"
                onClick={() => { onNavigate?.(); openAutomationsCalendar(); }}
              >
                {tr('agentsJobs.footer.automations')}
              </button>
            </>
          )}
        </span>
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
          <div key={r.key} data-testid="agents-jobs-decide-card" className="mx-2 mb-1.5 rounded border border-amber-500/40 bg-amber-500/[0.07] pb-2">{renderRow(r)}</div>
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

function Row({ row, tr, pad, isMobile, meta, right, failedWithdraw, onOpen, onWithdraw, onAutomation, timelineOpen = false, onTimeline }: {
  row: JobRow;
  tr: Tr;
  pad: string;
  isMobile: boolean;
  meta: string;
  right: string;
  failedWithdraw: boolean;
  onOpen?: () => void;
  onWithdraw?: () => void;
  /** Opens the automation a gate waits in, in Topics' Automazioni. */
  onAutomation?: () => void;
  timelineOpen?: boolean;
  onTimeline?: () => void;
}) {
  const { Icon, tone } = leadOf(row);
  const title = titleOf(tr, row);
  const live = row.tone === 'live' && !row.idleSince && !row.onCommand;
  const body = (
    <>
      <span className="mt-0.5 flex h-4 w-4 flex-none items-center justify-center" title={tr(SOURCE_KIND[row.source])} data-kind-glyph={row.source}>
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
        {meta && (
          <span className="flex min-w-0 items-center gap-1 text-mini text-app-text-secondary" title={meta}>
            <JobProjectIcon iconPath={row.iconPath} hubIcon={row.hubIcon} />
            <span className="min-w-0 truncate">{meta}</span>
          </span>
        )}
        {timelineOpen && row.timeline && (
          <span data-testid="agents-jobs-timeline" className="mt-1 block border-l border-app-border-light pl-2">
            {row.timeline.map((line, i) => <span key={i} className="block text-mini text-app-text-secondary">{line}</span>)}
          </span>
        )}
        {row.steps && row.steps.length > 0 && (
          <span data-testid="agents-jobs-steps" className="mt-1.5 flex gap-[3px]" aria-hidden="true">
            {row.steps.map((m, i) => <i key={i} data-step={m} className={`h-[3px] flex-1 rounded-full ${STEP_FILL[m]}`} />)}
          </span>
        )}
        {failedWithdraw && <span className={`block text-mini ${DANGER_TEXT}`}>{tr('agentsJobs.withdrawFailed')}</span>}
      </span>
      {right && <span className="mt-0.5 flex-none text-mini tabular-nums text-app-text-secondary">{right}</span>}
    </>
  );
  const rowClass = `flex w-full items-start gap-2 ${pad} ${isMobile ? 'py-2.5' : 'py-1.5'}`;
  if (row.tone === 'you') {
    // A card: what it asks, in its words, and the one way to answer it from here.
    const act = `inline-flex items-center gap-1 whitespace-nowrap rounded-sm bg-primary px-2.5 font-medium text-white hover:bg-primary/90 ${isMobile ? 'h-9 text-body' : 'h-6 text-mini coarse:h-11'}`;
    return (
      <div data-testid={rowTestId(row)} data-kind={row.source} data-tone={row.tone}>
        <div className={rowClass}>{body}</div>
        {row.question && (
          <div data-testid="agents-jobs-question" className={`${isMobile ? 'ml-[46px] text-body' : 'ml-[38px] text-compact'} mr-3 text-app-text`}>“{row.question}”</div>
        )}
        {(onOpen || onAutomation) && (
          <div className={`${isMobile ? 'ml-[46px]' : 'ml-[38px]'} mt-2 flex flex-wrap gap-1.5`}>
            {onOpen && (
              <button type="button" data-testid="agents-jobs-open" onClick={onOpen} className={act}>
                {tr(row.source === 'terminal' ? 'agentsJobs.openTerminal' : 'agentsJobs.openChat')}
                <ChevronRight size={12} aria-hidden="true" />
              </button>
            )}
            {!onOpen && onAutomation && (
              // Topics' own Automazioni, on this automation: on the phone too, and after the hub's pages are gone.
              <button type="button" data-testid="agents-jobs-open-hub" onClick={onAutomation} className={act}>
                {tr('agentsJobs.openAutomations')}
                <ChevronRight size={12} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </div>
    );
  }
  return (
    <div data-testid={rowTestId(row)} data-kind={row.source} data-tone={row.tone} className="group flex items-start">
      {onOpen
        ? <button type="button" onClick={onOpen} className={`${rowClass} hover:bg-app-hover`}>{body}</button>
        : <div className={rowClass}>{body}</div>}
      {onTimeline && (
        <button
          type="button"
          data-testid="agents-jobs-timeline-toggle"
          aria-expanded={timelineOpen}
          aria-label={tr('agentsJobs.timeline')}
          title={tr('agentsJobs.timeline')}
          onClick={onTimeline}
          className={`mr-2 mt-1 flex flex-none items-center justify-center rounded-sm text-app-text-muted hover:bg-app-hover hover:text-app-text ${isMobile ? 'h-11 w-11' : 'h-6 w-6 coarse:h-11 coarse:w-11'}`}
        >
          {timelineOpen ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
        </button>
      )}
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
    </div>
  );
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
