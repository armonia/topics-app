/**
 * The bell's rows that come from the hub (HUBBR-06, HUBBR-07): a «waiting for
 * you» item with «Open» and «Done», a failed automation with «Fix it», a
 * service with a problem, a quota nearly full, an alert, an account event, a
 * contradiction of the agents' rules; and, in History, a line of the diary.
 *
 * Same geometry as the rows of Topics (`InboxPanel.tsx`): 56px tall, icon,
 * title and time on the first line, the detail on the second, so the two
 * kinds read as one list. The texts are the hub's own sentences; the names of
 * files and the hub's ids never reach the screen.
 */
import { useState, type ReactNode } from 'react';
import {
  ArrowLeftRight, Bot, Check, CircleX, CreditCard, Eye, Gauge, KeyRound, Layers, Megaphone, PieChart, Scale, ServerCrash,
  User, Workflow, Wrench, type LucideIcon,
} from 'lucide-react';
import { RelativeTime } from '../Shared/RelativeTime';
import { useT } from '../../hooks/useT';
import { useMobile } from '../../hooks/useMobile';
import { useBellActions } from '../../hooks/useBellHub';
import type { BellEntry } from '../../lib/bellGroups';
import type { DiaryEntry, WaitingKind } from '../../lib/hubSystem';
import { WARNING_TEXT, DANGER_TEXT } from '../../lib/popoverStyles';
import { useSharedNow } from '../../state/useSharedNow';

type HubEntry = Exclude<BellEntry, { source: 'topics' }>;

const WAITING_ICON: Record<WaitingKind, LucideIcon> = { decisione: Scale, spesa: CreditCard, pubblico: Megaphone, vista: Eye }; // allow-italian: the hub's wire values

const PRIMARY_BUTTON = 'flex items-center gap-1 px-2.5 rounded text-mini font-medium bg-primary text-white hover:bg-primary-hover transition-colors';
const SECONDARY_BUTTON = 'flex items-center gap-1 px-2.5 rounded text-mini font-medium border border-black/15 dark:border-white/20 text-app-text hover:bg-app-hover transition-colors';

const providerName = (p: string) => p.charAt(0).toUpperCase() + p.slice(1);

/** «by today 18:00», «by tomorrow 09:00», «by 12 Nov»; «overdue» past it. */
function dueLabel(due: number, now: number, tr: ReturnType<typeof useT>): string {
  if (due < now) return tr('bell.overdue');
  const d = new Date(due);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const day = (t: number) => new Date(t).toDateString();
  if (day(due) === day(now)) return tr('bell.due.today', { time });
  if (day(due) === day(now + 86_400_000)) return tr('bell.due.tomorrow', { time });
  return tr('bell.due.date', { date: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) });
}

function RowShell({ icon: Icon, tint, first, title, second, at, actions, aside, source }: {
  icon: LucideIcon;
  tint: string;
  first: boolean;
  title: ReactNode;
  second: ReactNode;
  at: number | null;
  /** Buttons: beside the text on a wide screen, under it on a phone. */
  actions?: ReactNode;
  /** A reading that stays beside the text everywhere (the quota bar). */
  aside?: ReactNode;
  source: HubEntry['source'];
}) {
  const { isMobile, isTouch } = useMobile();
  const right = aside ?? (isMobile ? null : actions);
  return (
    <li className="relative" data-testid="bell-row" data-source={source}>
      <div className="flex items-center">
        <div
          data-inbox-row=""
          tabIndex={first ? 0 : -1}
          className="flex-1 min-w-0 min-h-14 flex items-center gap-2.5 pl-3 pr-2 py-2 outline-none focus-visible:bg-app-hover"
        >
          <Icon size={15} className={`flex-shrink-0 ${tint}`} aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2">
              <span className="text-compact font-medium text-app-text truncate min-w-0">{title}</span>
              {at !== null && !right && <RelativeTime at={at} className="text-mini text-app-text-muted tabular-nums flex-shrink-0 ml-auto" />}
            </span>
            <span className="flex items-center gap-1.5 text-mini text-app-text-secondary min-w-0">{second}</span>
          </span>
          {/* The room of the «Mark seen» button of a Topics row, so every time
              of the panel stands in one column. */}
          {!right && <span aria-hidden="true" className={`flex-shrink-0 ${isTouch ? 'w-10' : 'w-6'}`} />}
        </div>
        {right && <div className="flex items-center gap-1.5 pr-3 flex-shrink-0">{right}</div>}
      </div>
      {isMobile && actions && !aside && <div className="flex items-center gap-2 pl-10 pr-3 pb-2.5">{actions}</div>}
    </li>
  );
}

const joined = (parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(' · ');

export function HubRow({ entry, first }: { entry: HubEntry; first: boolean }) {
  const tr = useT();
  const { isTouch } = useMobile();
  const now = useSharedNow();
  const { closeWaiting, fix } = useBellActions();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const h = isTouch ? 'h-11' : 'h-7';
  const run = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setFailure(null);
    const reason = await action();
    setBusy(false);
    if (reason === null) setDone(true);
    else setFailure(reason);
  };
  const error = failure && <span className={`truncate ${DANGER_TEXT}`} data-testid="bell-row-error">{failure}</span>;

  switch (entry.source) {
    case 'waiting': {
      const item = entry.item;
      if (done) return null;
      return (
        <RowShell
          source={entry.source}
          icon={WAITING_ICON[item.kind]}
          tint={WARNING_TEXT}
          first={first}
          title={item.title}
          at={item.since}
          second={error || (
            <>
              {item.due !== null && (
                <span className={`flex items-center gap-1 flex-shrink-0 ${WARNING_TEXT}`} data-testid="bell-due">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500" aria-hidden="true" />
                  {dueLabel(item.due, now, tr)}
                </span>
              )}
              <span className={`flex-shrink-0 px-1 rounded-xs bg-amber-500/15 ${WARNING_TEXT}`}>{tr(`bell.kind.${item.kind}`)}</span>
              <span className="truncate">{joined([item.why, item.from])}</span>
            </>
          )}
          actions={(
            <>
              {item.link && (
                <a href={item.link} target="_blank" rel="noopener noreferrer" className={`${PRIMARY_BUTTON} ${h}`} data-testid="bell-open">{tr('bell.open')}</a>
              )}
              <button type="button" disabled={busy} onClick={() => void run(() => closeWaiting(item.id))} className={`${SECONDARY_BUTTON} ${h}`} data-testid="bell-done">
                <Check size={12} aria-hidden="true" />
                {tr('bell.done')}
              </button>
            </>
          )}
        />
      );
    }
    case 'failed': {
      const job = entry.job;
      return (
        <RowShell
          source={entry.source}
          icon={Workflow}
          tint={DANGER_TEXT}
          first={first}
          title={job.title}
          at={job.at}
          second={error || <span className="truncate">{job.reason ?? tr('bell.failed')}</span>}
          actions={done
            ? <span className="text-mini text-app-text-secondary" data-testid="bell-fix-queued">{tr('bell.fixQueued')}</span>
            : (
              <button type="button" disabled={busy} onClick={() => void run(() => fix(job.key))} className={`${PRIMARY_BUTTON} ${h}`} data-testid="bell-fix">
                <Wrench size={12} aria-hidden="true" />
                {tr('bell.fix')}
              </button>
            )}
        />
      );
    }
    case 'service':
      return (
        <RowShell source={entry.source} icon={ServerCrash} tint={DANGER_TEXT} first={first} title={entry.service.name} at={null}
          second={<span className="truncate">{entry.service.problem ?? tr('bell.service.stopped')}</span>} />
      );
    case 'quota': {
      const q = entry.quota;
      const fiveHourFull = (q.fiveHour ?? 0) > q.used;
      const pct = fiveHourFull ? q.fiveHour ?? q.used : q.used;
      return (
        <RowShell
          source={entry.source}
          icon={Gauge}
          tint={WARNING_TEXT}
          first={first}
          title={tr(fiveHourFull ? 'bell.quota.fiveHour' : 'bell.quota.week', { provider: providerName(q.provider) })}
          at={null}
          second={<span className="truncate">{tr(fiveHourFull ? 'bell.quota.fiveHourHint' : 'bell.quota.weekHint')}</span>}
          aside={(
            <span className="flex flex-col items-end gap-1 w-16" data-testid="bell-quota" data-pct={pct}>
              <span className={`text-mini font-semibold tabular-nums ${WARNING_TEXT}`}>{pct}%</span>
              <span className="w-full h-1 rounded-full bg-app-border overflow-hidden" aria-hidden="true">
                <span className="block h-full bg-amber-500" style={{ width: `${Math.min(100, pct)}%` }} />
              </span>
            </span>
          )}
        />
      );
    }
    case 'alert':
      return (
        <RowShell source={entry.source} icon={entry.alert.source === 'soglia-progetto' ? PieChart : Gauge} tint="text-app-text-tertiary" first={first} // allow-italian: the hub's wire value
          title={entry.alert.subject || entry.alert.message} at={null} second={<span className="truncate">{entry.alert.message}</span>} />
      );
    case 'account': {
      const e = entry.event;
      const icon = e.kind === 'switched' ? ArrowLeftRight : e.kind === 'token' ? KeyRound : Gauge;
      const title = e.kind === 'switched'
        ? (e.account ? tr('bell.account.switched', { from: e.account, to: e.to ?? '?' }) : tr('bell.account.switchedTo', { to: e.to ?? '?' }))
        : tr(e.kind === 'token' ? 'bell.account.token' : 'bell.account.limit', { account: e.account ?? tr('bell.account.all') });
      return (
        <RowShell source={entry.source} icon={icon} tint="text-app-text-tertiary" first={first} title={title} at={e.at}
          second={<span className="truncate">{e.count > 1 ? tr('bell.account.times', { n: e.count }) : tr('bell.account.once')}</span>} />
      );
    }
    case 'contradiction':
      return (
        <RowShell source={entry.source} icon={Layers} tint="text-app-text-tertiary" first={first} title={tr('bell.contradiction')} at={null}
          second={<span className="truncate">{entry.item.why}</span>} />
      );
  }
}

const DIARY_ICON: Record<DiaryEntry['kind'], LucideIcon> = { auto: Workflow, app: Workflow, workflow: Workflow, agente: Bot, tu: User }; // allow-italian: the hub's wire values

/** A line of the hub's diary in History: read only, the same box as a row of the log. */
export function DiaryRow({ entry }: { entry: DiaryEntry }) {
  const failed = entry.outcome === 'error' || entry.outcome === 'undelivered';
  const Icon = failed ? CircleX : DIARY_ICON[entry.kind];
  return (
    <li>
      <div
        data-inbox-row=""
        tabIndex={-1}
        className="w-full flex items-start gap-2.5 px-3 py-2 min-h-11 text-left outline-none focus-visible:bg-app-hover"
        data-testid="bell-diary-row"
        data-kind={entry.kind}
        data-outcome={entry.outcome ?? undefined}
      >
        <Icon size={13} className={`mt-0.5 flex-shrink-0 ${failed ? DANGER_TEXT : 'text-app-text-tertiary'}`} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="text-compact font-medium text-app-text truncate">{entry.title}</span>
            <RelativeTime at={entry.at} className="text-mini text-app-text-muted tabular-nums flex-shrink-0 ml-auto" />
          </span>
          <span className="block text-mini text-app-text-secondary truncate">{joined([entry.what, entry.who])}</span>
        </span>
      </div>
    </li>
  );
}
