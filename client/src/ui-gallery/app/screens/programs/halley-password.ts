/**
 * Saving the Halley robot's new password, from any place that can: the run
 * that stopped (n11), remote control (e02), security (g04) and connections
 * (n16). One write, so the vault every screen reads and the
 * program's last test never tell two different stories.
 */
import { STUCK_RUN } from '../../../../ui/fixtures/flowrun';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { HALLEY_VAULT, vaultSlice } from '../../store/vault';
import { resumeStopped } from '../flow-run/resume';
import { CONNECTIONS_INITIAL, type ConnectionsSlice } from '../team/connectionState';
import { INITIAL_PROGRAMS } from './state';
import { withDefaults } from './derive';

/**
 * `resume`: the robot enters Halley again, so the stopped run and the ones behind it go on now, as the run's
 * banner promises. Off only for the run page, which runs its own retry right after.
 */
/** Returns how many stopped runs went on (0 without `resume`, or when none was stopped any more). */
export function saveHalleyPassword(ctx: ScreenCtx, { resume }: { resume: boolean }): number {
  const [, setVault] = vaultSlice(ctx);
  const [, update] = ctx.slice('programs', INITIAL_PROGRAMS);
  setVault((v) => ({ ...v, [HALLEY_VAULT]: ctx.now }));
  update((prev) => {
    const s = withDefaults(prev);
    // A failed test of Halley was about the old password: it no longer describes the program.
    const { halley: _old, ...checks } = s.checks;
    return { ...s, checks };
  });
  // The password is the robot's login: with it saved, Halley's connection is on again, even if someone had disconnected it.
  const [, setConns] = ctx.slice<ConnectionsSlice>('connections', CONNECTIONS_INITIAL);
  setConns((prev) => ({ ...prev, states: { ...prev.states, halley: { state: 'connected', at: ctx.now, by: ctx.persona.id } } }));
  if (!resume) return 0;
  const r = ctx.copy.flowRun.run;
  const went = resumeStopped(ctx, STUCK_RUN.flow, STUCK_RUN.id, { run: r.eventResumed('Halley'), freed: r.eventResumed('Halley') }, 'Halley');
  const total = (went.stopped ? 1 : 0) + went.freed;
  if (total > 0) ctx.notify({ title: r.resumedNotice('Halley'), body: r.resumedNoticeBody(total), path: P.flowRun(STUCK_RUN.flow, STUCK_RUN.id), tone: 'ok' });
  return total;
}
