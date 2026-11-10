import { KeyRound } from 'lucide-react';
import type { UiCopy } from '../copy/types';
import { Button } from '../primitives/Button';
import { Dialog } from '../primitives/Dialog';
import { TextField } from '../primitives/Field';

/**
 * The new password of a robot's account. It goes to the vault (the keychain of
 * the server), never into the flow: the page says so, and shows only where it
 * is kept.
 */
export function PasswordDialog({ copy, program, user, vault, value, repeat, error, onValue, onRepeat, onSave, onClose }: {
  copy: UiCopy;
  program: string;
  user: string;
  vault: string;
  value: string;
  repeat: string;
  error?: string;
  onValue: (v: string) => void;
  onRepeat: (v: string) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const c = copy.flowRun.password;
  return (
    <Dialog
      title={c.title(program)}
      closeLabel={c.close}
      onClose={onClose}
      size="sm"
      footer={(
        <>
          <Button onClick={onClose}>{c.cancel}</Button>
          <Button variant="primary" icon={KeyRound} onClick={onSave}>{c.save}</Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3 [&_input]:[-webkit-text-security:disc]">
        <p>{c.lead(program, user)}</p>
        <TextField label={c.newPassword} type="text" value={value} onChange={onValue} autoFocus onEnter={onSave} hint={c.where(vault)} />
        <TextField label={c.repeat} type="text" value={repeat} onChange={onRepeat} onEnter={onSave} error={error} />
      </div>
    </Dialog>
  );
}
