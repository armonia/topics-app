import { useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Menu } from './Menu';
// Import RELATIVO e non `@/lib/...`: l'alias lo risolve Vite, non `bun test`, e
// questo file finisce nel grafo di componenti che i test unitari importano
// davvero (`Settings/IdentitySection.test.tsx`) — con l'alias quei test
// morivano su «Cannot find module».
import { POPOVER_ITEM } from '../../lib/popoverStyles';

/**
 * Select — l'UNICO selettore a scelta singola dell'app, e il rimpiazzo del
 * `<select>` nativo.
 *
 * PERCHÉ ESISTE. Un `<select>` è l'unico controllo di modulo che il sistema
 * operativo si riserva di disegnare per intero: su iOS apre la ruota nativa,
 * su macOS il menu di sistema, e in mezzo a una UI disegnata si legge come un
 * pezzo di un'altra applicazione — carattere suo, margini suoi, tema suo. Il
 * progetto ha già una primitiva per le superfici fluttuanti (`Menu`: portal su
 * <body>, piazzamento con flip + clamp, chiusura fuori/Escape con restore del
 * fuoco, navigazione a frecce, foglio dal basso su mobile, `Z_POPOVER`) e non
 * aveva il controllo che la usa per la scelta di UN valore. Questo è quello.
 *
 * COSA NON FA, e di proposito:
 *  - non è un combobox con ricerca (per quello c'è il pattern `unmanagedFocus`
 *    di `Menu`, usato dal picker dei modelli): qui le liste sono corte e una
 *    casella di ricerca sarebbe un secondo bersaglio da centrare col dito;
 *  - non è multi-selezione: quella è una lista di interruttori, non un menu.
 *
 * ACCESSIBILITÀ. Il grilletto è un `<button>` con `role="combobox"` +
 * `aria-expanded` + `aria-controls`; il pannello è il `role="listbox"` di
 * `Menu`, e ogni riga è un `role="option"` con `aria-selected`. È il pattern
 * ARIA del select, cioè quello che uno screen reader annuncia già come tale —
 * non un `div` che sembra un menu.
 *
 * IL DITO. Il grilletto porta `coarse:min-h-[44px]`: dove c'è un dito il
 * bersaglio è 44px, la stessa soglia che `POPOVER_ITEM` applica alle righe del
 * pannello. Il gate è `coarse:` (any-pointer) e non una larghezza, per la
 * ragione scritta in `popoverStyles.ts`: un telefono in orizzontale è largo
 * come un portatile e ha comunque un dito.
 */

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** Seconda riga sotto l'etichetta, per le voci che hanno bisogno di una glossa. */
  hint?: string;
  disabled?: boolean;
}

interface SelectProps<T extends string> {
  value: T;
  options: ReadonlyArray<SelectOption<T>>;
  onChange: (value: T) => void;
  /** Nome accessibile: obbligatorio, perché il grilletto mostra il VALORE, e un
   *  nome che cambia col valore non è un nome. */
  ariaLabel: string;
  disabled?: boolean;
  /** Testo del grilletto quando `value` non è fra le opzioni (lista non ancora
   *  caricata, valore rimosso a monte). */
  placeholder?: string;
  /** Bordo del grilletto a cui il pannello si allinea (default 'left'). */
  align?: 'left' | 'right';
  /** Classi extra sul grilletto (larghezze, `flex-shrink-0`, …). */
  className?: string;
  /** `data-testid` sul grilletto — è lui l'ancora del controllo per i test. */
  testId?: string;
  /** Larghezza minima del pannello su desktop. Default: quella del grilletto. */
  minWidth?: number;
}

const TRIGGER_BASE =
  'flex items-center gap-1.5 rounded-md border border-app-border bg-surface px-2 py-1 ' +
  'coarse:min-h-[44px] coarse:px-3 coarse:text-[14px] text-[12px] text-app-text ' +
  'outline-none transition-colors hover:bg-app-hover focus-visible:border-primary ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

export function Select<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  placeholder = '—',
  align = 'left',
  className = '',
  testId,
  minWidth,
}: SelectProps<T>) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  // La larghezza del pannello segue il grilletto, come fa un `<select>`: si
  // misura all'APERTURA, non a ogni render, perché fra un'apertura e l'altra il
  // grilletto non si muove e una misura per render costerebbe un reflow ogni
  // volta che il valore cambia.
  const [anchorWidth, setAnchorWidth] = useState(0);

  const selected = options.find((o) => o.value === value);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        disabled={disabled}
        data-testid={testId}
        onClick={() => {
          if (!open) setAnchorWidth(anchorRef.current?.getBoundingClientRect().width ?? 0);
          setOpen((v) => !v);
        }}
        className={`${TRIGGER_BASE} ${className}`}
      >
        <span className="min-w-0 flex-1 truncate text-left">{selected?.label ?? placeholder}</span>
        <ChevronDown size={13} className="flex-shrink-0 text-app-text-muted" />
      </button>
      <Menu
        open={open}
        anchorRef={anchorRef}
        onClose={() => setOpen(false)}
        align={align}
        role="listbox"
        ariaLabel={ariaLabel}
        minWidth={minWidth ?? Math.max(anchorWidth, 140)}
      >
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="option"
            aria-selected={o.value === value}
            disabled={o.disabled}
            onClick={() => {
              setOpen(false);
              if (o.value !== value) onChange(o.value);
            }}
            className={`${POPOVER_ITEM} items-start disabled:cursor-not-allowed disabled:opacity-40`}
          >
            {/* Lo spunto occupa il suo posto ANCHE quando è invisibile: senza,
                le etichette non selezionate scorrerebbero a sinistra e la lista
                si riallineerebbe a ogni cambio di valore. */}
            <Check
              size={13}
              className={`mt-0.5 flex-shrink-0 ${o.value === value ? 'text-primary' : 'invisible'}`}
            />
            <span className="flex min-w-0 flex-col">
              <span className={o.value === value ? 'text-primary' : undefined}>{o.label}</span>
              {o.hint && (
                <span className="text-[11px] text-app-text-muted">{o.hint}</span>
              )}
            </span>
          </button>
        ))}
      </Menu>
    </>
  );
}
