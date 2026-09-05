import { Switch } from '../Shared/Switch';

interface ToggleRowProps {
  label: string;
  description?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  /** Turns the switch off for real: out of the tab order, Space inert, the
   *  state exposed to assistive tech. It also dims the label so the row reads
   *  as off. An `opacity-50 pointer-events-none` wrapper is NOT enough: the
   *  button stays focusable and keyboard-toggleable, and `aria-checked` changes
   *  without ever saying it is disabled. */
  disabled?: boolean;
}

/**
 * The Settings toggle. It lives in a file of its own because TWO tabs use it
 * (Appearance and Notifications): keeping it inside one of them would make the
 * other import a whole tab for a single button.
 *
 * The switch itself is `Shared/Switch`: the drawing used to be copied here and
 * in the topic settings modal, so the off-state defect (white on white in the
 * light theme) had to be fixed in two places.
 */
export function ToggleRow({ label, description, value, onChange, disabled }: ToggleRowProps) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 border-b border-app-border last:border-b-0">
      <div className={`min-w-0 flex-1${disabled ? ' opacity-50' : ''}`}>
        <div className="text-[12.5px] text-app-text">{label}</div>
        {description && (
          <div className="text-[11px] text-app-text-muted mt-0.5">{description}</div>
        )}
      </div>
      <Switch checked={value} onChange={onChange} label={label} disabled={disabled} className="mt-0.5" />
    </div>
  );
}
