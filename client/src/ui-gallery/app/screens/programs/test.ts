import { COMPUTERS, type ProgramSeed } from '../../../../ui/fixtures/programs';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { INITIAL_PROGRAMS } from './state';
import { clock, withDefaults } from './derive';
import { halleyPasswordSavedAt, vaultSlice } from '../../store/vault';

/** The id of the job that tests or connects a program. */
export const testJobId = (id: string) => `programs.test.${id}`;

/** Why a program cannot be connected yet: the PC it needs is too old for the agent. */
function blockingPc(seed: ProgramSeed): string | undefined {
  return COMPUTERS.find((p) => p.tooOld && seed.access.some((a) => a.key === 'pc' && a.value === p.id))?.id;
}

/** Starts the test of a program, or its first connection when it is not connected yet. */
export function runTest(ctx: ScreenCtx, seed: ProgramSeed, connecting: boolean) {
  const c = ctx.copy.programs;
  const [, update] = ctx.slice('programs', INITIAL_PROGRAMS);
  // Halley refuses the robot until the new password is saved: the login step (the second) fails, as in the stopped run (n11).
  const passwordOld = seed.id === 'halley' && !halleyPasswordSavedAt(vaultSlice(ctx)[0]);
  const labels = connecting ? c.list.connectSteps[seed.connection] : c.list.steps[seed.connection];
  const blocked = connecting ? blockingPc(seed) : undefined;
  const steps = labels.map((label, i) => ({ label, ms: 650 + i * 120, fails: (blocked !== undefined && i === labels.length - 1) || (passwordOld && i === 1) }));
  ctx.startJob({
    id: testJobId(seed.id),
    title: connecting ? c.list.jobConnect(seed.name) : c.list.jobTest(seed.name),
    steps,
    onDone: (ok) => {
      const at = clock(ctx.now);
      const why = ok ? undefined : passwordOld ? c.list.failedPassword : c.list.failedPc(blocked ?? '');
      update((prev) => {
        const s = withDefaults(prev);
        return { ...s, checks: { ...s.checks, [seed.id]: { at, ok, why } }, connected: ok && connecting ? { ...s.connected, [seed.id]: at } : s.connected };
      });
      if (ok) {
        ctx.toast({ tone: 'ok', title: connecting ? c.list.toastConnected(seed.name) : c.list.toastTested(seed.name) });
        ctx.log(connecting ? c.list.log.connected(seed.name) : c.list.log.tested(seed.name), 'structure', P.program(seed.id));
      } else {
        ctx.toast({ tone: 'error', title: c.list.toastFailed(seed.name), body: why, action: passwordOld ? { label: c.list.savePassword, path: P.remoteControl() } : { label: c.list.toastFailedBody, path: P.agents() } });
        ctx.log(c.list.log.failed(seed.name, why ?? ''), 'structure', P.program(seed.id));
        ctx.notify({ title: c.list.toastFailed(seed.name), body: why, path: P.program(seed.id), tone: 'error' });
      }
    },
  });
}
