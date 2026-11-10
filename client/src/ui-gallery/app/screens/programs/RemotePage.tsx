import { useEffect, useState } from 'react';
import { RemoteControlScreen } from '../../../../ui/programs/RemoteControlScreen';
import type { MaskModel } from '../../../../ui/programs/model';
import { REMOTE_MAX_MINUTES, REMOTE_REASONS, type RemoteReason } from '../../../../ui/fixtures/programs';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { saveHalleyPassword } from './halley-password';
import { INITIAL_PROGRAMS, type RemoteSession } from './state';
import { clock, liveComputers, withDefaults } from './derive';
import { accountingMask, halleyMask, invoiceAt, plainMask } from './masks';

const MAX_MS = REMOTE_MAX_MINUTES * 60_000;

/** A clock that ticks once a second while `active`, so the timer of a session counts down. */
function useTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const first = window.setTimeout(() => setNow(Date.now()), 0);
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { window.clearTimeout(first); window.clearInterval(t); };
  }, [active]);
  return now;
}

const minutesSeconds = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** e02: remote control with the consent of the person at the PC, and a timer. */
export function RemotePage({ ctx }: { ctx: ScreenCtx }) {
  const c = ctx.copy.programs;
  const r = c.remote;
  const [slice, update] = ctx.slice('programs', INITIAL_PROGRAMS);
  const st = withDefaults(slice);
  const rem = st.remote;
  // What is typed into Halley's mask stays in this page: a password is never written to the preview's saved state.
  const [typed, setTyped] = useState('');
  const live = rem.status === 'live';
  const now = useTick(live);
  const left = live && rem.grantedAtMs ? MAX_MS - (now - rem.grantedAtMs) : MAX_MS;
  const computers = liveComputers(st);
  const pc = rem.pc;
  const setRemote = (fn: (s: RemoteSession) => RemoteSession) => update((prev) => {
    const s = withDefaults(prev);
    return { ...s, remote: fn(s.remote) };
  });

  const reasonsFor = (id: string): RemoteReason[] => {
    const own = REMOTE_REASONS.filter((x) => x.pc === id);
    return own.length ? own : [{ id: 'generic', pc: id, label: r.request.reasonGeneric, consent: r.request.consentGeneric, window: 'desktop' }];
  };
  const reasons = reasonsFor(pc);
  const reason = reasons.find((x) => x.id === rem.reason) ?? reasons[0];

  const end = (how: NonNullable<RemoteSession['how']>) => {
    const elapsed = rem.grantedAtMs ? Date.now() - rem.grantedAtMs : 0;
    const minutes = Math.max(1, Math.min(REMOTE_MAX_MINUTES, Math.ceil(elapsed / 60_000)));
    setRemote((s) => ({ ...s, status: 'ended', minutes, how }));
    ctx.log(r.log.ended(pc, minutes, r.ended.how[how]), 'access', P.remoteControl());
    ctx.toast({ tone: 'info', title: r.toast.ended(pc), body: r.toast.endedBody(minutes), action: { label: r.ended.openLog, path: P.settings('registro') } });
    ctx.notify({ title: r.notify.endedTitle(pc), path: P.settings('registro'), tone: 'info' });
  };

  /* A session that reaches its limit ends by itself, and says so. */
  const expired = live && left <= 0;
  useEffect(() => {
    if (expired) end('expired');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `end` is rebuilt every render; the session must end once, when it expires
  }, [expired]);

  const request = () => {
    setRemote((s) => ({ ...s, status: 'asked', reason: reason.id, keyboardBy: 'armonia', passwordAt: undefined }));
    setTyped('');
    ctx.log(r.log.asked(pc), 'access', P.remoteControl());
    ctx.toast({ tone: 'info', title: r.toast.asked(pc), body: r.toast.askedBody });
    ctx.notify({ title: r.notify.askedTitle(pc), body: r.notify.askedBody, path: P.remoteControl(), tone: 'warn', to: ['protocollo'] });
  };

  const canSave = ctx.can('edit:structure');
  const savePassword = () => {
    // The same right as changing the password on the stopped run: whoever lacks it can watch the session, not save.
    if (!canSave) {
      ctx.toast({ tone: 'warn', title: ctx.deniedTitle('edit:structure') ?? r.toast.passwordEmpty });
      return;
    }
    if (!typed) {
      ctx.toast({ tone: 'warn', title: r.toast.passwordEmpty });
      return;
    }
    // The same rule as the dialog on the stopped run: it is the same password.
    if (typed.length < 8) {
      ctx.toast({ tone: 'warn', title: ctx.copy.flowRun.password.tooShort });
      return;
    }
    const at = clock(ctx.now);
    const went = saveHalleyPassword(ctx, { resume: true });
    setTyped('');
    setRemote((s) => ({ ...s, passwordAt: at }));
    ctx.toast({ tone: 'ok', title: r.toast.passwordSaved, body: went > 0 ? r.toast.passwordSavedBody : r.toast.passwordSavedBodyNone });
    ctx.log(r.log.passwordSaved(pc), 'access', P.remoteControl());
  };
  const clearPassword = () => {
    if (!typed) {
      ctx.toast({ tone: 'info', title: r.toast.nothingToCancel });
      return;
    }
    setTyped('');
  };

  const armonia = rem.keyboardBy === 'armonia';
  let mask: MaskModel;
  const buttons = [
    { id: 'cancel', label: r.live.cancelMask, onPress: clearPassword },
    { id: 'save', label: r.live.save, primary: true, onPress: savePassword },
  ];
  if (reason.window === 'halley') mask = halleyMask(ctx.copy, typed, armonia && canSave ? setTyped : undefined, buttons);
  else if (reason.window === 'teamsystem') mask = accountingMask(st.agent.cursor, invoiceAt(st.agent.invoice));
  else if (reason.window === 'qgis') mask = plainMask(ctx.copy, 'QGIS', c.masks.qgisRows);
  else mask = plainMask(ctx.copy, c.masks.explorer, []);

  const windowName = r.desktopWindows[reason.window];
  const who = r.who.person;
  const pcOptions = computers.filter((p) => p.state !== 'too-old').map((p) => ({ value: p.id, label: `${p.id} · ${p.office}` }));

  return (
    <RemoteControlScreen
      copy={ctx.copy}
      status={rem.status}
      pcName={pc}
      windowName={windowName}
      pcOptions={pcOptions}
      onPc={(id) => setRemote((s) => ({ ...s, pc: id, reason: reasonsFor(id)[0].id }))}
      reasonOptions={reasons.map((x) => ({ value: x.id, label: x.label }))}
      reason={reason.id}
      onReason={(id) => setRemote((s) => ({ ...s, reason: id }))}
      onRequest={ctx.allow('edit:structure', request)}
      onCancelAsk={() => {
        setRemote((s) => ({ ...s, status: 'idle' }));
        ctx.toast({ tone: 'info', title: r.toast.cancelled });
        ctx.log(r.log.cancelled(pc), 'access', P.remoteControl());
      }}
      consentReason={reason.consent}
      onAllow={() => {
        setRemote((s) => ({ ...s, status: 'live', grantedAtMs: Date.now(), grantedAt: clock(ctx.now), keyboardBy: 'armonia' }));
        ctx.log(r.log.allowed(pc), 'access', P.remoteControl());
        ctx.toast({ tone: 'ok', title: r.toast.allowed(pc) });
      }}
      onDeny={() => {
        setRemote((s) => ({ ...s, status: 'denied', deniedAt: clock(ctx.now) }));
        ctx.log(r.log.denied(pc), 'access', P.remoteControl());
        ctx.toast({ tone: 'warn', title: r.toast.denied(pc) });
        ctx.notify({ title: r.toast.denied(pc), path: P.remoteControl(), tone: 'warn' });
      }}
      onPersonStop={() => end('person')}
      remainingLabel={minutesSeconds(left)}
      live={live ? {
        consented: r.live.consented(who, rem.grantedAt ?? clock(ctx.now)),
        remaining: minutesSeconds(left),
        mask,
        keyboardBy: rem.keyboardBy,
        note: r.live.passwordNote,
        keyboardLabel: armonia ? r.live.keyboardPerson : r.live.keyboardArmonia,
        keyboardChip: r.live.keyboard(armonia ? r.who.armonia : r.who.person),
        passwordSaved: rem.passwordAt && reason.window === 'halley' ? r.live.saved(rem.passwordAt) : undefined,
      } : undefined}
      onClose={ctx.allow('edit:structure', () => ctx.confirm({
        title: r.live.closeTitle(pc),
        body: r.live.closeBody,
        confirmLabel: r.live.closeConfirm,
        tone: 'danger',
        onConfirm: () => end('closed'),
      }))}
      onKeyboard={() => {
        setRemote((s) => ({ ...s, keyboardBy: s.keyboardBy === 'armonia' ? 'person' : 'armonia' }));
        ctx.log(r.log.keyboard(pc, armonia ? r.who.person : r.who.armonia), 'access', P.remoteControl());
      }}
      denied={rem.deniedAt}
      onAskAgain={() => setRemote((s) => ({ ...s, status: 'idle' }))}
      ended={rem.status === 'ended' ? {
        title: r.ended.title(pc),
        body: r.ended.body(rem.minutes ?? 1),
        rows: [
          [r.ended.summary.how, r.ended.how[rem.how ?? 'closed']],
          [r.ended.summary.start, rem.grantedAt ?? ''],
          [r.ended.summary.log, r.ended.log],
        ],
      } : undefined}
      onOpenLog={() => ctx.go(P.settings('registro'))}
      backLabel={c.common.programs}
      onBack={() => ctx.go(P.programs())}
      requestAllowed={ctx.can('edit:structure')}
      phone={ctx.phone}
    />
  );
}
