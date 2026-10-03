/**
 * «Modello di default» of one provider, in Settings: the one model selector
 * (MSEL-01, variant `full`), filtered to that provider's models and without
 * the band, since it is not a choice of where a turn runs.
 */
import { useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { ModelSelector } from '../Shared/ModelSelector/ModelSelector';
import { friendlyModelLabel } from '../../lib/modelLabel';
import { useT } from '../../hooks/useT';

export function ProviderDefaultModel({ provider, label, hint, value, autoLabel, disabled, onChange }: {
  provider: string;
  label: string;
  hint?: string;
  value: string | null;
  autoLabel: string;
  disabled?: boolean;
  onChange: (model: string | null) => void;
}) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1">
      <span className="flex min-w-0 flex-col">
        <span className="text-compact text-app-text">{label}</span>
        {hint && <span className="text-mini text-app-text-muted break-words">{hint}</span>}
      </span>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        data-testid={`provider-default-model-${provider}`}
        onClick={() => setOpen((current) => !current)}
        className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-app-border bg-app-inset px-2.5 py-1 text-compact text-app-text hover:bg-app-hover disabled:opacity-40"
      >
        <span className="min-w-0 truncate">{value ? friendlyModelLabel(value) : autoLabel}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-app-text-muted" />
      </button>
      <ModelSelector
        open={open}
        anchorRef={triggerRef}
        onClose={() => setOpen(false)}
        align="right"
        testId={`provider-default-model-popover-${provider}`}
        ariaLabel={label}
        scope="chat"
        variant="full"
        onlyProvider={provider}
        value={{ provider: value ? provider : null, model: value }}
        onSelect={(next) => onChange(next.model)}
        automatic={{ label: autoLabel, hint: tr('ai.selector.providerDefaultHint') }}
        disabled={disabled}
      />
    </div>
  );
}
