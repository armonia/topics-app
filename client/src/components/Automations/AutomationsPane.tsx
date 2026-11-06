/**
 * AUTOMAZIONI (hub-smistamento, HUBBR-14 and HUBBR-15): the hub's scheduled
 * jobs in a whole view, opened from the row above the Board. It takes the
 * place of the Cron panel: the OpenClaw jobs are one of its systems, with
 * their commands, so the same jobs are no longer in two places.
 *
 * At the top the verdict (how many need fixing, the rest in order, how fresh
 * the numbers are, the tokens and the sources in pills), then «Decidi tu»:
 * what is broken or waits on you, oldest first, each with «Risolvi tu». A
 * status filter (all, in order, problems) and a search («/» brings the
 * focus there) narrow every list. The rows are grouped by system or, as the
 * hub grouped them, by what they do for you. By system: Jarvis (OpenClaw: run, switch on and off,
 * delete, through Topics' cron routes, off when the gateway does not answer),
 * Mac and GitHub read-only, PC and the workflows. A system all in order folds
 * into the "other areas" block. A row opens its detail: votes and notes written to the
 * hub's feedback log and read back, and the runs. The Calendar tab holds the
 * hub's dated reminders and jobs. Under the lists, «Computer e app» (the
 * computer's own apps, outside the problems) and the foot with the sources
 * and the hidden jobs.
 *
 * The keyboard, as on the hub: j/k or the arrows move between rows, «p»
 * opens a row's steps, Esc closes the detail and gives the focus back to its
 * row; the vote letters are the detail's.
 *
 * Loaded as its own chunk, only where the hub is part of the installation.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlarmClock, ChevronRight, CircleCheck, CloudOff, LayoutGrid, Search, TriangleAlert, Workflow, X } from 'lucide-react';
import { useLocale, useT } from '../../hooks/useT';
import { useConfirm } from '../../hooks/useConfirm';
import { addCatalogue } from '../../lib/i18n';
import AUTOMATIONS_IT from '../../lib/i18n-automations-it';
import AUTOMATIONS_EN from '../../lib/i18n-automations-en';
import { useHubEverRead } from '../../state/hubLive';
import { AUTOMATION_TARGET_EVENT, takeAutomationTarget } from '../../state/automationTarget';
import { startVisibleInterval } from '../../state/documentVisibility';
import { DANGER_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import {
  AUTOMATION_SYSTEMS, gatesWaiting, isProblem, matchesQuery, matchesStatus, scheduleParts, systemCounts, systemRows, toDecide, verdictOf,
  type AutomationRow, type AutomationSystem, type CronJob, type JobCommand, type StatusFilter,
} from '../../lib/automations';
import { AutomationTable, DayStrip } from './AutomationTable';
import { AutomationDetail } from './AutomationDetail';
import { AutomationsCalendar } from './AutomationsCalendar';
import { AreaSections, OwnSection, type SectionTableProps } from './AutomationsAreas';
import { SourcesFooter, Verdict } from './AutomationsHead';
import { DecideList } from './DecideList';
import { useAutomationsKeys } from './useAutomationsKeys';
import { useAutomationsData, type AutomationsData } from './useAutomationsData';
import { BUTTON, SECTION, SECTION_COUNT, SECTION_REST, SYSTEM_ICON, makeClock, scheduleWords, type Clock } from './automationsUi';

// The view's strings travel with its chunk, before its first render.
addCatalogue('it', AUTOMATIONS_IT);
addCatalogue('en', AUTOMATIONS_EN);

/** Rows of a system shown before the "N more, all fine" fold. */
const ROWS_SHOWN = 5;
/** Below this width the detail is a sheet from the bottom instead of a side panel. */
const SIDE_PANEL_MIN = 860;

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => startVisibleInterval(() => setNow(Date.now()), 30_000), []);
  return now;
}

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function AutomationsPane() {
  const present = useHubEverRead();
  if (!present) return null;
  return <AutomationsView />;
}

function AutomationsView() {
  const tr = useT();
  const locale = useLocale();
  const now = useNow();
  // eslint-disable-next-line react-hooks/purity -- the clock is a reader called when a schedule is described, not a value read during render
  const clock = useMemo(() => makeClock(locale, () => Date.now()), [locale]);
  const describe = useCallback((j: CronJob) => scheduleWords(scheduleParts(j), clock, tr), [clock, tr]);
  const data = useAutomationsData(describe);
  const confirm = useConfirm();
  const [ref, width] = useWidth();
  const [tab, setTab] = useState<'list' | 'calendar'>('list');
  const [system, setSystem] = useState<AutomationSystem | null>(null);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [grouping, setGrouping] = useState<'system' | 'area'>('system');
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [flowOpen, setFlowOpen] = useState<ReadonlySet<string>>(new Set());
  const onFlow = useCallback((key: string) => setFlowOpen((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; }), []);
  // A link of the hub (`#automations/<key>`) opens the view on that automation.
  const [selectedKey, setSelectedKey] = useState<string | null>(() => takeAutomationTarget());
  useEffect(() => {
    const onTarget = () => {
      const key = takeAutomationTarget();
      if (!key) return;
      setTab('list');
      setSystem(null);
      setStatus('all');
      setQuery('');
      setSelectedKey(key);
    };
    window.addEventListener(AUTOMATION_TARGET_EVENT, onTarget);
    return () => window.removeEventListener(AUTOMATION_TARGET_EVENT, onTarget);
  }, []);
  const close = useCallback(() => {
    const key = selectedKey;
    setSelectedKey(null);
    // The focus goes back to the row the detail was opened from, as on the hub.
    if (key) requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[data-testid="automation-row"][data-key="${CSS.escape(key)}"]`)?.focus());
  }, [selectedKey, ref]);
  useAutomationsKeys(ref, { open: selectedKey !== null, close, search: searchRef, clearSearch: () => setQuery('') });
  const [expanded, setExpanded] = useState<ReadonlySet<AutomationSystem>>(new Set());
  const [opened, setOpened] = useState<ReadonlySet<AutomationSystem>>(new Set());

  const onCommand = useCallback(async (row: AutomationRow, c: JobCommand) => {
    if (c.kind === 'remove' && !(await confirm({ title: tr('auto.confirm.remove', { title: row.title }), body: tr('auto.confirm.removeBody'), confirmLabel: tr('auto.cmd.remove') }))) return;
    const ok = await data.command(row, c);
    if (ok && c.kind === 'remove' && selectedKey === row.key) setSelectedKey(null);
  }, [confirm, data, selectedKey, tr]);

  const rows = data.rows;
  const own = data.model?.own ?? [];
  const pick = useCallback((r: AutomationRow) => matchesQuery(r, query, tr(`auto.system.${r.system}`)), [query, tr]);
  const visible = useMemo(() => rows.filter((r) => (system === null || r.system === system) && matchesStatus(r, status) && pick(r)), [rows, system, status, pick]);
  // The computer's own apps are never problems: the «problems» filter leaves them out, as on the hub.
  const ownVisible = status === 'problems' || system !== null ? [] : own.filter(pick);
  const verdict = verdictOf(rows, now);
  const counts = systemCounts(rows);
  const decide = toDecide(visible);
  const selected = selectedKey ? rows.find((r) => r.key === selectedKey) ?? own.find((r) => r.key === selectedKey) ?? null : null;
  const side = width >= SIDE_PANEL_MIN;
  const table: SectionTableProps = {
    now, clock, selectedKey, gatewayDown: data.gatewayDown, ranAt: data.ranAt, brakes: data.model?.brakes ?? {}, flowOpen, onFlow,
    onSelect: (r) => setSelectedKey(r.key), onCommand: (r, c) => { void onCommand(r, c); },
  };

  const detail = selected && (
    <AutomationDetail
      row={selected}
      now={now}
      clock={clock}
      hubDown={data.hubDown}
      gatewayDown={data.gatewayDown}
      fixing={data.fixing.has(selected.key)}
      brake={data.model?.brakes[selected.key]?.text ?? null}
      onClose={close}
      onCommand={(c) => { void onCommand(selected, c); }}
      feedback={data.feedback}
      undo={data.undo}
      fix={data.fix}
    />
  );

  return (
    <div ref={ref} className="@container relative flex h-full min-h-0 bg-app-bg" data-testid="automations-pane">
      <section className="min-w-0 flex-1 overflow-auto px-5 pb-6 pt-4 @max-2xl:px-3 @max-2xl:pb-8 @max-2xl:pt-3">
        <Verdict data={data} verdict={verdict} clock={clock} />
        {data.hubDown && <HubDownBand data={data} clock={clock} />}
        {data.refusal && (
          <div role="alert" data-testid="automations-refusal" className={`mt-2.5 flex items-center gap-2 rounded border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-compact ${DANGER_TEXT}`}>
            <span className="min-w-0 flex-1">
              {tr(`auto.refusal.${data.refusal.why}`, { what: tr(`auto.what.${data.refusal.what}`) })}
            </span>
            <button type="button" aria-label={tr('auto.close')} onClick={data.clearRefusal} className="inline-flex h-6 w-6 flex-none items-center justify-center rounded-xs hover:bg-red-500/10"><X size={13} /></button>
          </div>
        )}

        <div className="mt-3.5 flex items-end gap-2 @max-2xl:block">
          <div role="tablist" className="inline-flex gap-0.5 rounded border border-app-border-subtle bg-app-inset p-0.5 @max-2xl:flex @max-2xl:w-full">
            {(['list', 'calendar'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                data-testid={`automations-tab-${t}`}
                onClick={() => setTab(t)}
                className={`inline-flex h-[26px] items-center gap-1.5 rounded-sm px-3 text-compact @max-2xl:h-9 @max-2xl:flex-1 @max-2xl:justify-center ${tab === t ? 'bg-elevated text-app-text shadow-[0_0_0_1px_var(--border)]' : 'text-app-text-secondary hover:text-app-text'}`}
              >
                {t === 'list' ? <Workflow size={13} aria-hidden="true" /> : <AlarmClock size={13} aria-hidden="true" />}
                {tr(t === 'list' ? 'auto.tab.list' : 'auto.tab.calendar')}
                <span className="text-mini tabular-nums text-app-text-muted">{t === 'list' ? rows.length : data.calendar?.filter((c) => c.next === null || c.next >= now).length ?? ''}</span>
              </button>
            ))}
          </div>
          {tab === 'list' && (
            <label className="ml-auto inline-flex h-[26px] w-[240px] items-center gap-1.5 rounded-sm border border-app-border-input bg-app-input px-2 text-app-text-muted @max-2xl:mt-2 @max-2xl:flex @max-2xl:h-9 @max-2xl:w-full">
              <Search size={13} aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                aria-keyshortcuts="/"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={tr('auto.search')}
                aria-label={tr('auto.search')}
                data-testid="automations-search"
                className="min-w-0 flex-1 bg-transparent text-mini text-app-text outline-none placeholder:text-app-text-muted @max-2xl:text-compact"
              />
              <kbd aria-hidden="true" className="rounded-xs border border-app-border-subtle px-1 text-mini text-app-text-faint @max-2xl:hidden">/</kbd>
            </label>
          )}
        </div>

        {tab === 'calendar' ? (
          <AutomationsCalendar items={data.calendar ?? []} now={now} clock={clock} />
        ) : (
          <>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <StatusChips rows={rows} status={status} onPick={setStatus} />
              <span className="mx-1 h-4 w-px bg-app-border @max-2xl:hidden" aria-hidden="true" />
              <GroupingChips grouping={grouping} onPick={setGrouping} />
            </div>
            {grouping === 'system' && <SystemChips counts={counts} total={rows.length} system={system} onPick={setSystem} />}
            {data.model === null && !data.hubDown && <p className="mt-4 text-compact text-app-text-secondary">{tr('auto.reading')}</p>}
            {data.model !== null && visible.length === 0 && ownVisible.length === 0 && (
              <p className="mt-4 text-compact text-app-text-secondary" data-testid="automations-empty">
                {query.trim() ? tr('auto.emptyQuery', { q: query.trim() }) : tr('auto.empty')}
              </p>
            )}
            {status !== 'ok' && (
              <DecideList
                rows={decide}
                gates={gatesWaiting(visible)}
                selectedKey={selectedKey}
                data={data}
                onSelect={(r) => setSelectedKey(r.key)}
                onRun={(r) => { void onCommand(r, { kind: 'run' }); }}
              />
            )}
            {grouping === 'area' ? <AreaSections rows={visible} table={table} /> : (
              <Systems
                rows={visible}
                system={system}
                searching={query.trim() !== '' || status !== 'all'}
                now={now}
                clock={clock}
                table={table}
                gatewayDown={data.gatewayDown}
                expanded={expanded}
                opened={opened}
                onExpand={(s, on) => setExpanded((prev) => { const n = new Set(prev); if (on) n.add(s); else n.delete(s); return n; })}
                onOpen={(s) => setOpened((prev) => new Set(prev).add(s))}
              />
            )}
            <OwnSection rows={ownVisible} table={table} />
            <SourcesFooter data={data} clock={clock} />
          </>
        )}
      </section>
      {detail && side && (
        <aside className="w-[360px] flex-none overflow-auto border-l border-app-border-subtle bg-surface" data-testid="automation-side">{detail}</aside>
      )}
      {detail && !side && (
        <div className="absolute inset-0 z-20 flex flex-col justify-end bg-black/40" data-testid="automation-sheet" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
          <div className="max-h-[85%] overflow-auto rounded-t-xl border-t border-app-border bg-surface pb-[env(safe-area-inset-bottom)]">
            <div className="mx-auto mb-1 mt-2 h-1 w-9 rounded-full bg-app-border" aria-hidden="true" />
            {detail}
          </div>
        </div>
      )}
    </div>
  );
}

function HubDownBand({ data, clock }: { data: AutomationsData; clock: Clock }) {
  const tr = useT();
  const [busy, setBusy] = useState(false);
  return (
    <div role="status" data-testid="automations-hub-down" className="mt-2.5 flex min-h-7 items-center gap-1.5 rounded bg-app-hover py-1 pl-2.5 pr-1 text-compact text-app-text-secondary">
      <CloudOff size={14} className="flex-none" aria-hidden="true" />
      <span className="min-w-0 flex-1 tabular-nums">{data.readAt === null ? tr('auto.hubDownNever') : tr('auto.hubDown', { time: clock.time(data.readAt) })}</span>
      <button type="button" disabled={busy} className={BUTTON} onClick={() => { setBusy(true); void data.retry().finally(() => setBusy(false)); }}>{tr('auto.retry')}</button>
    </div>
  );
}

const CHIP = (on: boolean) => `inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-sm border px-2.5 text-mini @max-2xl:h-8 ${on ? 'border-transparent bg-primary/10 text-primary' : 'border-app-border text-app-text-secondary hover:bg-app-hover'}`;

/** All / in order / problems, with their counts, as the hub's filter. */
function StatusChips({ rows, status, onPick }: { rows: AutomationRow[]; status: StatusFilter; onPick(s: StatusFilter): void }) {
  const tr = useT();
  const problems = rows.filter(isProblem).length;
  const items: Array<{ s: StatusFilter; n: number; icon: typeof Workflow }> = [
    { s: 'all', n: rows.length, icon: LayoutGrid },
    { s: 'ok', n: rows.length - problems, icon: CircleCheck },
    { s: 'problems', n: problems, icon: TriangleAlert },
  ];
  return (
    <div role="group" aria-label={tr('auto.filter.label')} className="flex flex-wrap gap-1.5" data-testid="automations-status">
      {items.map(({ s, n, icon: I }) => (
        <button key={s} type="button" aria-pressed={status === s} className={CHIP(status === s)} onClick={() => onPick(s)} data-testid={`automations-status-${s}`}>
          <I size={13} aria-hidden="true" />{tr(`auto.filter.${s}`)}
          <span className={`tabular-nums ${status === s ? 'text-primary' : s === 'problems' && n > 0 ? WARNING_TEXT : 'text-app-text-muted'}`}>{n}</span>
        </button>
      ))}
    </div>
  );
}

/** By system (the engine that runs it) or by what it does for you (the hub's areas). */
function GroupingChips({ grouping, onPick }: { grouping: 'system' | 'area'; onPick(g: 'system' | 'area'): void }) {
  const tr = useT();
  return (
    <div role="group" aria-label={tr('auto.group.label')} className="flex gap-1.5" data-testid="automations-grouping">
      {(['system', 'area'] as const).map((g) => (
        <button key={g} type="button" aria-pressed={grouping === g} className={CHIP(grouping === g)} onClick={() => onPick(g)} data-testid={`automations-group-${g}`}>
          {tr(`auto.group.${g}`)}
        </button>
      ))}
    </div>
  );
}

function SystemChips({ counts, total, system, onPick }: { counts: ReturnType<typeof systemCounts>; total: number; system: AutomationSystem | null; onPick(s: AutomationSystem | null): void }) {
  const tr = useT();
  const chip = CHIP;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5" data-testid="automations-chips">
      <button type="button" aria-pressed={system === null} className={chip(system === null)} onClick={() => onPick(null)} data-testid="automations-chip-all">
        {tr('auto.chip.all')}<span className={`tabular-nums ${system === null ? 'text-primary' : 'text-app-text-muted'}`}>{total}</span>
      </button>
      {counts.map((c) => {
        const I = SYSTEM_ICON[c.system];
        const on = system === c.system;
        return (
          <button key={c.system} type="button" aria-pressed={on} className={chip(on)} onClick={() => onPick(on ? null : c.system)} data-testid={`automations-chip-${c.system}`}>
            <I size={13} aria-hidden="true" />{tr(`auto.system.${c.system}`)}
            <span className={`tabular-nums ${on ? 'text-primary' : 'text-app-text-muted'}`}>{c.total}</span>
            {c.toFix > 0 && <span className={`tabular-nums ${WARNING_TEXT}`} title={tr('auto.chip.toFix', { n: c.toFix })}>{c.toFix}</span>}
          </button>
        );
      })}
    </div>
  );
}

interface SystemsProps {
  rows: AutomationRow[];
  system: AutomationSystem | null;
  searching: boolean;
  now: number;
  clock: Clock;
  table: SectionTableProps;
  gatewayDown: boolean;
  expanded: ReadonlySet<AutomationSystem>;
  opened: ReadonlySet<AutomationSystem>;
  onExpand(s: AutomationSystem, on: boolean): void;
  onOpen(s: AutomationSystem): void;
}

function Systems({ rows, system, searching, now, clock, table, gatewayDown, expanded, opened, onExpand, onOpen }: SystemsProps) {
  const tr = useT();
  const open: AutomationSystem[] = [];
  const closed: AutomationSystem[] = [];
  for (const s of AUTOMATION_SYSTEMS) {
    const mine = rows.filter((r) => r.system === s);
    if (mine.length === 0) continue;
    // Jarvis stays open: its rows carry the commands the Cron panel had.
    const showAll = s === 'jarvis' || system !== null || searching || mine.some((r) => r.level !== 'va') || opened.has(s);
    (showAll ? open : closed).push(s);
  }
  return (
    <>
      {open.map((s) => {
        const list = systemRows(rows, s);
        const I = SYSTEM_ICON[s];
        const all = system !== null || searching || expanded.has(s);
        return (
          <div key={s} data-testid="automations-system" data-system={s}>
            <h2 className={SECTION}>
              <I size={13} aria-hidden="true" />{tr(`auto.system.${s}`)}
              <span className={SECTION_COUNT}>{list.length}</span>
              <span className={SECTION_REST}>{tr(`auto.systemNote.${s}`)}</span>
            </h2>
            {s === 'jarvis' && gatewayDown && (
              <p className="m-0 mb-1.5 text-mini text-app-text-secondary" data-testid="automations-gateway-down">{tr('auto.gatewayOff')}</p>
            )}
            <AutomationTable
              {...table}
              rows={list}
              limit={all ? null : ROWS_SHOWN}
              onMore={system === null && !searching ? () => onExpand(s, true) : undefined}
              onLess={system === null && !searching && expanded.has(s) && list.length > ROWS_SHOWN ? () => onExpand(s, false) : undefined}
            />
          </div>
        );
      })}
      {closed.length > 0 && (
        <>
          <h2 className={SECTION}>
            <span>{tr('auto.areas.title')}</span>
            <span className={SECTION_REST}>{tr('auto.areas.note')}</span>
          </h2>
          <div className="flex flex-col gap-1.5" data-testid="automations-areas">
            {closed.map((s) => {
              const list = rows.filter((r) => r.system === s);
              const I = SYSTEM_ICON[s];
              const lastAt = Math.max(0, ...list.map((r) => r.last.at ?? 0));
              const merged: AutomationRow = { ...list[0]!, day: list.flatMap((r) => r.day) };
              return (
                <button key={s} type="button" onClick={() => onOpen(s)} data-testid="automations-area" data-system={s} className="flex h-9 items-center gap-2 rounded border border-app-border bg-surface px-3 text-left text-compact text-app-text hover:bg-app-hover @max-2xl:h-11">
                  <I size={13} className="flex-none text-app-text-tertiary" aria-hidden="true" />
                  <span className="flex-none">{tr(`auto.system.${s}`)}</span>
                  <span className="min-w-0 truncate text-mini tabular-nums text-app-text-muted">
                    {tr('auto.areas.count', { n: list.length })}{lastAt > 0 ? ` · ${tr('auto.areas.last', { time: clock.dayTime(lastAt) })}` : ''}
                  </span>
                  <span className="ml-auto flex flex-none items-center gap-2 text-app-text-muted">
                    <DayStrip row={merged} now={now} className="w-24 @max-2xl:hidden" />
                    <ChevronRight size={14} aria-hidden="true" />
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
