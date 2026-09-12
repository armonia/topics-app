/**
 * TaskModelMenuOptions - the rows inside a task model picker, once.
 *
 * The composer and the task drawer both offer the same choice: Auto, then one
 * row per executable model. They drew it twice, with two copies of the same
 * markup, and the copies had already started to drift (one truncated long
 * labels, the other did not). This component owns the rows. The `Menu`
 * popover around them stays in each caller, because positioning, Escape and
 * focus restore belong to the surface, not to the list.
 *
 * WHAT "AUTO" MEANS HERE. It is `null`, and it is not a placeholder for
 * "nothing chosen". The server picks a real model across the compatible
 * connected runtimes (`server/services/task-auto-model.ts`). The row is
 * therefore a first-class choice with a check mark of its own, and each
 * surface passes its own translated label because the two use different i18n
 * keys.
 *
 * WHAT THIS COMPONENT DOES NOT DO: it never reconciles `value` against
 * `models`. A model whose provider just disconnected drops out of the list
 * while the task keeps it stored, and the chip must keep saying so. Selecting
 * something else on the user's behalf would be a silent change to what the
 * agent runs on.
 */
import { AiExecutionMenuOptions } from '../Shared/AiExecutionMenuOptions';
import { useProvidersSnapshot } from '../../hooks/useProvidersSnapshot';
import { taskExecutionOptions, taskModelSelection, taskModelValue } from '../../../../shared/task-coding-models';
import type { ProvidersSnapshot } from '../../types';

interface Props {
  /** The live catalog, already filtered to executable coding runtimes. */
  models: string[];
  /** Currently selected model id, or `null` for Auto. */
  value: string | null;
  onSelect: (model: string | null) => void;
  /** Locks every row while a write is in flight. */
  disabled?: boolean;
  /** Caller-translated label for the Auto row. */
  autoLabel: string;
  /** Draw the sparkle glyph on the Auto row (the drawer does, the composer does not). */
  autoIcon?: boolean;
  /** Optional tooltip on the Auto row (the composer explains what Auto does). */
  autoTitle?: string;
  /** Deterministic catalog injection for render tests. Live callers omit it. */
  snapshot?: ProvidersSnapshot;
}

export function TaskModelMenuOptions({ models, value, onSelect, disabled, autoLabel, autoIcon, autoTitle, snapshot: snapshotOverride }: Props) {
  void autoIcon;
  const { snapshot: liveSnapshot } = useProvidersSnapshot();
  const snapshot = snapshotOverride ?? liveSnapshot;
  const selected = taskModelSelection(value);
  const legacyProviders = selected.model && !selected.provider
    ? taskExecutionOptions(snapshot).filter((entry) => entry.models.includes(selected.model!))
    : [];
  const selectedProvider = selected.provider
    ?? legacyProviders.find((entry) => entry.name === snapshot?.defaultProvider)?.name
    ?? legacyProviders[0]?.name
    ?? (selected.model && models.includes(value ?? '') ? selected.model : null)
    ?? null;
  return (
    <AiExecutionMenuOptions
      snapshot={snapshot}
      surface="task"
      value={{ provider: selectedProvider, model: selected.model ?? null }}
      onSelect={(next) => onSelect(next.provider ? taskModelValue(next.provider, next.model) : null)}
      automaticLabel={autoLabel}
      automaticHint={autoTitle ?? autoLabel}
      disabled={disabled}
      allowRuntimeAutomatic
    />
  );
}
