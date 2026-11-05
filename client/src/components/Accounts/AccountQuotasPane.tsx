/**
 * ACCOUNTS AND QUOTAS (hub-smistamento, HUBBR-10 and HUBBR-11).
 *
 * The plans in one place, opened from the row with your name: the Claude
 * accounts of the proxy with their bars and the proxy's commands (use this one,
 * priority, cap, renew the token, on and off, remove), Codex and Muse read-only
 * with the hub's «unlock the brake», the reserve Anthropic keys, the proxy's
 * rotation and caps, and how the brake decides. At the top the one command
 * that holds for everybody: stop the new background work for a few hours.
 *
 * The truth stays in the hub and in the proxy: every write goes there and the
 * view shows what it reads back, never what it hoped to write. With the hub
 * silent the bars keep their last reading under a band that says since when;
 * with the proxy silent the Claude half says so instead of an empty list.
 * Loaded as its own chunk, only where the hub is part of the installation.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDown, ArrowUp, ArrowLeftRight, CloudOff, CreditCard, Gauge, Hourglass, Image as ImageIcon, Info, KeyRound, Lock,
  LogIn, MoreHorizontal, Pause, Play, Power, RefreshCw, SlidersHorizontal, Unlock, Wallet,
} from 'lucide-react';
import { useLocale, useT } from '../../hooks/useT';
import { addCatalogue } from '../../lib/i18n';
import ACCOUNTS_IT from '../../lib/i18n-accounts-it';
import ACCOUNTS_EN from '../../lib/i18n-accounts-en';
import { useConfirm } from '../../hooks/useConfirm';
import { useHubEverRead, useHubLive, refreshHubLive } from '../../state/hubLive';
import { startVisibleInterval } from '../../state/documentVisibility';
import { apiFetch } from '../../lib/shell/net';
import { openHome } from '../../lib/openHome';
import { Menu } from '../Shared/Menu';
import { Select } from '../Shared/Select';
import { Switch } from '../Shared/Switch';
import { DANGER_TEXT, POPOVER_ITEM, POPOVER_ITEM_DANGER, WARNING_TEXT } from '../../lib/popoverStyles';
import { HOT_QUOTA_AT } from '../Sidebar/hotQuota';
import {
  HOLD_HOURS, HOLD_STEPS, PARALLEL_STEPS, ROTATION_INTERVALS, ROTATION_STRATEGIES, UNLOCK_HOURS,
  backgroundHold, brakeClasses, capInput, commandRequest, keyMove, meteredProviders, paceLines, readProxyAccounts, readProxySettings,
  type AccountCommand, type ApiKey, type ClaudeAccount, type MeteredProvider, type ProxySettings, type QuotaWindow,
} from '../../lib/accountQuotas';

// The view's strings travel with its chunk, before its first render.
addCatalogue('it', ACCOUNTS_IT);
addCatalogue('en', ACCOUNTS_EN);

type Tr = ReturnType<typeof useT>;
type Run = (c: AccountCommand) => Promise<boolean>;

/** The proxy recomputes its windows on every request; a read every 15 s is plenty for a view. */
const POLL_MS = 15_000;
const CAP_STEPS = [50, 60, 70, 75, 80, 85, 90, 95] as const;

const SECTION_TITLE = 'mb-1.5 mt-3.5 flex flex-wrap items-center gap-1.5 text-mini font-semibold text-app-text-secondary first:mt-0';
const LIST = 'overflow-hidden rounded border border-app-border bg-app-inset';
const LIST_ROW = 'flex min-h-[34px] items-center gap-2 border-t border-app-border-subtle px-2.5 py-[5px] text-compact text-app-text first:border-t-0 @max-2xl:min-h-[52px] @max-2xl:text-prose';
const BUTTON = 'inline-flex h-[26px] flex-none items-center gap-[5px] whitespace-nowrap rounded-sm border border-app-border-light bg-elevated px-[9px] text-compact text-app-text hover:bg-app-hover disabled:opacity-50 @max-2xl:h-9 @max-2xl:px-3 @max-2xl:text-prose';
const ICON_BUTTON = 'inline-flex h-[26px] w-[26px] flex-none items-center justify-center rounded-sm border border-app-border-light bg-elevated text-app-text-secondary hover:bg-app-hover hover:text-app-text disabled:opacity-50 @max-2xl:h-9 @max-2xl:w-9';
const CHIP = 'ml-auto inline-flex h-5 flex-none items-center gap-1 whitespace-nowrap rounded-xs px-1.5 text-mini font-semibold';
const CHIP_TONE = {
  use: 'bg-primary/10 text-blue-800 dark:text-primary',
  quiet: 'bg-app-hover text-app-text-secondary',
  warn: `bg-amber-500/15 ${WARNING_TEXT}`,
  bad: `bg-red-500/10 ${DANGER_TEXT}`,
} as const;

interface ProxyReads {
  profiles: unknown;
  settings: unknown;
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

async function fetchProxy(): Promise<{ profiles: unknown; settings: unknown }> {
  const [profiles, settings] = await Promise.all([readJson('/api/switchboard/profiles'), readJson('/api/switchboard/settings')]);
  return { profiles, settings };
}

/** The proxy's accounts and rules, again every POLL_MS while visible and after every write. */
function useProxyReads(enabled: boolean): { reads: ProxyReads | null; failing: boolean; reread: () => Promise<void> } {
  const [reads, setReads] = useState<ProxyReads | null>(null);
  const [failing, setFailing] = useState(false);
  const alive = useRef(true);
  const apply = useCallback(({ profiles, settings }: { profiles: unknown; settings: unknown }) => {
    if (!alive.current) return;
    const any = Boolean(profiles || settings);
    setFailing(!any);
    // A failed read keeps the last good one: the band says how old it is.
    if (any) setReads((prev) => ({ profiles: profiles ?? prev?.profiles, settings: settings ?? prev?.settings, at: Date.now() }));
  }, []);
  const reread = useCallback(() => fetchProxy().then(apply), [apply]);
  useEffect(() => {
    alive.current = true;
    if (!enabled) return () => { alive.current = false; };
    void fetchProxy().then(apply);
    // The hub's state is read again too: a window whose socket is reconnecting
    // (seen on WebKit) never gets the hub-down frame, the server's snapshot has it.
    const stop = startVisibleInterval(() => { void fetchProxy().then(apply); void refreshHubLive(); }, POLL_MS);
    return () => { alive.current = false; stop(); };
  }, [enabled, apply]);
  return { reads, failing, reread };
}

/**
 * The hub's pace and brake, kept at their last good reading: the live reader
 * drops the numbers when the hub stops answering, and this view keeps them
 * under the band that says how old they are.
 */
function useKeptHub(): { pace: unknown; gates: unknown; answering: boolean; seenAt: number | null } {
  const live = useHubLive();
  const pace = live.pace?.data;
  const gates = live.gates?.data;
  const answering = pace !== undefined || gates !== undefined;
  const at = Math.max(live.pace?.at ?? 0, live.gates?.at ?? 0);
  const [kept, setKept] = useState<{ pace: unknown; gates: unknown; at: number }>({ pace: undefined, gates: undefined, at: 0 });
  // Adjusted while rendering, the way React keeps state derived from a prop.
  if ((pace !== undefined && pace !== kept.pace) || (gates !== undefined && gates !== kept.gates)) {
    setKept({ pace: pace ?? kept.pace, gates: gates ?? kept.gates, at });
  }
  // An unchanged reading is not pushed again: while the hub answers, now is a time it was true.
  const [okAt, setOkAt] = useState(0);
  useEffect(() => (answering ? startVisibleInterval(() => setOkAt(Date.now()), POLL_MS) : undefined), [answering]);
  const seenAt = Math.max(kept.at, answering ? at : 0, okAt);
  return { pace: pace ?? kept.pace, gates: gates ?? kept.gates, answering, seenAt: seenAt > 0 ? seenAt : null };
}

function useClock(locale: string) {
  return useMemo(() => {
    const tag = locale === 'en' ? 'en-GB' : 'it-IT';
    const time = new Intl.DateTimeFormat(tag, { hour: 'numeric', minute: '2-digit' });
    const day = new Intl.DateTimeFormat(tag, { weekday: 'short' });
    return { time: (ms: number) => time.format(ms), dayTime: (ms: number) => `${day.format(ms).replace('.', '')} ${time.format(ms)}` };
  }, [locale]);
}

export function AccountQuotasPane() {
  const tr = useT();
  const locale = useLocale();
  const clock = useClock(locale);
  const present = useHubEverRead();
  const hub = useKeptHub();
  const { reads, failing, reread } = useProxyReads(present);
  const [failure, setFailure] = useState<string | null>(null);

  const proxy = useMemo(() => readProxyAccounts(reads?.profiles), [reads]);
  const settings = useMemo(() => readProxySettings(reads?.settings), [reads]);
  const metered = useMemo(() => meteredProviders(hub.pace, hub.gates), [hub.pace, hub.gates]);
  const hold = backgroundHold(hub.gates);

  // Every write goes to its service and the view then reads back what is true.
  const run = useCallback<Run>(async (c) => {
    const req = commandRequest(c);
    setFailure(null);
    try {
      const r = await apiFetch(req.path, {
        method: req.method,
        headers: req.body ? { 'content-type': 'application/json' } : undefined,
        body: req.body ? JSON.stringify(req.body) : undefined,
      });
      if (!r.ok) {
        const why = await r.json().then((b: { error?: unknown }) => String(b.error ?? r.status)).catch(() => String(r.status));
        setFailure(tr('accounts.failed', { why }));
        return false;
      }
      return true;
    } catch (e) {
      setFailure(tr('accounts.failed', { why: e instanceof Error ? e.message : String(e) }));
      return false;
    } finally {
      await Promise.all([reread(), req.path.startsWith('/api/hub/') ? refreshHubLive() : Promise.resolve()]);
    }
  }, [reread, tr]);

  if (!present) return null;
  const at = reads?.at ?? null;
  const strategy = settings ? strategyLabel(settings.rotationStrategy, tr) : null;

  return (
    <div className="@container h-full overflow-auto bg-app-bg" data-testid="accounts-pane">
      <div className="mx-auto max-w-[760px] px-4 pb-4 pt-3 @max-2xl:px-3 @max-2xl:pb-5">
        <header className="mb-3 flex items-center gap-2.5">
          <h1 className="m-0 text-title font-semibold text-app-text-heading @max-2xl:hidden">{tr('accounts.open')}</h1>
          <span className="flex-1" />
          <span className="flex items-center gap-1.5 text-mini tabular-nums text-app-text-secondary @max-2xl:text-compact" data-testid="accounts-updated">
            <span className={`h-1.5 w-1.5 flex-none rounded-full ${hub.answering && !failing ? 'bg-emerald-500 dark:bg-emerald-400' : 'bg-amber-500'}`} />
            {at === null ? tr('accounts.reading') : hub.answering && !failing ? tr('accounts.live', { time: clock.time(at) }) : tr('accounts.readAt', { time: clock.time(hub.seenAt ?? at) })}
          </span>
        </header>

        {!hub.answering && (
          <Band testId="accounts-hub-down" icon={<CloudOff size={14} />} onRetry={async () => { await Promise.all([refreshHubLive(), reread()]); }}>
            {hub.seenAt === null ? tr('accounts.hubDownNever') : tr('accounts.hubDown', { time: clock.time(hub.seenAt) })}
          </Band>
        )}
        {failure && <div role="alert" data-testid="accounts-failure" className={`mb-2.5 rounded border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-compact ${DANGER_TEXT}`}>{failure}</div>}

        {hub.gates !== undefined && <HoldRow until={hold} run={run} clock={clock} />}

        <h2 className={SECTION_TITLE}>
          <CreditCard size={13} aria-hidden="true" />{tr('accounts.subs')}
          <span className="font-normal tabular-nums">{(proxy?.accounts.length ?? 0) + metered.length}</span>
          {strategy && <span className="ml-auto font-normal @max-2xl:ml-0 @max-2xl:w-full">{tr('accounts.subsOrder', { strategy })}</span>}
        </h2>
        {failing && !proxy && <p data-testid="accounts-proxy-down" className="mb-2 text-compact text-app-text-secondary">{tr('accounts.proxyDown')}</p>}
        <div className="grid grid-cols-2 gap-2 @max-2xl:grid-cols-1" data-testid="accounts-grid">
          {proxy?.accounts.map((a) => <ClaudeCard key={a.name} account={a} run={run} clock={clock} />)}
          {metered.map((m) => <MeteredCard key={m.provider} provider={m} run={run} clock={clock} />)}
        </div>

        {proxy && proxy.keys.length > 0 && <ApiKeys keys={proxy.keys} run={run} />}
        {settings && <Rules settings={settings} run={run} />}
        <Brake gates={hub.gates} pace={hub.pace} />

        <p className="mt-3 flex flex-wrap items-center gap-1.5 text-compact text-app-text-secondary">
          <KeyRound size={13} aria-hidden="true" />{tr('accounts.providersLink')}
          <button type="button" data-testid="accounts-providers-link" className="text-primary underline-offset-2 hover:underline" onClick={() => openHome('providers')}>
            {tr('accounts.providersOpen')}
          </button>
        </p>
      </div>
    </div>
  );
}

function strategyLabel(id: string, tr: Tr): string {
  return (ROTATION_STRATEGIES as readonly string[]).includes(id) ? tr(`accounts.strategy.${id}`) : id;
}

function Band({ testId, icon, onRetry, children }: { testId: string; icon: ReactNode; onRetry: () => Promise<void>; children: ReactNode }) {
  const tr = useT();
  const [busy, setBusy] = useState(false);
  return (
    <div role="status" data-testid={testId} className={`mb-2.5 flex min-h-7 items-center gap-1.5 rounded bg-app-hover py-1 pl-2.5 pr-1 text-compact text-app-text-secondary`}>
      <span className="flex-none" aria-hidden="true">{icon}</span>
      <span className="min-w-0 flex-1 tabular-nums">{children}</span>
      <button type="button" disabled={busy} className={BUTTON} onClick={() => { setBusy(true); void onRetry().finally(() => setBusy(false)); }}>{tr('accounts.retry')}</button>
    </div>
  );
}

/** THE ONE COMMAND FOR EVERYBODY: no new background work for a few hours, and back. */
function HoldRow({ until, run, clock }: { until: number | null; run: Run; clock: ReturnType<typeof useClock> }) {
  const tr = useT();
  const [busy, setBusy] = useState(false);
  const act = (c: AccountCommand) => { setBusy(true); void run(c).finally(() => setBusy(false)); };
  return (
    <div data-testid="accounts-hold" data-held={until !== null ? 'true' : 'false'} className={`${LIST} mb-1 flex flex-wrap items-center gap-2 px-2.5 py-2 text-compact ${until !== null ? 'border-amber-500/45 bg-amber-500/10' : ''}`}>
      {until !== null ? <Pause size={14} className={`flex-none ${WARNING_TEXT}`} aria-hidden="true" /> : <Hourglass size={14} className="flex-none text-app-text-secondary" aria-hidden="true" />}
      <span className="min-w-0 flex-1">
        <b className="block font-semibold text-app-text">{tr('accounts.hold.title')}</b>
        <span className="text-app-text-secondary tabular-nums">{until !== null ? tr('accounts.hold.on', { time: clock.time(until) }) : tr('accounts.hold.off')}</span>
      </span>
      <span className="flex flex-none flex-wrap gap-1.5">
        {until !== null
          ? <button type="button" disabled={busy} data-testid="accounts-hold-release" className={BUTTON} onClick={() => act({ kind: 'release' })}><Play size={12} aria-hidden="true" />{tr('accounts.hold.release')}</button>
          : HOLD_HOURS.map((h) => (
              <button key={h} type="button" disabled={busy} data-testid={`accounts-hold-stop-${h}`} className={BUTTON} onClick={() => act({ kind: 'hold', hours: h })}>{tr('accounts.hold.stop', { n: h })}</button>
            ))}
      </span>
    </div>
  );
}

// ── Bars ──────────────────────────────────────────────────────────────────────

function Bar({ label, pct, cap = null, testId }: { label: string; pct: number | null; cap?: number | null; testId: string }) {
  const tr = useT();
  const warn = pct !== null && pct >= HOT_QUOTA_AT;
  return (
    <div className="grid h-[18px] grid-cols-[36px_minmax(0,1fr)_36px] items-center gap-1.5 text-compact tabular-nums text-app-text-secondary" data-testid={testId} data-pct={pct ?? ''}>
      <span>{label}</span>
      <span className="relative h-[5px] rounded-[3px] bg-black/[0.08] dark:bg-white/[0.1]">
        {pct !== null && <i className={`block h-full rounded-[3px] ${warn ? 'bg-amber-500' : 'bg-app-text-tertiary'}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />}
        {cap !== null && <span title={tr('accounts.bar.cap', { pct: cap })} className="absolute -bottom-px -top-px w-0.5 rounded-[1px] bg-amber-500" style={{ left: `${Math.min(99, cap)}%` }} />}
      </span>
      <span className={`text-right ${warn ? `font-semibold ${WARNING_TEXT}` : 'text-app-text'}`}>{pct === null ? '-' : `${pct}%`}</span>
    </div>
  );
}

function CardShell({ current, testId, data, children }: { current: boolean; testId: string; data: Record<string, string>; children: ReactNode }) {
  const attrs = Object.fromEntries(Object.entries(data).map(([k, v]) => [`data-${k}`, v]));
  return (
    <div data-testid={testId} {...attrs} className={`relative flex min-w-0 flex-col rounded border bg-app-inset px-2.5 pb-2.5 pt-[9px] text-compact ${current ? 'border-primary/55' : 'border-app-border'}`}>
      {children}
    </div>
  );
}

function CardHead({ name, plan, chip }: { name: string; plan: string | null; chip: ReactNode }) {
  return (
    <div className="mb-[7px] flex min-w-0 items-center gap-1.5">
      <b className="min-w-0 truncate text-prose font-semibold text-app-text" title={name}>{name}</b>
      {plan && <span className="flex-none whitespace-nowrap text-app-text-secondary">{plan}</span>}
      {chip}
    </div>
  );
}

// ── Claude, from the proxy ───────────────────────────────────────────────────

const STATE_TONE: Record<ClaudeAccount['state'], keyof typeof CHIP_TONE> = {
  'in-use': 'use', ready: 'quiet', off: 'quiet', capped: 'warn', limited: 'warn', expired: 'bad',
};

function resetCaption(fiveH: QuotaWindow | null, week: QuotaWindow | null, tr: Tr, clock: ReturnType<typeof useClock>): string {
  return [
    fiveH?.resetsAtMs ? tr('accounts.reset.fiveH', { time: clock.time(fiveH.resetsAtMs) }) : null,
    week?.resetsAtMs ? tr('accounts.reset.week', { when: clock.dayTime(week.resetsAtMs) }) : null,
  ].filter(Boolean).join(' · ');
}

function ClaudeCard({ account: a, run, clock }: { account: ClaudeAccount; run: Run; clock: ReturnType<typeof useClock> }) {
  const tr = useT();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [editCap, setEditCap] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const act = async (c: AccountCommand) => { setMenu(false); setBusy(true); await run(c); setBusy(false); };
  const caption = a.state === 'in-use' || a.state === 'ready' ? resetCaption(a.fiveH, a.week, tr, clock) : tr(`accounts.caption.${a.state}`);

  const remove = async () => {
    setMenu(false);
    const yes = await confirm({ title: tr('accounts.remove.title', { name: a.label }), body: tr('accounts.remove.body'), confirmLabel: tr('accounts.remove.confirm') });
    if (yes) await act({ kind: 'remove', name: a.name });
  };

  return (
    <CardShell current={a.active} testId="account-card" data={{ account: a.name, state: a.state }}>
      <CardHead
        name={a.label}
        plan={a.plan}
        chip={<span className={`${CHIP} ${CHIP_TONE[STATE_TONE[a.state]]}`}>{a.state === 'in-use' && <Gauge size={11} aria-hidden="true" />}{tr(`accounts.chip.${a.state}`)}</span>}
      />
      {a.fiveH && <Bar label={tr('accounts.bar.fiveH')} pct={a.fiveH.pct} cap={a.cap.fiveH} testId="account-bar-5h" />}
      <Bar label={tr('accounts.bar.week')} pct={a.week?.pct ?? null} cap={a.cap.week} testId="account-bar-week" />
      <div className={`mb-[9px] mt-1 min-h-[17px] leading-snug tabular-nums ${a.state === 'expired' ? DANGER_TEXT : 'text-app-text-secondary'}`}>{caption}</div>
      {editCap && <CapEditor account={a} onDone={() => setEditCap(false)} run={run} />}
      <div className="mt-auto flex items-center gap-1.5">
        {a.state === 'expired'
          ? <button type="button" disabled={busy} data-testid="account-card-refresh" className={BUTTON} onClick={() => void act({ kind: 'refresh', name: a.name })}><RefreshCw size={12} aria-hidden="true" />{tr('accounts.cmd.refresh')}</button>
          : !a.active && !a.disabled && <button type="button" disabled={busy} data-testid="account-card-use" className={BUTTON} onClick={() => void act({ kind: 'switch', name: a.name })}><ArrowLeftRight size={12} aria-hidden="true" />{tr('accounts.cmd.use')}</button>}
        {a.disabled && <button type="button" disabled={busy} data-testid="account-card-on" className={BUTTON} onClick={() => void act({ kind: 'enabled', name: a.name, enabled: true })}><Power size={12} aria-hidden="true" />{tr('accounts.cmd.on')}</button>}
        <span className="flex-1" />
        <button
          ref={more}
          type="button"
          data-testid="account-card-more"
          aria-haspopup="menu"
          aria-expanded={menu}
          aria-label={tr('accounts.cmd.more', { name: a.label })}
          title={tr('accounts.cmd.more', { name: a.label })}
          className={`${ICON_BUTTON} ${menu ? 'bg-app-hover text-app-text' : ''}`}
          onClick={() => setMenu((v) => !v)}
        >
          <MoreHorizontal size={14} aria-hidden="true" />
        </button>
        <Menu open={menu} anchorRef={more} onClose={() => setMenu(false)} align="right" minWidth={190} testId="account-menu" ariaLabel={tr('accounts.cmd.more', { name: a.label })}>
          <MenuItem icon={ArrowUp} testId="account-cmd-up" onClick={() => void act({ kind: 'priority', name: a.name, priority: a.priority + 1 })}>{tr('accounts.cmd.up')}</MenuItem>
          <MenuItem icon={ArrowDown} testId="account-cmd-down" onClick={() => void act({ kind: 'priority', name: a.name, priority: a.priority - 1 })}>{tr('accounts.cmd.down')}</MenuItem>
          <MenuItem icon={SlidersHorizontal} testId="account-cmd-cap" onClick={() => { setMenu(false); setEditCap(true); }}>{tr('accounts.cmd.cap')}</MenuItem>
          <MenuItem icon={LogIn} testId="account-cmd-refresh" onClick={() => void act({ kind: 'refresh', name: a.name })}>{tr('accounts.cmd.refresh')}</MenuItem>
          <MenuItem icon={Power} testId="account-cmd-toggle" onClick={() => void act({ kind: 'enabled', name: a.name, enabled: a.disabled })}>{tr(a.disabled ? 'accounts.cmd.on' : 'accounts.cmd.off')}</MenuItem>
          <MenuItem icon={Power} testId="account-cmd-remove" danger onClick={() => void remove()}>{tr('accounts.cmd.remove')}</MenuItem>
        </Menu>
      </div>
    </CardShell>
  );
}

function MenuItem({ icon: Icon, testId, danger = false, onClick, children }: { icon: typeof Power; testId: string; danger?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" role="menuitem" data-testid={testId} className={danger ? POPOVER_ITEM_DANGER : POPOVER_ITEM} onClick={onClick}>
      <Icon size={14} className="flex-none" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-left">{children}</span>
    </button>
  );
}

/** The account's own caps: empty inherits the cap of every account. */
function CapEditor({ account: a, onDone, run }: { account: ClaudeAccount; onDone: () => void; run: Run }) {
  const tr = useT();
  const [five, setFive] = useState(a.cap.ownFiveH === null ? '' : String(a.cap.ownFiveH));
  const [week, setWeek] = useState(a.cap.ownWeek === null ? '' : String(a.cap.ownWeek));
  const [busy, setBusy] = useState(false);
  const v5 = capInput(five);
  const v7 = capInput(week);
  const invalid = v5 === 'invalid' || v7 === 'invalid';
  const save = async (fiveH: number | null, sevenD: number | null) => {
    setBusy(true);
    if (await run({ kind: 'cap', name: a.name, fiveH, sevenD })) onDone();
    setBusy(false);
  };
  const field = 'h-[26px] w-14 rounded-sm border border-app-border-light bg-app-input px-1.5 text-right text-compact tabular-nums text-app-text outline-none focus:border-primary @max-2xl:h-9';
  return (
    <div data-testid="account-cap-editor" className="mb-2 flex flex-col gap-1.5 rounded-sm border border-app-border-subtle bg-surface p-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5">{tr('accounts.cap.fiveH')}<input data-testid="account-cap-5h" inputMode="numeric" className={field} value={five} placeholder={a.cap.fiveH === null ? '-' : String(a.cap.fiveH)} onChange={(e) => setFive(e.target.value)} />%</label>
        <label className="flex items-center gap-1.5">{tr('accounts.cap.week')}<input data-testid="account-cap-week" inputMode="numeric" className={field} value={week} placeholder={a.cap.week === null ? '-' : String(a.cap.week)} onChange={(e) => setWeek(e.target.value)} />%</label>
      </div>
      <div className={`text-mini ${invalid ? DANGER_TEXT : 'text-app-text-secondary'}`}>{invalid ? tr('accounts.cap.invalid') : tr('accounts.cap.hint')}</div>
      <div className="flex gap-1.5">
        <button type="button" disabled={busy || invalid} data-testid="account-cap-save" className={`${BUTTON} border-primary bg-primary text-white hover:bg-primary`} onClick={() => { if (!invalid) void save(v5, v7); }}>{tr('accounts.cap.save')}</button>
        <button type="button" disabled={busy} data-testid="account-cap-inherit" className={BUTTON} onClick={() => void save(null, null)}>{tr('accounts.cap.inherit')}</button>
      </div>
    </div>
  );
}

// ── Codex and Muse, read-only ─────────────────────────────────────────────────

function MeteredCard({ provider: m, run, clock }: { provider: MeteredProvider; run: Run; clock: ReturnType<typeof useClock> }) {
  const tr = useT();
  const [busy, setBusy] = useState(false);
  const act = async (c: AccountCommand) => { setBusy(true); await run(c); setBusy(false); };
  const name = tr(`accounts.provider.${m.provider}`);
  const chip = m.unlockedUntil !== null
    ? <span className={`${CHIP} ${CHIP_TONE.use}`}><Unlock size={11} aria-hidden="true" />{tr('accounts.chip.unlocked')}</span>
    : m.braked
      ? <span className={`${CHIP} ${CHIP_TONE.warn}`}><Lock size={11} aria-hidden="true" />{tr('accounts.chip.braked')}</span>
      : <span className={`${CHIP} ${CHIP_TONE.quiet}`}>{m.provider === 'codex' && <ImageIcon size={11} aria-hidden="true" />}{tr('accounts.chip.readOnly')}</span>;
  const caption = m.unlockedUntil !== null
    ? tr('accounts.metered.unlockedUntil', { time: clock.time(m.unlockedUntil) })
    : m.braked && m.brakeReason
      ? tr('accounts.metered.braked', { reason: m.brakeReason })
      : [
          m.pace !== null ? tr('accounts.metered.pace', { n: m.pace.toFixed(1).replace('.', ',') }) : null,
          m.weekResetsAtMs ? tr('accounts.reset.week', { when: clock.dayTime(m.weekResetsAtMs) }) : null,
          m.stale ? tr('accounts.metered.stale') : null,
        ].filter(Boolean).join(' · ');
  return (
    <CardShell current={false} testId="metered-card" data={{ provider: m.provider, braked: m.braked ? 'true' : 'false' }}>
      <CardHead name={name} plan={m.account} chip={chip} />
      {m.fiveH !== null && <Bar label={tr('accounts.bar.fiveH')} pct={Math.round(m.fiveH)} testId="account-bar-5h" />}
      <Bar label={tr('accounts.bar.week')} pct={m.week === null ? null : Math.round(m.week)} testId="account-bar-week" />
      <div className={`mb-[9px] mt-1 min-h-[17px] leading-snug tabular-nums ${m.braked && m.unlockedUntil === null ? WARNING_TEXT : 'text-app-text-secondary'}`}>{caption}</div>
      <div className="mt-auto flex items-center gap-1.5">
        {m.unlockedUntil !== null
          ? <button type="button" disabled={busy} data-testid="metered-relock" className={BUTTON} onClick={() => void act({ kind: 'relock', provider: m.provider })}><Lock size={12} aria-hidden="true" />{tr('accounts.cmd.relock')}</button>
          : <button type="button" disabled={busy} data-testid="metered-unlock" className={BUTTON} onClick={() => void act({ kind: 'unlock', provider: m.provider, hours: UNLOCK_HOURS })}><Unlock size={12} aria-hidden="true" />{tr('accounts.cmd.unlock', { n: UNLOCK_HOURS })}</button>}
      </div>
    </CardShell>
  );
}

// ── Reserve API keys ──────────────────────────────────────────────────────────

function ApiKeys({ keys, run }: { keys: ApiKey[]; run: Run }) {
  const tr = useT();
  const [busy, setBusy] = useState(false);
  const act = async (c: AccountCommand) => { setBusy(true); await run(c); setBusy(false); };
  return (
    <>
      <h2 className={SECTION_TITLE}>
        <Wallet size={13} aria-hidden="true" />{tr('accounts.keys')}<span className="font-normal tabular-nums">{keys.length}</span>
        <span className="ml-auto font-normal @max-2xl:ml-0 @max-2xl:w-full">{tr('accounts.keysOrder')}</span>
      </h2>
      <div className={LIST} data-testid="api-keys">
        {keys.map((k, i) => {
          const up = keyMove(keys, i, -1);
          const down = keyMove(keys, i, 1);
          return (
            <div key={k.name} className={LIST_ROW} data-testid="api-key-row" data-key={k.name} data-disabled={k.disabled ? 'true' : 'false'}>
              <span className="flex h-5 w-5 flex-none items-center justify-center rounded-xs bg-app-hover text-mini font-semibold tabular-nums text-app-text-secondary">{i + 1}</span>
              <span className="flex min-w-0 flex-1 items-baseline gap-2 @max-2xl:flex-col @max-2xl:gap-px">
                <span className={`min-w-0 truncate ${k.disabled ? 'text-app-text-secondary' : ''}`}>{k.label}</span>
                {k.disabled && <span className="ml-auto whitespace-nowrap text-app-text-secondary @max-2xl:ml-0">{tr('accounts.key.off')}</span>}
              </span>
              <span className="flex flex-none gap-0.5 text-app-text-secondary">
                <button type="button" disabled={busy || !up} data-testid="api-key-up" aria-label={tr('accounts.key.up', { name: k.label })} title={tr('accounts.key.up', { name: k.label })} className="rounded-xs p-0.5 hover:bg-app-hover hover:text-app-text disabled:opacity-30 coarse:p-2" onClick={() => up && void act({ kind: 'key', ...up })}><ArrowUp size={13} aria-hidden="true" /></button>
                <button type="button" disabled={busy || !down} data-testid="api-key-down" aria-label={tr('accounts.key.down', { name: k.label })} title={tr('accounts.key.down', { name: k.label })} className="rounded-xs p-0.5 hover:bg-app-hover hover:text-app-text disabled:opacity-30 coarse:p-2" onClick={() => down && void act({ kind: 'key', ...down })}><ArrowDown size={13} aria-hidden="true" /></button>
              </span>
              <Switch checked={!k.disabled} disabled={busy} label={tr('accounts.key.on', { name: k.label })} testId="api-key-switch" onChange={(on) => void act({ kind: 'key', name: k.name, disabled: !on })} />
            </div>
          );
        })}
      </div>
    </>
  );
}

// ── Rotation and caps: the proxy's rules ─────────────────────────────────────

function Rules({ settings: s, run }: { settings: ProxySettings; run: Run }) {
  const tr = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const set = async (key: keyof ProxySettings, value: ProxySettings[keyof ProxySettings]) => {
    setBusy(key);
    await run({ kind: 'setting', patch: { [key]: value } });
    setBusy(null);
  };
  const capOptions = (cur: number | null) => [
    { value: 'none', label: tr('accounts.none') },
    ...[...new Set([...CAP_STEPS, ...(cur === null ? [] : [cur])])].sort((a, b) => a - b).map((v) => ({ value: String(v), label: `${v}%` })),
  ];
  const holdLabel = (m: number) => (m === 0 ? tr('accounts.noneF') : m < 60 ? tr('accounts.minutes', { n: m }) : tr('accounts.hours', { n: m / 60 }));
  const strategies = (ROTATION_STRATEGIES as readonly string[]).includes(s.rotationStrategy) ? ROTATION_STRATEGIES : [...ROTATION_STRATEGIES, s.rotationStrategy];
  const pick = (key: keyof ProxySettings, value: string, options: Array<{ value: string; label: string }>, onChange: (v: string) => void) => (
    <Select value={value} options={options} onChange={onChange} ariaLabel={tr(`accounts.rule.${RULE_LABEL[key]}`)} disabled={busy === key} align="right" testId={`accounts-rule-${key}`} className="flex-shrink-0 tabular-nums" />
  );
  return (
    <>
      <h2 className={SECTION_TITLE}><ArrowLeftRight size={13} aria-hidden="true" />{tr('accounts.rules')}</h2>
      <div className={LIST} data-testid="accounts-rules">
        <Rule label={tr('accounts.rule.proxy')}><Switch checked={s.proxyEnabled} disabled={busy === 'proxyEnabled'} label={tr('accounts.rule.proxy')} testId="accounts-rule-proxyEnabled" onChange={(v) => void set('proxyEnabled', v)} /></Rule>
        <Rule label={tr('accounts.rule.autoSwitch')}><Switch checked={s.autoSwitch} disabled={busy === 'autoSwitch'} label={tr('accounts.rule.autoSwitch')} testId="accounts-rule-autoSwitch" onChange={(v) => void set('autoSwitch', v)} /></Rule>
        <Rule label={tr('accounts.rule.strategy')}>{pick('rotationStrategy', s.rotationStrategy, strategies.map((id) => ({ value: id, label: strategyLabel(id, tr) })), (v) => void set('rotationStrategy', v))}</Rule>
        {s.rotationStrategy === 'round-robin' && <Rule label={tr('accounts.rule.interval')}>{pick('rotationIntervalMin', String(s.rotationIntervalMin), ROTATION_INTERVALS.map((m) => ({ value: String(m), label: holdLabel(m) })), (v) => void set('rotationIntervalMin', Number(v)))}</Rule>}
        {s.rotationStrategy === 'balance' && <Rule label={tr('accounts.rule.parallel')}>{pick('maxConcurrentPerAccount', String(s.maxConcurrentPerAccount), PARALLEL_STEPS.map((n) => ({ value: String(n), label: String(n) })), (v) => void set('maxConcurrentPerAccount', Number(v)))}</Rule>}
        <Rule label={tr('accounts.rule.cap5h')}>{pick('usageCap5h', s.usageCap5h === null ? 'none' : String(s.usageCap5h), capOptions(s.usageCap5h), (v) => void set('usageCap5h', v === 'none' ? null : Number(v)))}</Rule>
        <Rule label={tr('accounts.rule.cap7d')}>{pick('usageCap7d', s.usageCap7d === null ? 'none' : String(s.usageCap7d), capOptions(s.usageCap7d), (v) => void set('usageCap7d', v === 'none' ? null : Number(v)))}</Rule>
        <Rule label={tr('accounts.rule.hold')}>{pick('usageCapHoldMin', String(s.usageCapHoldMin), [...new Set([...HOLD_STEPS, s.usageCapHoldMin])].sort((a, b) => a - b).map((m) => ({ value: String(m), label: holdLabel(m) })), (v) => void set('usageCapHoldMin', Number(v)))}</Rule>
        <Rule label={tr('accounts.rule.queue')}><Switch checked={s.serializeRequests} disabled={busy === 'serializeRequests'} label={tr('accounts.rule.queue')} testId="accounts-rule-serializeRequests" onChange={(v) => void set('serializeRequests', v)} /></Rule>
        <Rule label={tr('accounts.rule.usdEur')}><RateField value={s.usdEur} disabled={busy === 'usdEur'} onSave={(v) => void set('usdEur', v)} /></Rule>
      </div>
    </>
  );
}

const RULE_LABEL: Partial<Record<keyof ProxySettings, string>> = {
  rotationStrategy: 'strategy', rotationIntervalMin: 'interval', maxConcurrentPerAccount: 'parallel', usageCap5h: 'cap5h', usageCap7d: 'cap7d', usageCapHoldMin: 'hold',
};

function Rule({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={LIST_ROW}>
      <span className="min-w-0 flex-1">{label}</span>
      {children}
    </div>
  );
}

/** The dollar to euro rate, saved on Enter or when the field is left. */
function RateField({ value, disabled, onSave }: { value: number; disabled: boolean; onSave: (v: number) => void }) {
  const tr = useT();
  const [text, setText] = useState(String(value).replace('.', ','));
  useEffect(() => { setText(String(value).replace('.', ',')); }, [value]);
  const commit = () => {
    const v = Number(text.replace(',', '.'));
    if (Number.isFinite(v) && v > 0 && v <= 10 && v !== value) onSave(v);
    else setText(String(value).replace('.', ','));
  };
  return (
    <input
      data-testid="accounts-rule-usdEur"
      aria-label={tr('accounts.rule.usdEur')}
      inputMode="decimal"
      disabled={disabled}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      className="h-[26px] w-16 flex-none rounded-sm border border-app-border-light bg-elevated px-2 text-right text-compact tabular-nums text-app-text outline-none focus:border-primary @max-2xl:h-9"
    />
  );
}

// ── How the brake works ───────────────────────────────────────────────────────

function Brake({ gates, pace }: { gates: unknown; pace: unknown }) {
  const tr = useT();
  const classes = brakeClasses(gates);
  const lines = paceLines(pace);
  if (classes.length === 0 && lines.length === 0) return null;
  const who = (p: string) => (['free', 'claude', 'codex', 'muse'].includes(p) ? tr(`accounts.provider.${p}`) : p);
  const cell = 'border-t border-app-border-subtle px-2.5 py-[7px] align-top leading-snug';
  return (
    <>
      <h2 className={SECTION_TITLE}><Info size={13} aria-hidden="true" />{tr('accounts.brake')}</h2>
      {classes.length > 0 && (
        <table className={`${LIST} w-full border-separate border-spacing-0 text-compact text-app-text-body`} data-testid="accounts-brake">
          <thead>
            <tr className="bg-app-hover text-left text-app-text-secondary">
              <th scope="col" className="px-2.5 py-[7px] font-semibold">{tr('accounts.brake.class')}</th>
              <th scope="col" className="px-2.5 py-[7px] font-semibold">{tr('accounts.brake.order')}</th>
              <th scope="col" className="px-2.5 py-[7px] font-semibold @max-2xl:hidden">{tr('accounts.brake.now')}</th>
            </tr>
          </thead>
          <tbody>
            {classes.map((c) => (
              <tr key={c.id} data-testid="accounts-brake-row" data-class={c.id} data-go={c.go ? 'true' : 'false'}>
                <td className={`${cell} whitespace-nowrap text-app-text`}>
                  <span className={`mr-1.5 inline-block h-[7px] w-[7px] rounded-full align-[1px] ${c.go ? 'bg-emerald-500' : 'bg-amber-500'}`} />{tr(`accounts.class.${c.id}`)}
                </td>
                <td className={cell}>{c.order.map(who).join(' → ')}</td>
                <td className={`${cell} @max-2xl:hidden`}>
                  <span className="text-app-text">{c.go && c.provider ? who(c.provider) : tr('accounts.brake.stopped')}</span>
                  {c.reason && <span className="text-app-text-secondary"> · {c.reason}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ul className="mt-2 flex flex-col gap-0.5 text-compact tabular-nums text-app-text-secondary" data-testid="accounts-pace">
        {lines.map((l) => (
          <li key={l.provider}>{tr('accounts.brake.pace', { provider: who(l.provider), used: Math.round(l.used), elapsed: l.elapsedPct === null ? '-' : Math.round(l.elapsedPct) })}</li>
        ))}
      </ul>
      <p className="mt-2.5 flex items-start gap-1.5 text-compact leading-snug text-app-text-secondary"><Info size={13} className="mt-px flex-none" aria-hidden="true" />{tr('accounts.brake.note')}</p>
      <p className="mt-1 flex items-start gap-1.5 text-compact leading-snug text-app-text-secondary"><CloudOff size={13} className="mt-px flex-none" aria-hidden="true" />{tr('accounts.brake.stale')}</p>
    </>
  );
}
