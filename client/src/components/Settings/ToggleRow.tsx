import { Switch } from '../Shared/Switch';

interface ToggleRowProps {
  label: string;
  description?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  /** Turns the switch OFF for real: out of the tab order, Space inert, the
   *  state exposed to assistive tech. It dims the label too, so the row reads
   *  as off. An `opacity-50 pointer-events-none` wrapper is NOT enough: the
   *  button stays focusable and keyboard-toggleable, and `aria-checked` flips
   *  without ever saying it is disabled. */
  disabled?: boolean;
}

/**
 * L'interruttore delle Impostazioni. Vive in un file suo perché lo usano DUE
 * schede (Aspetto e Notifiche): tenerlo dentro una delle due farebbe importare
 * l'altra scheda intera per un solo bottone.
 *
 * L'interruttore vero e proprio sta in `Shared/Switch`: il disegno era copiato
 * qui e nel modale delle impostazioni del topic, e il difetto dello stato
 * spento (bianco su bianco in tema chiaro) andava corretto in due punti.
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
