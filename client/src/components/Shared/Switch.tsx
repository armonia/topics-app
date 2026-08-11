interface SwitchProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  /** Accessible name. The switch is a bare control: nothing wraps it, nothing
   *  binds to it by `for`, so without this it would be anonymous. */
  label: string;
  disabled?: boolean;
  className?: string;
}

/**
 * L'interruttore dell'app, in un posto solo.
 *
 * Nasce da un difetto vero: da spento era `bg-app-border` con il pallino
 * `bg-white`. In tema chiaro `--border` è `hsl(220 4.9% 91.4%)`, cioè quasi
 * bianco — quindi bianco su bianco: la pista non si distingueva dallo sfondo e
 * il pallino non si distingueva dalla pista. Lo stato spento non si LEGGEVA, e
 * un interruttore che non dice se è spento non è un interruttore.
 *
 * Da qui le due scelte:
 * - la pista spenta è un velo sul FONDO (`bg-black/25` chiaro, `bg-white/25`
 *   scuro), non un token di bordo: così ha contrasto in entrambi i temi invece
 *   di sparire in quello chiaro;
 * - il pallino ha un anello proprio (`ring-black/10`). Il bianco pieno non ha
 *   un bordo suo, e su una pista chiara serve un contorno per esistere.
 */
export function Switch({ checked, onChange, label, disabled, className = '' }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`shrink-0 rounded-full disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${className}`}
    >
      <SwitchTrack checked={checked} />
    </button>
  );
}

/**
 * Solo il disegno, senza il bottone. Serve dove la riga INTERA è già il
 * controllo (`role="switch"` sta sul contenitore): un bottone dentro un bottone
 * è HTML non valido, quindi lì non si può innestare `<Switch>`, ma l'aspetto
 * deve restare lo stesso — è per non riaverne due versioni che questo pezzo
 * esiste separato.
 */
export function SwitchTrack({ checked }: { checked: boolean }) {
  return (
    <span
      className={`relative block h-5 w-9 shrink-0 rounded-full transition-colors ${
        checked ? 'bg-primary' : 'bg-black/25 dark:bg-white/25'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow-sm ring-1 ring-black/10 transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </span>
  );
}
