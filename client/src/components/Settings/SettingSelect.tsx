import { AUTO } from './providerFormat';
import { Select } from '../Shared/Select';

/**
 * Una riga «etichetta a sinistra, tendina a destra» con la voce `AUTO` in cima.
 *
 * Vive in un file suo perché la usano otto punti della scheda provider più il
 * blocco del runtime, e il file che la ospitava aveva superato la soglia di
 * `check:bloat` — un componente di presentazione senza stato è esattamente il
 * pezzo che si porta fuori senza spostare comportamento.
 *
 * `null` è «non scelto» e si mostra come `autoLabel`: il chiamante non deve
 * inventarsi un valore sentinella, perché quel valore finirebbe salvato.
 */
export function SettingSelect({
  label, hint, value, options, onChange, disabled, autoLabel = 'Auto (env/default)',
}: {
  label: string;
  hint?: string;
  value: string | null;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string | null) => void;
  disabled?: boolean;
  autoLabel?: string;
}) {
  // `<label>` → `<div>`: il controllo non è più un elemento di modulo nativo,
  // quindi non c'è niente da etichettare per associazione — il nome accessibile
  // viaggia sull'`aria-label` del grilletto. Lasciando la `<label>` il click sul
  // testo avrebbe attivato il bottone, cioè aperto il menu, che è un aggancio
  // che nessuno cerca su una riga di descrizione.
  //
  // `flex-wrap` + `min-w-0`: a 390px la riga etichetta+controllo non ci sta in
  // orizzontale, e senza il ritorno a capo il pannello guadagnava una barra di
  // scorrimento laterale.
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1">
      <span className="flex min-w-0 flex-col">
        <span className="text-[12px] text-app-text">{label}</span>
        {hint && <span className="text-[11px] text-app-text-muted break-words">{hint}</span>}
      </span>
      <Select
        ariaLabel={label}
        disabled={disabled}
        align="right"
        value={value ?? AUTO}
        onChange={(v) => onChange(v === AUTO ? null : v)}
        className="max-w-full flex-shrink-0 min-w-[140px]"
        options={[{ value: AUTO, label: autoLabel }, ...options]}
      />
    </div>
  );
}
