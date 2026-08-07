interface ToggleRowProps {
  label: string;
  description?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}

/**
 * L'interruttore delle Impostazioni. Vive in un file suo perché lo usano DUE
 * schede (Aspetto e Notifiche): tenerlo dentro una delle due farebbe importare
 * l'altra scheda intera per un solo bottone.
 *
 * `role="switch"` + `aria-checked` + `aria-label`: il <div> con l'etichetta non
 * avvolge il bottone e non lo lega per `for`, quindi senza il nome esplicito
 * l'interruttore sarebbe anonimo — e in questo pannello ce ne sono cinque.
 */
export function ToggleRow({ label, description, value, onChange }: ToggleRowProps) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 border-b border-app-border last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] text-app-text">{label}</div>
        {description && (
          <div className="text-[11px] text-app-text-muted mt-0.5">{description}</div>
        )}
      </div>
      <button
        role="switch"
        aria-checked={value}
        aria-label={label}
        onClick={() => onChange(!value)}
        className={`relative shrink-0 mt-0.5 w-9 h-5 rounded-full transition-colors ${
          value ? 'bg-primary' : 'bg-app-border'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
            value ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  );
}
