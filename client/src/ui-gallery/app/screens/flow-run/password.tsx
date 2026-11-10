/**
 * The dialog that changes a robot's password. The new password goes to the
 * vault (the server's keychain): the preview keeps only that it was changed
 * and when, never the password itself.
 */
import { useState } from 'react';
import type { ScreenCtx } from '../../kit';
import { PasswordDialog } from '../../../../ui/flowrun/PasswordDialog';
import { HALLEY_VAULT, vaultSlice } from '../../store/vault';
import { saveHalleyPassword } from '../programs/halley-password';
import { usePasswordDialog } from './password-state';

export function PasswordHost({ ctx, program, user, vault, onSaved }: {
  ctx: ScreenCtx;
  program: string;
  user: string;
  vault: string;
  /** Called once the vault holds the new password, e.g. to try the run again. */
  onSaved?: () => void;
}) {
  const c = ctx.copy.flowRun.password;
  const [open, setOpen] = usePasswordDialog(ctx);
  const [, setVault] = vaultSlice(ctx);
  // The password itself is typed into local state: it is never written to the persisted state of the preview.
  const [value, setValue] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  if (!open) return null;
  const close = () => { setOpen(false); setValue(''); setRepeat(''); setError(''); };
  const save = () => {
    if (value.length < 8) { setError(c.tooShort); return; }
    if (value !== repeat) { setError(c.mismatch); return; }
    // Halley's goes through the one write every other screen uses, so Programmi and the sidebar see it too.
    // Without a retry of its own to run (the run page has one), saving lets the stopped runs go on at once.
    let went = 0;
    if (vault === HALLEY_VAULT) went = saveHalleyPassword(ctx, { resume: !onSaved });
    else setVault((v) => ({ ...v, [vault]: ctx.now }));
    ctx.log(ctx.copy.flowRun.screen.logPassword(program), 'access');
    ctx.toast({ tone: 'ok', title: c.saved(program), body: went > 0 ? c.savedResumedBody(program) : c.savedBody });
    close();
    onSaved?.();
  };
  return (
    <PasswordDialog
      copy={ctx.copy}
      program={program}
      user={user}
      vault={vault}
      value={value}
      repeat={repeat}
      error={error || undefined}
      onValue={(v) => { setValue(v); setError(''); }}
      onRepeat={(v) => { setRepeat(v); setError(''); }}
      onSave={save}
      onClose={close}
    />
  );
}
