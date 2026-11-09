/**
 * ACCOUNTS AND QUOTAS (hub-smistamento, HUBBR-10 and HUBBR-11).
 *
 * The plans in one place, opened from the row with your name: the Claude
 * accounts of the proxy with their bars and the proxy's commands (use this one,
 * priority, cap, renew the token, on and off, remove), Codex and Muse read-only
 * with the hub's «unlock the brake», the reserve Anthropic keys, the proxy's
 * rotation and caps, and how the brake decides. At the top the decision that
 * is yours: the account in use past 80% of a window, with the switch to the
 * next ready account and the stop of the background work. Under the plans the
 * one command that holds for everybody: stop the background work for a few hours.
 *
 * The truth stays in the hub and in the proxy: every write goes there and the
 * view shows what it reads back, never what it hoped to write. With the hub
 * silent the bars keep their last reading under a band that says since when;
 * with the proxy silent the Claude half says so instead of an empty list.
 * Loaded as its own chunk, only where the hub is part of the installation.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle, ArrowDown, ArrowUp, ArrowLeftRight, CloudOff, CreditCard, Hourglass, Image as ImageIcon, Info, KeyRound, Lock,
  Pause, Play, Unlock, Wallet,
} from 'lucide-react';
import { useLocale, useT } from '../../hooks/useT';
import { addCatalogue } from '../../lib/i18n';
import ACCOUNTS_IT from '../../lib/i18n-accounts-it';
import ACCOUNTS_EN from '../../lib/i18n-accounts-en';
import { useHubEverRead, useHubLive, refreshHubLive } from '../../state/hubLive';
import { startVisibleInterval } from '../../state/documentVisibility';
import { apiFetch } from '../../lib/shell/net';
import { openHome } from '../../lib/openHome';
import { Select } from '../Shared/Select';
import { Switch } from '../Shared/Switch';
import { DANGER_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import { HOT_QUOTA_AT } from '../Sidebar/hotQuota';
import { PLAN_DISPATCH_HOLD_AT } from '../../../../shared/provider-hold';
import {
  HOLD_HOURS, HOLD_STEPS, PARALLEL_STEPS, ROTATION_INTERVALS, ROTATION_STRATEGIES, SERIALIZE_DELAYS, UNLOCK_HOURS,
  accountCount, weekElapsedPct, backgroundHold, brakeClasses, capInput, commandRequest, elidesArticle, hotDecision, hubProse, keyMove, meteredProviders,
  oneDecimal, paceLines, readProxyAccounts, readProxySettings,
  type AccountCommand, type ApiKey, type HotDecision, type MeteredProvider, type ProxySettings,
} from '../../lib/accountQuotas';
import { boardAccountFor, orphanBoardAccounts, readAccountTrails, readBoardAccounts, readProxyHealth, type BoardAccount } from '../../lib/accountInsights';
import { formatCurrency } from '../../lib/hubUsage';
import { BUTTON, Bar, CHIP, CHIP_TONE, CardHead, CardShell, type Run, type Tr } from './accountCardParts';
import { useClock, type Clock } from './useAccountClock';
import { ClaudeCard } from './ClaudeAccountCard';
import { AccessAndSpend, BoardExtras, LoginCard, ProxyHealthLine } from './AccountInsights';
import { readJson } from '../../lib/readJson';

// The view's strings travel with its chunk, before its first render.
addCatalogue('it', ACCOUNTS_IT);
addCatalogue('en', ACCOUNTS_EN);

/** The proxy recomputes its windows on every request; a read every 15 s is plenty for a view. */
const POLL_MS = 15_000;

const SECTION_TITLE = 'mb-1.5 mt-3.5 flex flex-wrap items-center gap-1.5 text-mini font-semibold text-app-text-secondary first:mt-0';
const LIST = 'overflow-hidden rounded border border-app-border bg-app-inset';
const LIST_ROW = 'flex min-h-[34px] items-center gap-2 border-t border-app-border-subtle px-2.5 py-[5px] text-compact text-app-text first:border-t-0 @max-2xl:min-h-[52px] @max-2xl:text-prose';
interface ProxyReads {
  profiles: unknown;
  settings: unknown;
  /** The hub's board: per account the pace dial, the forecast, the extra windows, the login, who spent. */
  board: unknown;
  at: number;
}

type Fetched = { profiles: unknown; settings: unknown; board: unknown };

async function fetchProxy(): Promise<Fetched> {
  const [profiles, settings, board] = await Promise.all([readJson('/api/switchboard/profiles'), readJson('/api/switchboard/settings'), readJson('/api/hub/board')]);
  return { profiles, settings, board };
}

/** The proxy's accounts and rules, again every POLL_MS while visible and after every write. */
function useProxyReads(enabled: boolean): { reads: ProxyReads | null; failing: boolean; reread: () => Promise<void> } {
  const [reads, setReads] = useState<ProxyReads | null>(null);
  const [failing, setFailing] = useState(false);
  const alive = useRef(true);
  const apply = useCallback(({ profiles, settings, board }: Fetched) => {
    if (!alive.current) return;
    const any = Boolean(profiles || settings);
    setFailing(!any);
    // A failed read keeps the last good one: the band says how old it is.
    if (any || board) setReads((prev) => ({ profiles: profiles ?? prev?.profiles, settings: settings ?? prev?.settings, board: board ?? prev?.board, at: any ? Date.now() : prev?.at ?? Date.now() }));
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
  const trails = useMemo(() => readAccountTrails(reads?.profiles), [reads?.profiles]);
  const health = useMemo(() => readProxyHealth(reads?.profiles), [reads?.profiles]);
  const board = useMemo(() => readBoardAccounts(reads?.board), [reads?.board]);
  const rate = settings?.usdEur ?? 0.92;
  const money = useCallback((usd: number) => formatCurrency(usd, rate, locale), [rate, locale]);
  // An account the board names and no card shows: its login died, so it has no quota anywhere else.
  const orphans = orphanBoardAccounts(board, [
    ...(proxy?.accounts ?? []).map((a) => ({ provider: 'claude', names: [a.label, a.name] })),
    ...metered.map((m) => ({ provider: m.provider, names: [m.account] })),
  ]);
  const hold = backgroundHold(hub.gates);
  const decision = proxy ? hotDecision(proxy.accounts, HOT_QUOTA_AT) : null;

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

        <ProxyHealthLine health={health} />

        {!hub.answering && (
          <Band testId="accounts-hub-down" icon={<CloudOff size={14} />} onRetry={async () => { await Promise.all([refreshHubLive(), reread()]); }}>
            {hub.seenAt === null ? tr('accounts.hubDownNever') : tr('accounts.hubDown', { time: clock.time(hub.seenAt) })}
          </Band>
        )}
        {failure && <div role="alert" data-testid="accounts-failure" className={`mb-2.5 rounded border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-compact ${DANGER_TEXT}`}>{failure}</div>}

        {proxy?.allExhausted && (
          <div role="alert" data-testid="accounts-all-exhausted" className={`mb-2.5 flex items-start gap-2 rounded border border-red-500/35 bg-red-500/10 px-2.5 py-1.5 text-compact ${DANGER_TEXT}`}>
            <AlertTriangle size={14} className="mt-px flex-none" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <b className="block font-semibold">{tr('accounts.allExhausted')}</b>
              <span className="tabular-nums">{tr('accounts.allExhausted.first', { when: proxy.earliestReset ?? tr('accounts.allExhausted.unknown') })}</span>
            </span>
          </div>
        )}
        {decision && <Decide decision={decision} held={hold !== null} canHold={hub.gates !== undefined} run={run} clock={clock} />}

        <h2 className={SECTION_TITLE}>
          <CreditCard size={13} aria-hidden="true" />{tr('accounts.subs')}
          <span className="font-normal tabular-nums" data-testid="accounts-count">{accountCount(reads?.profiles, hub.pace)}</span>
          {strategy && <span className="ml-auto font-normal @max-2xl:ml-0 @max-2xl:w-full">{tr('accounts.subsOrder', { strategy })}</span>}
        </h2>
        {failing && !proxy && <p data-testid="accounts-proxy-down" className="mb-2 text-compact text-app-text-secondary">{tr('accounts.proxyDown')}</p>}
        <div className="grid grid-cols-2 gap-2 @max-2xl:grid-cols-1" data-testid="accounts-grid">
          {proxy?.accounts.map((a) => (
            <ClaudeCard key={a.name} account={a} trail={trails.get(a.name) ?? null} readAt={reads?.at ?? 0} board={boardAccountFor(board, 'claude', a.label, a.name)} money={money} run={run} clock={clock} />
          ))}
          {metered.map((m) => <MeteredCard key={`${m.provider}:${m.account}`} provider={m} board={boardAccountFor(board, m.provider, m.account)} run={run} clock={clock} />)}
          {orphans.map((b) => <LoginCard key={`${b.provider}:${b.account}`} board={b} />)}
        </div>

        {hub.gates !== undefined && <HoldRow until={hold} run={run} clock={clock} />}

        {proxy && proxy.keys.length > 0 && <ApiKeys keys={proxy.keys} run={run} />}
        {settings && <Rules settings={settings} run={run} />}
        <Brake gates={hub.gates} pace={hub.pace} locale={locale} />

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

/**
 * «DECIDI TU»: the account in use is hot. The two moves that are yours: switch
 * to the next ready account (the proxy's switch), or stop the background work
 * so what is left of the window goes to the live chats.
 */
function Decide({ decision: d, held, canHold, run, clock }: { decision: HotDecision; held: boolean; canHold: boolean; run: Run; clock: Clock }) {
  const tr = useT();
  const [busy, setBusy] = useState(false);
  const act = (c: AccountCommand) => { setBusy(true); void run(c).finally(() => setBusy(false)); };
  const span = tr(d.window === 'week' ? 'accounts.decide.week' : 'accounts.decide.fiveH');
  const title = tr(elidesArticle(d.pct) ? 'accounts.decide.titleElided' : 'accounts.decide.title', { name: d.account.label, pct: d.pct, window: span });
  const reset = d.resetsAtMs === null ? null : d.window === 'week' ? clock.dayTime(d.resetsAtMs) : clock.time(d.resetsAtMs);
  const at = PLAN_DISPATCH_HOLD_AT;
  const board = d.pct >= at ? tr('accounts.decide.boardStopped', { at }) : tr('accounts.decide.boardStops', { at });
  const holdHours = HOLD_HOURS[1];
  return (
    <>
      <h2 className={SECTION_TITLE}><Hourglass size={13} className={WARNING_TEXT} aria-hidden="true" />{tr('accounts.decide')}<span className="font-normal tabular-nums">1</span></h2>
      <div data-testid="accounts-decide" className="flex items-center gap-2.5 rounded border border-amber-500/45 bg-amber-500/10 px-2.5 py-2 text-app-text @max-2xl:flex-wrap">
        <AlertTriangle size={16} className={`flex-none ${WARNING_TEXT}`} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <b className="block text-prose font-semibold" data-testid="accounts-decide-title">{title}</b>
          <span className="text-compact tabular-nums text-app-text-secondary">{reset ? tr('accounts.decide.reset', { board, when: reset }) : board}</span>
        </span>
        <span className="flex flex-none flex-wrap gap-1.5 @max-2xl:w-full @max-2xl:justify-end">
          {canHold && !held && (
            <button type="button" disabled={busy} data-testid="accounts-decide-hold" className={BUTTON} onClick={() => act({ kind: 'hold', hours: holdHours })}>
              <Pause size={12} aria-hidden="true" />{tr('accounts.decide.hold', { n: holdHours })}
            </button>
          )}
          {d.switchTo && (
            <button type="button" disabled={busy} data-testid="accounts-decide-switch" className={`${BUTTON} border-primary bg-primary text-white hover:bg-primary`} onClick={() => act({ kind: 'switch', name: d.switchTo!.name })}>
              <ArrowLeftRight size={12} aria-hidden="true" />{tr('accounts.decide.switch', { name: d.switchTo.label })}
            </button>
          )}
        </span>
      </div>
    </>
  );
}

/** THE ONE COMMAND FOR EVERYBODY: no new background work for a few hours, and back. */
function HoldRow({ until, run, clock }: { until: number | null; run: Run; clock: Clock }) {
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

// ── Codex and Muse, read-only ─────────────────────────────────────────────────

function MeteredCard({ provider: m, board, run, clock }: { provider: MeteredProvider; board: BoardAccount | null; run: Run; clock: Clock }) {
  const tr = useT();
  const locale = useLocale();
  const reason = hubProse(m.brakeReason, locale);
  const [busy, setBusy] = useState(false);
  const act = async (c: AccountCommand) => { setBusy(true); await run(c); setBusy(false); };
  const name = tr(`accounts.provider.${m.provider}`);
  const chip = m.unlockedUntil !== null
    ? <span className={`${CHIP} ${CHIP_TONE.use}`}><Unlock size={11} aria-hidden="true" />{tr('accounts.chip.unlocked')}</span>
    : m.braked
      ? <span className={`${CHIP} ${CHIP_TONE.warn}`}><Lock size={11} aria-hidden="true" />{tr('accounts.chip.braked')}</span>
      : <span className={`${CHIP} ${CHIP_TONE.quiet}`}>{m.provider === 'codex' && <ImageIcon size={11} aria-hidden="true" />}{tr('accounts.chip.readOnly')}</span>;
  const caption = m.loginDead
    ? tr('accounts.metered.login', { provider: name })
    : m.unlockedUntil !== null
    ? tr('accounts.metered.unlockedUntil', { time: clock.time(m.unlockedUntil) })
    : m.braked
      ? reason
        ? tr('accounts.metered.braked', { reason })
        : m.brakedUntil !== null ? tr('accounts.metered.brakedUntil', { when: clock.dayTime(m.brakedUntil) }) : tr('accounts.metered.brakedPlain')
      : [
          m.pace !== null ? tr('accounts.metered.pace', { n: oneDecimal(m.pace, locale) }) : null,
          m.weekResetsAtMs ? tr('accounts.reset.week', { when: clock.dayTime(m.weekResetsAtMs) }) : null,
          m.stale ? tr('accounts.metered.stale') : null,
        ].filter(Boolean).join(' · ');
  return (
    <CardShell current={false} testId="metered-card" data={{ provider: m.provider, account: m.account, braked: m.braked ? 'true' : 'false', login: m.loginDead ? 'dead' : 'ok' }}>
      <CardHead name={name} plan={m.account} chip={m.loginDead ? <span className={`${CHIP} ${CHIP_TONE.bad}`}>{tr('accounts.chip.expired')}</span> : chip} />
      {m.fiveH !== null && <Bar label={tr('accounts.bar.fiveH')} pct={Math.round(m.fiveH)} testId="account-bar-5h" />}
      <Bar label={tr('accounts.bar.week')} pct={m.week === null ? null : Math.round(m.week)} mark={m.elapsedPct ?? weekElapsedPct(m.weekResetsAtMs)} testId="account-bar-week" />
      {board && <BoardExtras board={board} />}
      <div className={`mb-[9px] mt-1 min-h-[17px] leading-snug tabular-nums ${m.loginDead ? DANGER_TEXT : m.braked && m.unlockedUntil === null ? WARNING_TEXT : 'text-app-text-secondary'}`}>{caption}</div>
      <div className="mt-auto flex items-center gap-1.5">
        {m.unlockedUntil !== null
          ? <button type="button" disabled={busy} data-testid="metered-relock" className={BUTTON} onClick={() => void act({ kind: 'relock', provider: m.provider })}><Lock size={12} aria-hidden="true" />{tr('accounts.cmd.relock')}</button>
          : <button type="button" disabled={busy} data-testid="metered-unlock" className={BUTTON} onClick={() => void act({ kind: 'unlock', provider: m.provider, hours: UNLOCK_HOURS })}><Unlock size={12} aria-hidden="true" />{tr('accounts.cmd.unlock', { n: UNLOCK_HOURS })}</button>}
      </div>
      {board && <AccessAndSpend board={board} />}
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
        <Rule label={tr('accounts.rule.strategy')} hint={(ROTATION_STRATEGIES as readonly string[]).includes(s.rotationStrategy) ? tr(`accounts.strategy.${s.rotationStrategy}.hint`) : undefined}>{pick('rotationStrategy', s.rotationStrategy, strategies.map((id) => ({ value: id, label: strategyLabel(id, tr) })), (v) => void set('rotationStrategy', v))}</Rule>
        {s.rotationStrategy === 'round-robin' && <Rule label={tr('accounts.rule.interval')}>{pick('rotationIntervalMin', String(s.rotationIntervalMin), ROTATION_INTERVALS.map((m) => ({ value: String(m), label: holdLabel(m) })), (v) => void set('rotationIntervalMin', Number(v)))}</Rule>}
        {s.rotationStrategy === 'balance' && <Rule label={tr('accounts.rule.parallel')}>{pick('maxConcurrentPerAccount', String(s.maxConcurrentPerAccount), PARALLEL_STEPS.map((n) => ({ value: String(n), label: String(n) })), (v) => void set('maxConcurrentPerAccount', Number(v)))}</Rule>}
        <Rule label={tr('accounts.rule.cap5h')} hint={tr('accounts.rule.cap5h.hint')}><CapField key={`5h:${s.usageCap5h}`} value={s.usageCap5h} label={tr('accounts.rule.cap5h')} testId="accounts-rule-usageCap5h" disabled={busy === 'usageCap5h'} onSave={(v) => void set('usageCap5h', v)} /></Rule>
        <Rule label={tr('accounts.rule.cap7d')} hint={tr('accounts.rule.cap7d.hint')}><CapField key={`7d:${s.usageCap7d}`} value={s.usageCap7d} label={tr('accounts.rule.cap7d')} testId="accounts-rule-usageCap7d" disabled={busy === 'usageCap7d'} onSave={(v) => void set('usageCap7d', v)} /></Rule>
        <Rule label={tr('accounts.rule.hold')}>{pick('usageCapHoldMin', String(s.usageCapHoldMin), [...new Set([...HOLD_STEPS, s.usageCapHoldMin])].sort((a, b) => a - b).map((m) => ({ value: String(m), label: holdLabel(m) })), (v) => void set('usageCapHoldMin', Number(v)))}</Rule>
        <Rule label={tr('accounts.rule.queue')} hint={tr('accounts.rule.queue.hint')}><Switch checked={s.serializeRequests} disabled={busy === 'serializeRequests'} label={tr('accounts.rule.queue')} testId="accounts-rule-serializeRequests" onChange={(v) => void set('serializeRequests', v)} /></Rule>
        {s.serializeRequests && <Rule label={tr('accounts.rule.delay')}>{pick('serializeDelayMs', String(s.serializeDelayMs), [...new Set([...SERIALIZE_DELAYS, s.serializeDelayMs])].sort((a, b) => a - b).map((ms) => ({ value: String(ms), label: ms === 0 ? tr('accounts.noneF') : tr('accounts.ms', { n: ms }) })), (v) => void set('serializeDelayMs', Number(v)))}</Rule>}
        <Rule label={tr('accounts.rule.usdEur')} hint={tr('accounts.rule.usdEur.hint')}><RateField value={s.usdEur} disabled={busy === 'usdEur'} onSave={(v) => void set('usdEur', v)} /></Rule>
      </div>
      <h2 className={SECTION_TITLE}>{tr('accounts.rules.beta')}</h2>
      <div className={LIST} data-testid="accounts-rules-beta">
        <Rule label={tr('accounts.rule.sessionMonitor')} hint={tr('accounts.rule.sessionMonitor.hint')}><Switch checked={s.sessionMonitor} disabled={busy === 'sessionMonitor'} label={tr('accounts.rule.sessionMonitor')} testId="accounts-rule-sessionMonitor" onChange={(v) => void set('sessionMonitor', v)} /></Rule>
        <Rule label={tr('accounts.rule.commitTokens')} hint={tr('accounts.rule.commitTokens.hint')}><Switch checked={s.commitTokenUsage} disabled={busy === 'commitTokenUsage'} label={tr('accounts.rule.commitTokens')} testId="accounts-rule-commitTokenUsage" onChange={(v) => void set('commitTokenUsage', v)} /></Rule>
      </div>
    </>
  );
}

const RULE_LABEL: Partial<Record<keyof ProxySettings, string>> = {
  rotationStrategy: 'strategy', rotationIntervalMin: 'interval', maxConcurrentPerAccount: 'parallel', usageCap5h: 'cap5h', usageCap7d: 'cap7d', usageCapHoldMin: 'hold', serializeDelayMs: 'delay',
};

function Rule({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className={LIST_ROW}>
      <span className="min-w-0 flex-1">
        <span className="block">{label}</span>
        {hint && <span className="block text-mini leading-snug text-app-text-secondary" data-testid="accounts-rule-hint">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

/** A global cap, any whole percent from 1 to 99; empty is none. Saved on Enter or when the field is left. */
function CapField({ value, label, testId, disabled, onSave }: { value: number | null; label: string; testId: string; disabled: boolean; onSave: (v: number | null) => void }) {
  const tr = useT();
  // Keyed by the value in force (see the callers): a new reading starts a new field.
  const [text, setText] = useState(value === null ? '' : String(value));
  const parsed = capInput(text);
  const commit = () => {
    if (parsed === 'invalid') { setText(value === null ? '' : String(value)); return; }
    if (parsed !== value) onSave(parsed);
  };
  return (
    <span className="flex flex-none items-center gap-1">
      <input
        data-testid={testId}
        aria-label={label}
        aria-invalid={parsed === 'invalid'}
        inputMode="numeric"
        placeholder={tr('accounts.none')}
        disabled={disabled}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        className={`h-[26px] w-16 rounded-sm border bg-elevated px-2 text-right text-compact tabular-nums text-app-text outline-none focus:border-primary @max-2xl:h-9 ${parsed === 'invalid' ? 'border-red-500' : 'border-app-border-light'}`}
      />
      <span className="text-app-text-secondary">%</span>
    </span>
  );
}

function rateText(v: number, locale: string): string {
  return locale === 'it' ? String(v).replace('.', ',') : String(v);
}

/** The dollar to euro rate, saved on Enter or when the field is left. */
function RateField({ value, disabled, onSave }: { value: number; disabled: boolean; onSave: (v: number) => void }) {
  const tr = useT();
  const locale = useLocale();
  const [text, setText] = useState(rateText(value, locale));
  useEffect(() => { setText(rateText(value, locale)); }, [value, locale]);
  const commit = () => {
    const v = Number(text.replace(',', '.'));
    if (Number.isFinite(v) && v > 0 && v <= 10 && v !== value) onSave(v);
    else setText(rateText(value, locale));
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

function Brake({ gates, pace, locale }: { gates: unknown; pace: unknown; locale: string }) {
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
                  {hubProse(c.reason, locale) && <span className="text-app-text-secondary"> · {hubProse(c.reason, locale)}</span>}
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
