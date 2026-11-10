/**
 * The robots' passwords in the vault (the server's keychain): for each
 * reference, when it was last saved. The preview never keeps a password.
 *
 * WHY ONE STORE. The Halley robot's password is one fact that six places tell:
 * the run that stopped (n11) and its step, the programs list (w06), remote
 * control (e02), security (g04), connections (n16), the sidebar strip. When each kept its own
 * copy, saving it in one place left the others saying the robot was still
 * stopped. Every place that saves it writes here, every place that asks reads
 * here.
 */
import type { ScreenCtx } from '../kit';

export type Vault = Record<string, string>;

/** The slice name: older saves of the preview already hold it under this name. */
export const VAULT_SLICE = 'flowRunVault';

export const HALLEY_VAULT = 'halley/robot.protocollo';

/** The vault and its setter. Not a hook (ctx.slice reads the store), so event handlers may call it too. */
export function vaultSlice(ctx: ScreenCtx) {
  return ctx.slice<Vault>(VAULT_SLICE, {});
}

/** When the Halley robot's password was last saved (ISO); empty while it is still the one Halley changed on 05/11. */
export const halleyPasswordSavedAt = (vault: Vault | undefined): string => vault?.[HALLEY_VAULT] ?? '';
