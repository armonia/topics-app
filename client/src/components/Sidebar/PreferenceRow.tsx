import type { ReactNode } from 'react';
import { Switch } from '../Shared/Switch';

/**
 * ONE PREFERENCE, ONE LINE: its name on the left, the control on the right.
 *
 * The levels of the user menu (appearance, notifications, view) are lists of
 * these. A preference that needs more than this line (a key, a URL, a code)
 * does not belong in the menu: it stays in the Settings panel.
 *
 * 44px under a finger, like every row of the menus (`menuRowClass`).
 */
export function PreferenceRow({ label, hint, children, testId, icon }: {
  label: string;
  /** A short second line, for the one preference that needs a gloss. */
  hint?: ReactNode;
  children: ReactNode;
  testId?: string;
  icon?: ReactNode;
}) {
  return (
    <div data-testid={testId} className="flex items-center gap-2 px-3 py-1 text-compact text-app-text coarse:min-h-11 coarse:text-body-lg">
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {hint && <span className="block text-mini leading-snug text-app-text-muted">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

/** A preference that is on or off: the row and the app's switch. */
export function SwitchRow({ label, hint, checked, onChange, disabled, testId }: {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  /** On the switch itself, which is what a person (and a spec) presses. */
  testId?: string;
}) {
  return (
    <PreferenceRow label={label} hint={hint}>
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} testId={testId} />
    </PreferenceRow>
  );
}

/** The quiet heading over a group of rows inside a level. */
export function LevelHeading({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pb-0.5 pt-1.5 text-mini uppercase tracking-wide text-app-text-muted">{children}</div>
  );
}
