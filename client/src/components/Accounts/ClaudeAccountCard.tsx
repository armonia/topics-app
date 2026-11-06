/**
 * The card of a Claude account of the proxy in «Account e quote»
 * (hub-smistamento, HUBBR-10 and HUBBR-11), with the proxy's commands: use
 * this one, priority up and down, its own cap, renew the token, on and off,
 * remove. Under the bars what the hub's page also drew: the window's
 * attribution (through the proxy or outside it) and trend, the pace dial and
 * the forecast, the 24 hours and the per-model windows, the bonus, the login
 * and who spent the last 24 hours.
 */
import { useRef, useState } from 'react';
import { ArrowDown, ArrowLeftRight, ArrowUp, Gauge, LogIn, Minus, MoreHorizontal, Plus, Power, RefreshCw, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { useConfirm } from '../../hooks/useConfirm';
import { Menu } from '../Shared/Menu';
import { DANGER_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import { capInput, weekElapsedPct, type AccountCommand, type ClaudeAccount, type QuotaWindow } from '../../lib/accountQuotas';
import type { AccountTrail, BoardAccount } from '../../lib/accountInsights';
import { BUTTON, Bar, CHIP, CHIP_TONE, CardHead, CardShell, ICON_BUTTON, MenuItem, type Run, type Tr } from './accountCardParts';
import type { Clock } from './useAccountClock';
import { AccessAndSpend, BoardExtras, TrailLegend, WindowTrail } from './AccountInsights';

/** The priority's own steps: smaller than a command button, beside the number. */
const STEP_BUTTON = 'inline-flex h-[20px] w-[20px] items-center justify-center rounded-xs border border-app-border-light bg-elevated text-app-text-secondary hover:bg-app-hover hover:text-app-text disabled:opacity-50 coarse:h-8 coarse:w-8';

const STATE_TONE: Record<ClaudeAccount['state'], keyof typeof CHIP_TONE> = {
  'in-use': 'use', ready: 'quiet', off: 'quiet', capped: 'warn', limited: 'warn', expired: 'bad',
};

function resetCaption(fiveH: QuotaWindow | null, week: QuotaWindow | null, tr: Tr, clock: Clock): string {
  return [
    fiveH?.resetsAtMs ? tr('accounts.reset.fiveH', { time: clock.time(fiveH.resetsAtMs) }) : null,
    week?.resetsAtMs ? tr('accounts.reset.week', { when: clock.dayTime(week.resetsAtMs) }) : null,
  ].filter(Boolean).join(' · ');
}

/**
 * A Claude account of the proxy: its bars with the cap, the tick and, under
 * each, how much of the window went through the proxy and its trend; the
 * hub's pace, forecast and extra windows; the proxy's commands.
 */
export function ClaudeCard({ account: a, trail, readAt, board, money, run, clock }: {
  account: ClaudeAccount; trail: AccountTrail | null; readAt: number; board: BoardAccount | null; money: (usd: number) => string; run: Run; clock: Clock;
}) {
  const tr = useT();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [editCap, setEditCap] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const act = async (c: AccountCommand) => { setMenu(false); setBusy(true); await run(c); setBusy(false); };
  // The reset is the answer to «when does it come back»: under every state, as the hub had it.
  const reset = resetCaption(a.fiveH, a.week, tr, clock);
  const caption = a.state === 'in-use' || a.state === 'ready' ? reset : [tr(`accounts.caption.${a.state}`), reset].filter(Boolean).join(' ');
  const notes = accountNotes(a, tr, clock);

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
        chip={(
          <span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
            <AccountChips account={a} />
          </span>
        )}
      />
      {a.fiveH && <Bar label={tr('accounts.bar.fiveH')} pct={a.fiveH.pct} cap={a.cap.fiveH} testId="account-bar-5h" />}
      {a.fiveH && trail && <WindowTrail window={trail.fiveH} trend={trail.history5h} span="fiveH" readAt={readAt} money={money} />}
      <Bar label={tr('accounts.bar.week')} pct={a.week?.pct ?? null} cap={a.cap.week} mark={weekElapsedPct(a.week?.resetsAtMs ?? null)} testId="account-bar-week" />
      {trail && <WindowTrail window={trail.week} trend={trail.historyWeek} span="week" readAt={readAt} money={money} />}
      {trail && (a.fiveH || a.week) && <TrailLegend />}
      {board && <BoardExtras board={board} />}
      {!a.fiveH && !a.week && <div className="mt-1 text-app-text-secondary" data-testid="account-no-windows">{tr(a.dormant ? 'accounts.dormant' : 'accounts.noLimits')}</div>}
      <div className={`mb-[9px] mt-1 min-h-[17px] leading-snug tabular-nums ${a.state === 'expired' ? DANGER_TEXT : 'text-app-text-secondary'}`} data-testid="account-caption">{caption}</div>
      {notes.map((n) => (
        <div key={n.key} className={`mb-1.5 leading-snug ${n.bad ? DANGER_TEXT : WARNING_TEXT}`} data-testid="account-note" data-note={n.key}>{n.text}</div>
      ))}
      {editCap && <CapEditor account={a} onDone={() => setEditCap(false)} run={run} />}
      <div className="mt-auto flex items-center gap-1.5">
        {a.state === 'expired'
          ? <button type="button" disabled={busy} data-testid="account-card-refresh" className={BUTTON} onClick={() => void act({ kind: 'refresh', name: a.name })}><RefreshCw size={12} aria-hidden="true" />{tr('accounts.cmd.refresh')}</button>
          : !a.active && !a.disabled && <button type="button" disabled={busy} data-testid="account-card-use" className={BUTTON} onClick={() => void act({ kind: 'switch', name: a.name })}><ArrowLeftRight size={12} aria-hidden="true" />{tr('accounts.cmd.use')}</button>}
        {a.disabled && <button type="button" disabled={busy} data-testid="account-card-on" className={BUTTON} onClick={() => void act({ kind: 'enabled', name: a.name, enabled: true })}><Power size={12} aria-hidden="true" />{tr('accounts.cmd.on')}</button>}
        <span className="flex-1" />
        <span className="flex flex-none items-center gap-1 whitespace-nowrap text-app-text-secondary tabular-nums" title={tr('accounts.priority.hint')} data-testid="account-priority" data-priority={a.priority}>
          {tr('accounts.priority.label')}
          <button type="button" disabled={busy} data-testid="account-priority-down" aria-label={tr('accounts.cmd.down')} title={tr('accounts.cmd.down')} className={STEP_BUTTON} onClick={() => void act({ kind: 'priority', name: a.name, priority: a.priority - 1 })}><Minus size={11} aria-hidden="true" /></button>
          <b className="min-w-[14px] text-center font-semibold text-app-text">{a.priority}</b>
          <button type="button" disabled={busy} data-testid="account-priority-up" aria-label={tr('accounts.cmd.up')} title={tr('accounts.cmd.up')} className={STEP_BUTTON} onClick={() => void act({ kind: 'priority', name: a.name, priority: a.priority + 1 })}><Plus size={11} aria-hidden="true" /></button>
        </span>
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
          <MenuItem icon={Trash2} testId="account-cmd-remove" danger onClick={() => void remove()}>{tr('accounts.cmd.remove')}</MenuItem>
        </Menu>
      </div>
      {board && <AccessAndSpend board={board} />}
    </CardShell>
  );
}

/** The state chip, and beside it what the state alone hides: the cap reached on the account in use, the proxy's block, the pace to the limit. */
function AccountChips({ account: a }: { account: ClaudeAccount }) {
  const tr = useT();
  const stateKey = a.state === 'limited' && a.lastResort ? 'lastResort' : a.state;
  const tone = a.state === 'limited' && a.lastResort ? 'warn' : STATE_TONE[a.state];
  const extra: Array<{ key: string; text: string; tone: keyof typeof CHIP_TONE; title?: string }> = [];
  if (a.state === 'in-use' && a.cap.over) extra.push({ key: 'capped', text: tr('accounts.chip.capped'), tone: 'warn' });
  if (a.block === 'extra-usage') extra.push({ key: 'extra', text: tr('accounts.chip.extraUsage'), tone: 'bad' });
  if (a.block === 'permission') extra.push({ key: 'permission', text: tr('accounts.chip.permission'), tone: 'bad' });
  if (a.minutesToLimit !== null) {
    const m = a.minutesToLimit;
    const text = m <= 0 ? tr('accounts.speed.at') : m < 300 ? tr('accounts.speed.in', { when: minutesWords(m, tr) }) : tr('accounts.speed.far');
    extra.push({ key: 'speed', text, tone: m < 300 ? 'bad' : 'quiet', title: tr('accounts.speed.hint') });
  }
  return (
    <>
      {extra.map((c) => <span key={c.key} className={`${CHIP} ${CHIP_TONE[c.tone]}`} title={c.title} data-testid="account-chip" data-chip={c.key}>{c.text}</span>)}
      <span className={`${CHIP} ${CHIP_TONE[tone]}`} data-testid="account-chip" data-chip={stateKey}>{a.state === 'in-use' && <Gauge size={11} aria-hidden="true" />}{tr(`accounts.chip.${stateKey}`)}</span>
    </>
  );
}

/** «circa 40 min», «circa 2 h 10 min», to the nearest ten minutes as the proxy's guess deserves. */
function minutesWords(m: number, tr: Tr): string {
  const r = Math.max(10, Math.round(m / 10) * 10);
  return r < 60 ? tr('accounts.minutes', { n: r }) : tr('accounts.hoursMinutes', { h: Math.floor(r / 60), m: r % 60 });
}

/** The proxy's sentences on an account: why it is blocked and until when, the models paused on it. */
function accountNotes(a: ClaudeAccount, tr: Tr, clock: Clock): Array<{ key: string; text: string; bad: boolean }> {
  const out: Array<{ key: string; text: string; bad: boolean }> = [];
  const back = a.retryAfterMs !== null ? ` ${tr('accounts.block.back', { when: clock.dayTime(a.retryAfterMs) })}` : '';
  if (a.block === 'extra-usage') out.push({ key: 'extra', text: tr('accounts.block.extraUsage'), bad: true });
  else if (a.block === 'permission') out.push({ key: 'permission', text: tr('accounts.block.permission'), bad: true });
  else if (a.block && a.block !== 'auth' && a.state !== 'off') {
    const text = a.lastResort ? tr(a.block === 'quota-5h' ? 'accounts.block.lastResort5h' : 'accounts.block.lastResortWeek') : tr(`accounts.block.${a.block}`);
    out.push({ key: a.block, text: text + back, bad: !a.lastResort });
  }
  if (a.modelBlocks.length > 0 && a.state !== 'off') {
    const list = a.modelBlocks.map((b) => (b.untilMs !== null ? tr('accounts.model.until', { model: b.label, when: clock.dayTime(b.untilMs) }) : b.label)).join(', ');
    out.push({ key: 'model-pause', text: tr('accounts.model.paused', { list }), bad: false });
  }
  return out;
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

