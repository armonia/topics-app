/**
 * dispatchModelOptions — the option list of the board's dispatch-model picker.
 *
 * Pulled out of the JSX because the rule it encodes is the one thing the
 * component must never get wrong: the STORED value stays on the list even
 * when its provider is disconnected (`models` no longer carries it). Drop the
 * rule and the `Select` falls back to its own placeholder `-`, which reads as
 * "nothing set" while `dispatchModel` is still the value the dispatcher runs
 * on (`task-dispatcher.ts`). Same reconciliation `TaskModelMenuOptions` was
 * written to avoid for the drawer/composer chips.
 */
import { friendlyModelLabel } from './format';

export interface DispatchModelOption {
  value: string;
  label: string;
}

/**
 * `dispatchModel` in `models` — appears once, no duplicate entry.
 * `dispatchModel` set but NOT in `models` — appears anyway, its provider gone.
 * `dispatchModel` null/empty — no extra entry, only "auto".
 */
export function buildDispatchModelOptions(
  models: readonly string[],
  dispatchModel: string | null | undefined,
  autoLabel: string,
): DispatchModelOption[] {
  const options: DispatchModelOption[] = [{ value: 'auto', label: autoLabel }];
  for (const m of models) options.push({ value: m, label: friendlyModelLabel(m) });
  if (dispatchModel && !models.includes(dispatchModel)) {
    options.push({ value: dispatchModel, label: friendlyModelLabel(dispatchModel) });
  }
  return options;
}
