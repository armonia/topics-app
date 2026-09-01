/**
 * THE PANEL BEHIND THE FIRST CHIP: an ACCOUNT, not "your profile".
 *
 * ── WHAT IT USED TO BE, AND WHY THAT WAS NOT ENOUGH ─────────────────────────
 * The chip opened a small card that repeated the name already written on the
 * chip and then listed whatever happened to be known at that moment: the
 * machine, the work summary, the device count. All of it true, none of it an
 * answer to the question people actually bring to that corner of a screen,
 * which every other application answers there: WHO AM I SIGNED IN AS, and how
 * do I sign in. On an installation with no account linked the panel never
 * mentioned that an account existed at all: the only way in was three clicks
 * deep in Settings, on a page you had to already know about.
 *
 * ── SO IT IS AN ACCOUNT PANEL NOW, IN THIS ORDER ────────────────────────────
 *   1. WHO: the face, the name, and underneath the address you are signed in
 *      with, or, in as many words, that no account is linked.
 *   2. THE WAY IN, when there is no account and this installation has a service
 *      to ask: the address, then the code that arrives by email. Both steps
 *      happen HERE, without the panel closing and without a trip to Settings.
 *   3. THE FACTS, each with its own label: the device you are on, what is
 *      running right now, how many devices are authorised. A row with nothing
 *      to say is not drawn, and neither is the block when they are all empty:
 *      a label next to a blank is the filler this redesign was asked to remove.
 *   4. THE DOORS: your profile, the devices, and signing out when signed in.
 *
 * ── ONE VERB, NOT TWO ───────────────────────────────────────────────────────
 * There is no "register" button next to a "log in" button. The service sends a
 * code to an address whether or not it already knew it, so offering the choice
 * would be asking the person a question only the server can answer, and getting
 * it wrong costs them the flow.
 *
 * ── AND WITH NO ACCOUNT SERVICE THE PANEL SAYS NOTHING ABOUT ACCOUNTS ───────
 * No form, no "not available here", no apology: the free plan is the product,
 * not a mutilated version to excuse in a dropdown. The panel is then exactly
 * the local identity card, which on such an installation is the whole truth.
 * It is the rule `mostraSezione` already applies in Settings, imported rather
 * than restated.
 */
import { useCallback } from 'react';
import { Hourglass, KeyRound, LogIn, Mail, ShieldCheck } from 'lucide-react';
import { useT } from '@/hooks/useT';
import { useConfirm } from '@/hooks/useConfirm';
import { useAccountLink } from '@/hooks/useAccountLink';
import { mostraSezione as accountIsAThingHere } from '@/components/Settings/accountState';
import { SEGNALE_ATTESA as WAITING_INK } from './chromeSignals';
import type { LabelIdentity } from './identityLabel';

/** A glyph component, taken as a prop: which device you are on is decided by
 *  the row above, and passing the icon beats deciding it twice. */
type Glyph = React.ComponentType<{ size?: number; className?: string }>;

/** The one-line facts the sidebar row already holds: they are computed up
 *  there for the chip, and passing them down beats asking for them twice. */
export interface LocalFacts {
  /** The device you are on. Empty until the session says which one. */
  device: string;
  /** What is running right now, `null` when nothing is. */
  now: string | null;
  /** Authorised devices, `null` while unknown. */
  devices: { connected: number; total: number } | null;
  /** The fleet, spelled out: on the chip it is a glyph and a digit, and this
   *  is where "what is this hourglass" gets its sentence. Empty when nothing
   *  is waiting. */
  waiting: string[];
}

const FIELD = 'w-full min-w-0 rounded border border-app-border bg-app-bg px-2 py-1.5 text-[12px] text-app-text outline-none focus:border-app-accent';
const PRIMARY = 'flex w-full items-center justify-center gap-1.5 rounded border border-primary bg-primary/10 px-2 py-1.5 text-[11.5px] font-medium text-primary hover:bg-primary/20 disabled:opacity-50';
const QUIET = 'flex-shrink-0 rounded px-2 py-1 text-[11px] text-app-text-tertiary hover:bg-app-hover';

export function AccountPanel({ who, DeviceIcon, facts, doors }: {
  who: LabelIdentity;
  DeviceIcon: Glyph;
  facts: LocalFacts;
  /** Drawn last, under a rule: the ways out of the panel. */
  doors: React.ReactNode;
}) {
  const t = useT();
  const askConfirm = useConfirm();
  const {
    state, step, email, code, error, busy,
    setEmail, setCode, askCode, verify, back, unlink,
  } = useAccountLink();

  const signOut = useCallback(async () => {
    if (!await askConfirm({ title: t('account.unlink'), body: t('account.unlinkConfirm') })) return;
    await unlink();
  }, [askConfirm, t, unlink]);

  const speaksOfAccounts = accountIsAThingHere(state);
  const linked = !!state?.linked;
  const anyFact = (speaksOfAccounts && !!facts.device)
    || !!facts.now
    || facts.waiting.length > 0
    || (facts.devices?.total ?? 0) > 0;

  return (
    <>
      {/* 1. WHO. The face is bigger than the chip's, because this is the place
             you come to check you are the person you think you are. */}
      <div data-testid="account-identity" className="flex items-center gap-2.5 px-3 py-2.5">
        {who.avatarUrl
          ? <img src={who.avatarUrl} alt="" className="h-8 w-8 flex-shrink-0 rounded-full object-cover" />
          : <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary text-[12px] font-semibold leading-none text-white">
              {who.iniziali || '?'}
            </span>}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[12.5px] font-medium text-app-text">{who.nome}</span>
          {/* The second line is the ACCOUNT where the word means something, and
              the device where it does not: never both, and never a blank. */}
          {speaksOfAccounts
            ? (
              <span className={`flex min-w-0 items-center gap-1 text-[11px] ${linked ? 'text-app-text-secondary' : 'text-app-text-muted'}`}>
                {linked
                  ? <ShieldCheck size={11} className="flex-shrink-0 text-app-text-muted" />
                  : <Mail size={11} className="flex-shrink-0 text-app-text-muted" />}
                <span data-testid="account-line" className="truncate">
                  {linked ? state?.email ?? '' : t('account.notLinked')}
                </span>
              </span>
            )
            : who.dettaglio && (
              <span className="flex min-w-0 items-center gap-1 text-[11px] text-app-text-muted">
                <DeviceIcon size={11} className="flex-shrink-0" />
                <span className="truncate">{who.dettaglio}</span>
              </span>
            )}
        </span>
      </div>

      {/* 2. THE WAY IN. Only with a service to ask and nobody signed in: two
             steps, and the second one keeps the address in sight. */}
      {speaksOfAccounts && !linked && (
        <div data-testid="account-signin" className="border-t border-app-border px-3 py-2.5">
          {step.phase === 'address' ? (
            <div className="space-y-1.5">
              <p className="text-[11px] leading-snug text-app-text-tertiary">{t('statusBar.account.why')}</p>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void askCode(); }}
                aria-label={t('account.emailLabel')}
                placeholder={t('account.emailPlaceholder')}
                data-testid="account-email"
                className={FIELD}
              />
              <button
                disabled={busy || !email.trim()}
                onClick={() => void askCode()}
                data-testid="account-send-code"
                className={PRIMARY}
              >
                <LogIn size={12} />
                {t('statusBar.account.signIn')}
              </button>
            </div>
          ) : (
            <div className="space-y-1.5">
              <p className="text-[11px] leading-snug text-app-text-tertiary">
                {t('account.codeSent', { email: step.email })}
              </p>
              <input
                autoFocus
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void verify(); }}
                aria-label={t('account.codeLabel')}
                placeholder={t('account.codePlaceholder')}
                data-testid="account-code"
                className={FIELD}
              />
              <div className="flex items-center gap-1.5">
                <button
                  disabled={busy || !code.trim()}
                  onClick={() => void verify()}
                  data-testid="account-verify"
                  className={PRIMARY}
                >
                  <KeyRound size={12} />
                  {t('account.confirm')}
                </button>
                <button onClick={back} className={QUIET}>{t('account.cancel')}</button>
              </div>
            </div>
          )}
          {error && <p data-testid="account-error" className="mt-1.5 text-[11px] text-red-500">{t(error)}</p>}
        </div>
      )}

      {/* The link holds with the service unreachable, and that is said out loud
          rather than leaving a person to read the silence as a fault. */}
      {linked && state && !state.configured && (
        <p className="border-t border-app-border px-3 py-2 text-[11px] leading-snug text-app-text-tertiary">
          {t('account.offline')}
        </p>
      )}

      {/* 3. THE FACTS. */}
      {anyFact && (
        <div className="border-t border-app-border px-3 py-2 text-[11px]">
          {speaksOfAccounts && facts.device && (
            <Fact label={t('statusBar.me.machine')}>
              <DeviceIcon size={11} className="flex-shrink-0 text-app-text-muted" />
              <span className="truncate">{facts.device}</span>
            </Fact>
          )}
          {facts.now && (
            <Fact label={t('statusBar.me.workRow')}>
              <span className="truncate">{facts.now}</span>
            </Fact>
          )}
          {facts.waiting.length > 0 && (
            <Fact label={t('statusBar.agents.heading')}>
              <Hourglass size={11} className={`flex-shrink-0 ${WAITING_INK}`} />
              <span className="truncate">{facts.waiting.join(', ')}</span>
            </Fact>
          )}
          {facts.devices && facts.devices.total > 0 && (
            <Fact label={t('statusBar.me.devicesRow')}>
              <span className="tabular-nums">
                {t('statusBar.me.devicesCount', { n: facts.devices.connected, tot: facts.devices.total })}
              </span>
            </Fact>
          )}
        </div>
      )}

      {/* 4. THE DOORS. Signing out sits with them and not next to the address:
             it is a way out of the panel like the others, and a destructive
             button inside the identity card gets pressed while aiming at the
             name. */}
      <div className="border-t border-app-border py-1">
        {doors}
        {linked && (
          <button
            onClick={() => void signOut()}
            disabled={busy}
            data-testid="account-signout"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11.5px] text-app-text-secondary hover:bg-app-hover disabled:opacity-50 coarse:min-h-11"
          >
            <span className="truncate">{t('account.unlink')}</span>
          </button>
        )}
      </div>
    </>
  );
}

/** A label and its value on one line. The label is the word the closed chip
 *  had no room to spell out. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="flex-shrink-0 text-app-text-muted">{label}</span>
      <span className="ml-auto flex min-w-0 items-center gap-1 text-app-text-secondary">{children}</span>
    </div>
  );
}
