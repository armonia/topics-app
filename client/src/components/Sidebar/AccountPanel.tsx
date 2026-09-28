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
 *   1. WHO: the face and the name, one row that opens your profile, and
 *      underneath the address you are signed in with, or, in as many words,
 *      that no account is linked. With no account service, the name alone.
 *   2. THE WAY IN, when there is no account and this installation has a service
 *      to ask: the address, then the code that arrives by email. Both steps
 *      happen HERE, without the panel closing and without a trip to Settings.
 *   3. SIGNING OUT, when signed in: the one door this panel still owns.
 *
 * ── WHAT IT NO LONGER SAYS ──────────────────────────────────────────────────
 * No «Account» heading over the name, which only labelled what the face and
 * the name already are. No «Open your profile» row: the name row is that door.
 * No device anywhere in it, neither the «From this device» row nor the device
 * under the name: the devices are a level of their own in `ProfileMenu`, which
 * lists the computer first and marks the one you are on.
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
import { KeyRound, LogIn, Mail, ShieldCheck } from 'lucide-react';
import { useT } from '@/hooks/useT';
import { useConfirm } from '@/hooks/useConfirm';
import { useToast } from '@/components/Shared/Toast';
import { useAccountLink } from '@/hooks/useAccountLink';
import { mostraSezione as accountIsAThingHere } from '@/components/Settings/accountState';
import type { LabelIdentity } from './identityLabel';

const FIELD = 'w-full min-w-0 rounded border border-app-border bg-app-bg px-2 py-1.5 text-compact text-app-text outline-none focus:border-app-accent';
const PRIMARY = 'flex w-full items-center justify-center gap-1.5 rounded border border-primary bg-primary/10 px-2 py-1.5 text-compact font-medium text-primary hover:bg-primary/20 disabled:opacity-50';
const QUIET = 'flex-shrink-0 rounded px-2 py-1 text-mini text-app-text-tertiary hover:bg-app-hover';

export function AccountPanel({ who, onOpenProfile }: {
  who: LabelIdentity;
  /** THE NAME ROW IS THE DOOR NOW. It used to sit next to a "Open your
   *  profile" row a few pixels below, which pointed at exactly what the
   *  face and the name already are - a person presses the name, not a
   *  second sentence explaining what pressing it would do. */
  onOpenProfile: () => void;
}) {
  const t = useT();
  const askConfirm = useConfirm();
  const toast = useToast();
  const {
    state, step, email, code, error, busy,
    setEmail, setCode, askCode, verify, back, unlink,
  } = useAccountLink();

  const signOut = useCallback(async () => {
    if (!await askConfirm({ title: t('account.unlink'), body: t('account.unlinkConfirm') })) return;
    // A REFUSED SIGN-OUT HAS TWO PLACES TO LAND, and it needs both. The row
    // below draws it while the panel is open; but the pointer that presses the
    // confirmation falls outside this popover, and `useDismissable` closes it
    // in the capture phase, so on a refusal the panel is frequently already
    // gone. The toast outlives it, and it is the same phrase.
    const refused = await unlink();
    if (refused) toast.error(t(refused));
  }, [askConfirm, t, toast, unlink]);

  const speaksOfAccounts = accountIsAThingHere(state);
  const linked = !!state?.linked;

  return (
    <>
      {/* 1. WHO. The face is bigger than the chip's, because this is the place
             you come to check you are the person you think you are, AND it is
             the door to the profile: a name you can already read does not
             also need a sentence below it telling you to click it. */}
      <button
        type="button"
        onClick={onOpenProfile}
        data-testid="account-identity"
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-app-hover transition-colors"
      >
        {who.avatarUrl
          ? <img src={who.avatarUrl} alt="" className="h-8 w-8 flex-shrink-0 rounded-full object-cover" />
          : <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary text-compact font-semibold leading-none text-white">
              {who.iniziali || '?'}
            </span>}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-prose font-medium text-app-text">{who.nome}</span>
          {/* The second line is the ACCOUNT, where the word means something.
              Where it does not, the name stands alone: this line used to fall
              back to the device you are on («This computer», «iPad»), which
              is the row the devices level draws with «you are here», one
              gesture away. On the free plan, the only one where this line was
              drawn, that made the device the one thing the menu said twice. */}
          {speaksOfAccounts && (
            <span className={`flex min-w-0 items-center gap-1 text-mini ${linked ? 'text-app-text-secondary' : 'text-app-text-muted'}`}>
              {linked
                ? <ShieldCheck size={11} className="flex-shrink-0 text-app-text-muted" />
                : <Mail size={11} className="flex-shrink-0 text-app-text-muted" />}
              <span data-testid="account-line" className="truncate">
                {linked ? state?.email ?? '' : t('account.notLinked')}
              </span>
            </span>
          )}
        </span>
      </button>

      {/* 2. THE WAY IN. Only with a service to ask and nobody signed in: two
             steps, and the second one keeps the address in sight. */}
      {speaksOfAccounts && !linked && (
        <div data-testid="account-signin" className="border-t border-app-border px-3 py-2.5">
          {step.phase === 'address' ? (
            <div className="space-y-1.5">
              <p className="text-mini leading-snug text-app-text-tertiary">{t('statusBar.account.why')}</p>
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
              <p className="text-mini leading-snug text-app-text-tertiary">
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
        </div>
      )}

      {/* THE REASON SITS OUTSIDE THE WAY IN, and that is the whole fix: it used
          to be drawn inside the `!linked` block, so it existed only while
          nobody was signed in. A failed sign-out leaves you signed in by
          definition, hence the one case where the sentence was needed was the
          one case where the block that held it was not rendered. */}
      {error && (
        <p data-testid="account-error" className="border-t border-app-border px-3 py-2 text-mini leading-snug text-red-500">
          {t(error)}
        </p>
      )}

      {/* The link holds with the service unreachable, and that is said out loud
          rather than leaving a person to read the silence as a fault. */}
      {linked && state && !state.configured && (
        <p className="border-t border-app-border px-3 py-2 text-mini leading-snug text-app-text-tertiary">
          {t('account.offline')}
        </p>
      )}

      {/* 3. THE DOOR. Signing out is the one door this panel still owns: the
             other two (the profile, the devices) moved to the name row and to
             their own submenu. */}
      {linked && (
        <div className="border-t border-app-border py-1">
          <button
            onClick={() => void signOut()}
            disabled={busy}
            data-testid="account-signout"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-compact text-app-text-secondary hover:bg-app-hover disabled:opacity-50 coarse:min-h-11"
          >
            <span className="truncate">{t('account.unlink')}</span>
          </button>
        </div>
      )}
    </>
  );
}
