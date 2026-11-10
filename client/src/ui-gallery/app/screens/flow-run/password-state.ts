import type { ScreenCtx } from '../../kit';

/** Whether the dialog that changes a robot password is open: kept in the state of the preview. */
export function usePasswordDialog(ctx: ScreenCtx) {
  return ctx.ui<boolean>('flowRun.password.open', false);
}
