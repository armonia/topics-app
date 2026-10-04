/**
 * «Modello di default» of one provider, chosen INSIDE its account's detail
 * (model selector revision 2026-10-04, §5.5, AC-25): a list of radios in line,
 * Automatic first, the current models, then «Precedenti (n)». No popover, no
 * foot, no «via»: a second selector here would be a door that opens the same
 * panel again on top of itself.
 *
 * The rows are the selector's own (`buildModelCatalog` with `onlyProvider`), so
 * labels, generations and the stale saved value read the same in both places.
 */
import { useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import type { ProvidersSnapshot } from '../../types';
import { buildModelCatalog, type CatalogRow } from '../Shared/ModelSelector/useModelCatalog';
import { modelDisplayLabel } from '../../lib/modelLabel';
import { useT } from '../../hooks/useT';

interface Choice {
  id: string | null;
  label: string;
  disabled?: boolean;
}

function rowChoices(row: CatalogRow): Choice[] {
  if (!row.model) return [];
  const base = { id: row.model, label: row.label, disabled: !!row.stale };
  return row.longModel ? [base, { id: row.longModel, label: `${row.label} · 1M` }] : [base];
}

export function ProviderDefaultModel({ provider, providerName, snapshot, value, hint, disabled, onChange }: {
  provider: string;
  /** The provider's label, for «Lo sceglie Claude Code». */
  providerName: string;
  snapshot: ProvidersSnapshot | null;
  value: string | null;
  hint?: string;
  disabled?: boolean;
  onChange: (model: string | null) => void;
}) {
  const tr = useT();
  const groups = useMemo(
    () => buildModelCatalog(snapshot, 'chat', { provider: value ? provider : null, model: value }, { onlyProvider: provider }),
    [snapshot, provider, value],
  );
  const current = groups.flatMap((group) => group.rows.flatMap(rowChoices));
  const older = groups.flatMap((group) => group.older.flatMap(rowChoices));
  const [showOlder, setShowOlder] = useState(() => older.some((choice) => choice.id === value));
  const today = snapshot?.providers.find((entry) => entry.name === provider)?.defaultModel ?? null;
  const who = tr('ai.selector.auto.providerLong', { name: providerName });
  const automaticHint = today ? tr('ai.providers.defaultModel.today', { who, model: modelDisplayLabel(today) }) : who;

  const radio = (choice: Choice, sub?: string) => {
    const checked = choice.id === value;
    return (
      <button
        key={choice.id ?? 'auto'}
        type="button"
        role="radio"
        aria-checked={checked}
        disabled={disabled || (choice.disabled && !checked)}
        data-model={choice.id ?? undefined}
        data-testid={choice.id ? 'provider-default-model-option' : 'provider-default-model-auto'}
        onClick={() => { if (!checked) onChange(choice.id); }}
        className="flex min-h-7 w-full items-start gap-2 rounded px-2 py-1 text-left text-compact text-app-text hover:bg-app-hover disabled:opacity-50 coarse:min-h-11"
      >
        <span
          aria-hidden="true"
          className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${checked ? 'border-primary bg-primary text-white' : 'border-zinc-400 dark:border-zinc-500'}`}
        >
          {checked && <Check className="h-2.5 w-2.5" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block break-words">{choice.label}</span>
          {sub && <span className="block text-mini text-app-text-secondary">{sub}</span>}
        </span>
      </button>
    );
  };

  return (
    <div
      role="radiogroup"
      aria-label={tr('ai.providers.row.defaultModel')}
      data-testid={`provider-default-model-${provider}`}
      className="space-y-0.5"
    >
      {radio({ id: null, label: tr('ai.selector.auto') }, automaticHint)}
      {current.map((choice) => radio(choice))}
      {older.length > 0 && (
        <button
          type="button"
          aria-expanded={showOlder}
          data-testid="provider-default-model-older"
          onClick={() => setShowOlder((open) => !open)}
          className="w-full rounded px-2 py-1 text-left text-mini text-app-text-secondary hover:bg-app-hover coarse:min-h-11"
        >
          {showOlder ? tr('ai.selector.olderHide') : tr('ai.selector.older', { n: older.length })}
        </button>
      )}
      {showOlder && older.map((choice) => radio(choice))}
      {hint && <p className="px-2 pt-1 text-mini text-app-text-secondary break-words">{hint}</p>}
    </div>
  );
}
