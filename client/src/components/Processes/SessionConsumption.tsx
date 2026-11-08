/**
 * THE SESSIONS AND WHAT EACH COSTS: one component for the three places that
 * show it (the load screen of the PC, the machine's Processes view, the card
 * drawer), fed by one answer (`lib/sessionConsumption.ts`), so the numbers are
 * the same everywhere.
 *
 * A row is a SESSION (a card, a chat, a terminal), not a process: title,
 * project, model, a clock that runs, then the four numbers that matter (tokens,
 * tokens per second, CPU, memory). The processes it launched are the detail
 * inside it. A process several sessions use is split between them and the
 * memory cell says how (`1/2 server`); the rule is printed once under the list.
 *
 * Read-only: nothing here takes input except the detail toggle of the panel.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronRight, CloudOff, Server, Zap } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { addCatalogue } from '../../lib/i18n';
import CONSUMPTION_IT from '../../lib/i18n-consumption-it';
import CONSUMPTION_EN from '../../lib/i18n-consumption-en';
import { apiFetch } from '../../lib/shell/net';
import { startVisibleInterval } from '../../state/documentVisibility';
import { WARNING_TEXT } from '../../lib/popoverStyles';
import { formatMem } from '../../lib/machineProcesses';
import { friendlyModelLabel } from '../../lib/modelLabel';
import { clockOf, formatTps, readConsumption, MAX_SESSIONS } from '../../lib/sessionConsumption';
import type { ConsumptionAnswer, ConsumptionShare, SessionConsumption } from '../../../../shared/session-consumption';
import { fmtTok } from '../Board/format';
import { StatusIcon } from '../Board/atoms';
import { FAINT, SECTION, SECTION_HEAD } from './processesStyles';

addCatalogue('it', CONSUMPTION_IT);
addCatalogue('en', CONSUMPTION_EN);

type Tr = ReturnType<typeof useT>;

export interface ConsumptionReads {
  answer: ConsumptionAnswer | null;
  /** When the last answer came, epoch ms. */
  at: number | null;
  /** The last read failed (a failed read keeps the last good answer). */
  failing: boolean;
}

/** One read every `pollMs` while the page is visible; a failed read keeps the last good answer and says so. */
export function useSessionConsumption(path: string, pollMs: number, enabled = true): ConsumptionReads {
  const [reads, setReads] = useState<ConsumptionReads>({ answer: null, at: null, failing: false });
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const read = async () => {
      let answer: ConsumptionAnswer | null = null;
      try {
        const r = await apiFetch(path);
        if (r.ok) answer = readConsumption(await r.json());
      } catch { /* the band says the read failed */ }
      if (!alive) return;
      setReads((prev) => ({ answer: answer ?? prev.answer, at: answer ? Date.now() : prev.at, failing: answer === null }));
    };
    void read();
    const stop = startVisibleInterval(() => { void read(); }, pollMs);
    return () => { alive = false; stop(); };
  }, [path, pollMs, enabled]);
  return reads;
}

/** The wall clock, once a second: what makes a session's elapsed time run. */
export function useSecondTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => startVisibleInterval(() => setNow(Date.now()), 1000), []);
  return now;
}

const pct1 = (v: number): string => `${(Math.round(v * 10) / 10).toString().replace('.', ',')}%`;

function shareText(s: ConsumptionShare, tr: Tr): string {
  return tr('consumption.shareLine', { what: tr(`consumption.root.${s.id}`), of: s.of, total: formatMem(s.totalMB) });
}

/** One of the four numbers: the label in capitals, the value, one line of note. */
function Metric({ label, value, note, title, testId, tone = '' }: { label: string; value: string; note?: ReactNode; title?: string; testId: string; tone?: string }) {
  return (
    <div className="min-w-0 px-2.5 pb-2 pt-1.5" title={title} data-testid={testId}>
      <div className={`text-mini uppercase tracking-[0.04em] ${FAINT}`}>{label}</div>
      <div className={`mt-0.5 whitespace-nowrap text-body-lg tabular-nums text-app-text ${tone}`} data-testid={`${testId}-value`}>{value}</div>
      <div className={`h-4 truncate text-mini tabular-nums ${FAINT}`}>{note}</div>
    </div>
  );
}

export type RowVariant = 'screen' | 'panel' | 'drawer';

/**
 * A session as one row. `screen` is the monitor's (the detail is one faint line,
 * nothing opens), `panel` is the Processes view's (the detail opens), `drawer`
 * is the card drawer's (the numbers only, the card's own title sits above it).
 */
export function SessionRowView({ session: s, now, variant, windowS, machineLabel }: {
  session: SessionConsumption; now: number; variant: RowVariant; windowS: number; machineLabel?: string | null;
}) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const sharedMB = s.memMB !== null && s.ownMB !== null ? s.memMB - s.ownMB : 0;
  const t = s.tokens;
  const tokensTitle = t
    ? (t.input === null ? tr('consumption.tokensTotalOnly') : tr('consumption.tokensTitle', { input: fmtTok(t.input), output: fmtTok(t.output ?? 0), cacheRead: fmtTok(t.cacheRead ?? 0), cacheWrite: fmtTok(t.cacheWrite ?? 0) }))
    : tr('consumption.tokensNone');
  const memNote = s.machine !== null
    ? tr('consumption.on', { name: s.machine })
    : sharedMB > 0
      ? [tr('consumption.memoryShared', { mb: formatMem(sharedMB) }), ...s.shares.map((x) => `1/${x.of} ${tr(`consumption.root.${x.id}`)}`)].join(' · ')
      : null;
  const memTitle = s.machine !== null ? tr('consumption.memoryRemote', { name: s.machine }) : s.shares.map((x) => shareText(x, tr)).join('\n') || undefined;
  const detail = [s.project, s.model ? friendlyModelLabel(s.model) : null, machineLabel ?? null].filter(Boolean);
  const procsLine = s.procs.slice(0, 3).map((p) => `${p.count > 1 ? tr('consumption.procsCount', { name: p.name, n: p.count }) : p.name} ${formatMem(p.memMB)}`).join(' · ');
  const elapsed = s.startedAt === null ? null : clockOf(now - s.startedAt);
  return (
    <div className="flex-none border-b border-app-border-subtle last:border-b-0" data-testid="session-row" data-kind={s.kind} data-state={s.state} data-session={s.key}>
      {variant !== 'drawer' && (
        <div className="flex min-w-0 items-center gap-2 px-2.5 pt-2">
          {s.kind === 'card' ? <StatusIcon status="in_progress" /> : <Zap size={14} className="flex-none text-app-text-secondary" aria-hidden="true" />}
          <span className="min-w-0 flex-1 truncate text-body-lg font-semibold text-app-text" data-testid="session-title">{s.title}</span>
          {s.awaiting && <span className="flex-none rounded bg-rose-500/15 px-1.5 py-0.5 text-mini font-medium text-rose-800 dark:text-rose-300" data-testid="session-awaiting">{tr('board.card.awaitingYou')}</span>}
          {elapsed !== null && <span className="flex-none text-title font-semibold tabular-nums text-app-text-heading" data-testid="session-clock" title={tr('consumption.time')}>{elapsed}</span>}
        </div>
      )}
      {variant !== 'drawer' && (
        <div className="flex min-w-0 items-center gap-1.5 pb-0.5 pl-[32px] pr-2.5 text-compact text-app-text-secondary">
          <span className="min-w-0 truncate" data-testid="session-detail">{detail.join(' · ')}</span>
          <span className="flex-1" />
          {s.from && <span className="flex flex-none items-center gap-1 whitespace-nowrap"><Server className="h-3 w-3 text-app-text-muted" aria-hidden="true" />{tr('consumption.from', { who: s.from })}</span>}
        </div>
      )}
      <div className="grid grid-cols-4">
        <Metric label={tr('consumption.tokens')} value={t ? fmtTok(t.total) : '-'} testId="session-tokens" title={tokensTitle}
          note={t && t.input !== null ? `↓${fmtTok(t.input)} ↑${fmtTok(t.output ?? 0)}` : t ? tr('consumption.tokensTotalOnly') : undefined} />
        <Metric label={tr('consumption.tps')} value={s.tps === null ? '-' : formatTps(s.tps)} testId="session-tps"
          title={s.tps === null ? tr('consumption.tpsNone') : tr('consumption.tpsTitle', { s: windowS })} note={s.tps === null ? undefined : `${windowS} s`} />
        <Metric label={tr('consumption.cpu')} value={s.cpuPct === null ? '-' : pct1(s.cpuPct)} testId="session-cpu" title={tr('consumption.cpuTitle')} note={s.cpuPct === null ? undefined : tr('consumption.cpuNote')} />
        <Metric label={tr('consumption.memory')} value={s.memMB === null ? '-' : formatMem(s.memMB)} testId="session-memory" title={memTitle} note={memNote} />
      </div>
      {s.remote.map((r, i) => (
        <div key={i} className={`flex min-w-0 items-center gap-2 px-2.5 pb-1.5 text-compact text-app-text-secondary`} data-testid="session-remote">
          <Server size={13} className={`flex-none ${FAINT}`} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{r.where ? tr('consumption.remoteOn', { name: r.where, what: r.what }) : tr('consumption.remote', { what: r.what })}{r.of > 1 ? ` · ${tr('consumption.remoteShare', { of: r.of })}` : ''}</span>
          {r.memMB !== null && <span className="flex-none tabular-nums">{formatMem(r.memMB)}</span>}
          {r.cpuPct !== null && <span className="flex-none tabular-nums" title={tr('consumption.cpuTitle')}>{pct1(r.cpuPct)}</span>}
        </div>
      ))}
      {variant === 'screen' && procsLine && (
        <div className={`truncate px-2.5 pb-1.5 text-compact tabular-nums ${FAINT}`} data-testid="session-procs">{procsLine}</div>
      )}
      {variant !== 'screen' && s.procs.length > 0 && (
        <div className="px-2.5 pb-1.5">
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className={`inline-flex items-center gap-1 text-mini ${FAINT} hover:text-app-text`} data-testid="session-procs-toggle">
            <ChevronRight size={12} className={open ? 'rotate-90' : ''} aria-hidden="true" />{tr('consumption.procs')} · {s.procs.length}
          </button>
          {open && (
            <ul className="m-0 mt-1 list-none p-0" data-testid="session-procs-list">
              {s.procs.map((p) => (
                <li key={p.name} className="flex items-center gap-2 py-0.5 text-compact tabular-nums text-app-text-secondary">
                  <span className="min-w-0 flex-1 truncate">{p.count > 1 ? tr('consumption.procsCount', { name: p.name, n: p.count }) : p.name}</span>
                  <span>{p.cpuPct === null ? '-' : pct1(p.cpuPct)}</span>
                  <span className="w-[72px] text-right">{formatMem(p.memMB)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Under the list: what is not a session's, and the split rule in words. */
export function ConsumptionNotes({ answer, compact = false }: { answer: ConsumptionAnswer; compact?: boolean }) {
  const tr = useT();
  const lines = [
    answer.idle.sessions > 0 ? tr('consumption.idle', { n: answer.idle.sessions, mem: formatMem(answer.idle.memMB) }) : null,
    answer.unattributed.processes > 0 ? tr('consumption.unattributed', { mem: formatMem(answer.unattributed.memMB) }) : null,
    answer.sessions.some((s) => s.shares.length > 0) ? tr('consumption.rule') : null,
  ].filter((l): l is string => l !== null);
  if (lines.length === 0) return null;
  return (
    <div className={`border-t border-app-border-subtle px-2.5 py-1.5 ${compact ? 'text-mini' : 'text-compact'} ${FAINT}`} data-testid="consumption-notes">
      {lines.map((l) => <div key={l} className="truncate">{l}</div>)}
    </div>
  );
}

/** The Processes view's section: every live session, newest numbers, read every few seconds. */
export function SessionsPanel() {
  const tr = useT();
  const { answer, failing } = useSessionConsumption('/api/usage/consumption', 4_000);
  const now = useSecondTick();
  const rows = useMemo(() => (answer?.sessions ?? []).slice(0, MAX_SESSIONS), [answer]);
  const hidden = (answer?.sessions.length ?? 0) - rows.length;
  return (
    <section aria-label={tr('consumption.title')} className={`${SECTION} mb-3.5`} data-testid="machine-processes-sessions">
      <div className={SECTION_HEAD}>
        <Zap size={14} className="flex-none text-app-text-secondary" aria-hidden="true" />
        <span className="text-compact font-semibold text-app-text-heading">{tr('consumption.title')}</span>
        {answer && answer.sessions.length > 0 && <span className={`min-w-0 flex-1 truncate text-mini tabular-nums ${FAINT}`}>{tr('consumption.live', { n: answer.sessions.length })}</span>}
      </div>
      {failing && (
        <div role="status" className={`flex items-center gap-2 border-b border-app-border-subtle px-2.5 py-1.5 text-compact ${WARNING_TEXT}`} data-testid="consumption-unread">
          <CloudOff size={14} className="flex-none" aria-hidden="true" />{tr('consumption.unread')}
        </div>
      )}
      {answer === null && !failing && <div className={`px-3 py-3 text-compact ${FAINT}`}>{tr('consumption.reading')}</div>}
      {answer !== null && rows.length === 0 && <div className={`px-3 py-3 text-compact ${FAINT}`} data-testid="consumption-none">{tr('consumption.none')}</div>}
      {rows.map((s) => <SessionRowView key={s.key} session={s} now={now} variant="panel" windowS={answer?.windowS ?? 30} />)}
      {hidden > 0 && <div className={`border-t border-app-border-subtle px-2.5 py-1.5 text-compact ${FAINT}`}>{tr('consumption.more', { n: hidden })}</div>}
      {answer && <ConsumptionNotes answer={answer} compact />}
    </section>
  );
}

/** The card drawer's block: the same row, numbers only, for the one session of this card. */
export function CardConsumption({ cardId }: { cardId: string }) {
  const tr = useT();
  const { answer } = useSessionConsumption('/api/usage/consumption', 5_000);
  const now = useSecondTick();
  const session = answer?.sessions.find((s) => s.cardId === cardId) ?? null;
  if (!session) return null;
  return (
    <div className={`${SECTION} mb-3`} data-testid="card-consumption">
      <div className={SECTION_HEAD}>
        <Zap size={14} className="flex-none text-app-text-secondary" aria-hidden="true" />
        <span className="text-compact font-semibold text-app-text-heading">{tr('consumption.drawer')}</span>
        {session.startedAt !== null && <span className="min-w-0 flex-1 text-right text-body-lg font-semibold tabular-nums text-app-text-heading" data-testid="session-clock">{clockOf(now - session.startedAt)}</span>}
      </div>
      <SessionRowView session={session} now={now} variant="drawer" windowS={answer?.windowS ?? 30} />
      {answer && <ConsumptionNotes answer={{ ...answer, sessions: [session], idle: { sessions: 0, memMB: 0 }, unattributed: { memMB: 0, cpuPct: null, processes: 0 } }} compact />}
    </div>
  );
}
