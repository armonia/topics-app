/**
 * The bell's rows that come from the hub (HUBBR-06, HUBBR-07): a «waiting for
 * you» item with «Open» and «Done», a failed automation with «Fix it», a
 * service with a problem, a quota nearly full, an alert, an account event, a
 * contradiction of the agents' rules; and, in History, a line of the diary.
 *
 * One geometry for every row that asks something, of Topics or of the hub
 * (`RowShell`, the mockup's): 40px with a mouse, icon, title, and a second
 * line that ends with the time («· 4 min»), the buttons on the right; with a
 * finger the text wraps and the buttons go under it. The texts are the hub's own sentences; the names of
 * files and the hub's ids never reach the screen.
 */
import { useState, type ReactNode } from 'react';
import {
  ArrowLeftRight, Bot, Check, CircleX, CreditCard, Eye, Gauge, KeyRound, Layers, Megaphone, PieChart, Scale, ServerCrash,
  User, Workflow, Wrench, type LucideIcon,
} from 'lucide-react';
import { useLocale, useT } from '../../hooks/useT';
import { useMobile } from '../../hooks/useMobile';
import { useBellActions } from '../../hooks/useBellHub';
import { bellTimeLabel, type BellEntry } from '../../lib/bellGroups';
import type { DiaryEntry, WaitingKind } from '../../lib/hubSystem';
import { WARNING_TEXT, DANGER_TEXT } from '../../lib/popoverStyles';
import { useSharedNow } from '../../state/useSharedNow';

type HubEntry = Exclude<BellEntry, { source: 'topics' }>;

const WAITING_ICON: Record<WaitingKind, LucideIcon> = { decisione: Scale, spesa: CreditCard, pubblico: Megaphone, vista: Eye }; // allow-italian: the hub's wire values

const BUTTON = 'inline-flex items-center gap-[5px] font-medium whitespace-nowrap border transition-colors disabled:opacity-60';
const PRIMARY = `${BUTTON} bg-primary border-primary text-white hover:bg-primary-hover`;
const SECONDARY = `${BUTTON} border-black/15 dark:border-white/20 bg-app-surface text-app-text hover:bg-app-hover`;

/** The two looks of a row's button, sized for the pointer: 24 with a mouse, 36 with a finger (the mockup's). */
// eslint-disable-next-line react-refresh/only-export-components -- the rows of this file and the bell share the button sizes
export function useBellButton(): { primary: string; secondary: string } {
  const { isMobile } = useMobile();
  const size = isMobile ? 'h-9 px-3 rounded-md text-prose' : 'h-6 px-2 rounded-sm text-compact';
  return { primary: `${PRIMARY} ${size}`, secondary: `${SECONDARY} ${size}` };
}

/** «4 min», «21:26», «ieri»: the time of a row, kept fresh by the shared clock. */
export function BellTime({ at, className = '' }: { at: number; className?: string }) {
  const tr = useT();
  const locale = useLocale();
  const now = useSharedNow();
  return <span className={`tabular-nums flex-shrink-0 ${className}`} title={new Date(at).toLocaleString()} data-testid="bell-time">{bellTimeLabel(at, now, tr, locale)}</span>;
}

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

/**
 * One row of «Now» that asks something, as the mockup draws it: icon, title,
 * and a second line that ends with the time («· 4 min»); the buttons beside
 * the text with a mouse, under it with a finger. With `onOpen` the text is a
 * button that opens the subject, otherwise it only takes the focus.
 */
export function RowShell({ icon: Icon, tint, first, title, second, at, actions, aside, onOpen, attrs }: {
  icon: LucideIcon;
  tint: string;
  first: boolean;
  title: ReactNode;
  second: ReactNode;
  at: number | null;
  actions?: ReactNode;
  /** A reading that stays beside the text everywhere (the quota bar). */
  aside?: ReactNode;
  onOpen?: () => void;
  /** The `data-*` the specs read, on the row. */
  attrs: Record<string, string | undefined>;
}) {
  const { isMobile } = useMobile();
  const body = (
    <>
      <Icon size={isMobile ? 16 : 15} className={`flex-shrink-0 self-start ${isMobile ? 'mt-0.5' : 'mt-[3px]'} ${tint}`} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className={`block font-medium text-app-text ${isMobile ? 'text-body-lg leading-[19px]' : 'text-compact leading-4 truncate'}`}>{title}</span>
        <span className={`flex items-center gap-[5px] text-app-text-secondary min-w-0 ${isMobile ? 'text-prose leading-[18px] flex-wrap gap-y-0.5' : 'text-compact leading-4 whitespace-nowrap overflow-hidden'}`}>
          {second}
          {at !== null && <span className="flex-shrink-0 text-app-text-muted">·</span>}
          {at !== null && <BellTime at={at} className="text-app-text-muted" />}
        </span>
      </span>
    </>
  );
  // With a finger the text is a target of its own: 44 at least.
  const text = `flex-1 min-w-0 flex items-center gap-2.5 text-left outline-none${isMobile ? ' min-h-11' : ''}`;
  return (
    <li
      className={`flex gap-x-2.5 hover:bg-app-hover focus-within:bg-app-hover transition-colors ${isMobile ? 'flex-wrap items-start pl-3.5 pr-3 py-2' : 'items-center pl-3 pr-2.5 py-1 min-h-10'}`}
      {...attrs}
    >
      {onOpen
        ? <button type="button" data-inbox-row="" data-subject={attrs['data-subject']} tabIndex={first ? 0 : -1} onClick={onOpen} className={text}>{body}</button>
        : <div data-inbox-row="" tabIndex={first ? 0 : -1} className={text}>{body}</div>}
      {aside && <div className="flex-shrink-0 self-center">{aside}</div>}
      {actions && <div className={`flex items-center flex-shrink-0 ${isMobile ? 'basis-full pl-[26px] gap-1.5 mt-1' : 'gap-1'}`}>{actions}</div>}
    </li>
  );
}

const joined = (parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(' · ');

export function HubRow({ entry, first, onNavigate }: { entry: HubEntry; first: boolean; onNavigate?: () => void }) {
  const tr = useT();
  const now = useSharedNow();
  const button = useBellButton();
  const { closeWaiting, fix, renew } = useBellActions();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const attrs = { 'data-testid': 'bell-row', 'data-source': entry.source };
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
          attrs={attrs}
          icon={WAITING_ICON[item.kind]}
          tint={WARNING_TEXT}
          first={first}
          title={item.title}
          // A deadline says more than the age: the time shows only without one.
          at={item.due === null ? item.since : null}
          second={error || (
            <>
              {item.due !== null && (
                <span className={`flex items-center gap-1 flex-shrink-0 font-medium ${WARNING_TEXT}`} data-testid="bell-due">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500" aria-hidden="true" />
                  {dueLabel(item.due, now, tr)}
                </span>
              )}
              <span className={`flex-shrink-0 px-[5px] rounded-xs font-semibold text-mini leading-4 bg-amber-500/15 ${WARNING_TEXT}`}>{tr(`bell.kind.${item.kind}`)}</span>
              {item.why && <span className="truncate">{item.why}</span>}
            </>
          )}
          actions={(
            <>
              {item.link && (
                <a href={item.link} target="_blank" rel="noopener noreferrer" className={button.primary} data-testid="bell-open">{tr('bell.open')}</a>
              )}
              <button type="button" disabled={busy} onClick={() => void run(() => closeWaiting(item.id))} className={button.secondary} data-testid="bell-done">
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
          attrs={attrs}
          icon={Workflow}
          tint={DANGER_TEXT}
          first={first}
          title={job.title}
          at={job.at}
          second={error || <span className="truncate">{job.reason ?? tr('bell.failed')}</span>}
          actions={done
            ? <span className="text-compact text-app-text-secondary" data-testid="bell-fix-queued">{tr('bell.fixQueued')}</span>
            : (
              <button type="button" disabled={busy} onClick={() => void run(() => fix(job.key))} className={button.primary} data-testid="bell-fix">
                <Wrench size={12} aria-hidden="true" />
                {tr('bell.fix')}
              </button>
            )}
        />
      );
    }
    case 'service':
      // The service is read where the machine is: Processi lists it with its state and port.
      return (
        <RowShell attrs={attrs} icon={ServerCrash} tint={DANGER_TEXT} first={first} title={entry.service.name} at={null}
          second={<span className="truncate">{entry.service.problem ?? tr('bell.service.stopped')}</span>}
          actions={(
            <button
              type="button"
              onClick={() => {
                onNavigate?.();
                window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: 'processes' } }));
              }}
              className={button.secondary}
              data-testid="bell-open-processes"
            >
              {tr('bell.openProcesses')}
            </button>
          )} />
      );
    case 'quota': {
      const q = entry.quota;
      const fiveHourFull = (q.fiveHour ?? 0) > q.used;
      const pct = fiveHourFull ? q.fiveHour ?? q.used : q.used;
      return (
        <RowShell
          attrs={attrs}
          icon={Gauge}
          tint="text-app-text-tertiary"
          first={first}
          title={tr(fiveHourFull ? 'bell.quota.fiveHour' : 'bell.quota.week', { provider: providerName(q.provider) })}
          at={null}
          second={<span className="truncate">{tr(fiveHourFull ? 'bell.quota.fiveHourHint' : 'bell.quota.weekHint')}</span>}
          aside={(
            <span className="flex flex-col items-end gap-[3px] w-16" data-testid="bell-quota" data-pct={pct}>
              <span className={`text-compact font-semibold tabular-nums ${WARNING_TEXT}`}>{pct}%</span>
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
        <RowShell attrs={attrs} icon={entry.alert.source === 'soglia-progetto' ? PieChart : Gauge} tint="text-app-text-tertiary" first={first} // allow-italian: the hub's wire value
          title={entry.alert.subject || entry.alert.message} at={null} second={<span className="truncate">{entry.alert.message}</span>} />
      );
    case 'account': {
      const e = entry.event;
      const icon = e.kind === 'switched' ? ArrowLeftRight : e.kind === 'token' ? KeyRound : Gauge;
      const title = e.kind === 'switched'
        ? (e.account ? tr('bell.account.switched', { from: e.account, to: e.to ?? '?' }) : tr('bell.account.switchedTo', { to: e.to ?? '?' }))
        : tr(e.kind === 'token' ? 'bell.account.token' : 'bell.account.limit', { account: e.account ?? tr('bell.account.all') });
      // An expired token is renewed from the row, as the proxy's dashboard does.
      const profile = e.kind === 'token' ? e.profile : null;
      return (
        <RowShell attrs={attrs} icon={icon} tint="text-app-text-tertiary" first={first} title={title} at={e.at}
          second={error || <span className="truncate">{e.count > 1 ? tr('bell.account.times', { n: e.count }) : tr('bell.account.once')}</span>}
          actions={profile && (done
            ? <span className="text-compact text-app-text-secondary" data-testid="bell-renewed">{tr('bell.renewed')}</span>
            : (
              <button type="button" disabled={busy} onClick={() => void run(() => renew(profile))} className={button.secondary} data-testid="bell-renew">
                {tr('bell.renew')}
              </button>
            ))} />
      );
    }
    case 'contradiction':
      return (
        <RowShell attrs={attrs} icon={Layers} tint="text-app-text-tertiary" first={first} title={tr('bell.contradiction')} at={null}
          second={<span className="truncate">{entry.item.why}</span>} />
      );
  }
}

const DIARY_ICON: Record<DiaryEntry['kind'], LucideIcon> = { auto: Workflow, app: Workflow, workflow: Workflow, agente: Bot, tu: User }; // allow-italian: the hub's wire values

/** A line of the hub's diary in History: read only, the same row as the rest of the panel. */
export function DiaryRow({ entry }: { entry: DiaryEntry }) {
  const failed = entry.outcome === 'error' || entry.outcome === 'undelivered';
  return (
    <RowShell
      attrs={{ 'data-testid': 'bell-diary-row', 'data-kind': entry.kind, 'data-outcome': entry.outcome ?? undefined }}
      icon={failed ? CircleX : DIARY_ICON[entry.kind]}
      tint={failed ? DANGER_TEXT : 'text-app-text-tertiary'}
      first={false}
      title={entry.title}
      at={entry.at}
      second={<span className="truncate">{joined([entry.what, entry.who])}</span>}
    />
  );
}
