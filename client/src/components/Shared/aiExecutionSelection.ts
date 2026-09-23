/**
 * Pure selection rules for the AI execution menu. They live outside
 * AiExecutionMenuOptions.tsx because a component module may only export
 * components (react-refresh/only-export-components), and the tests need them.
 */
export interface AiExecutionSelection {
  provider: string | null;
  model: string | null;
}

// The selection belongs to ITS provider: drilling into another one must not
// list it there as "unavailable". A model with no provider (legacy pin) is
// judged against whichever panel is open.
export function ownsSelection(active: { name: string }, value: AiExecutionSelection): boolean {
  return !value.provider || value.provider === active.name;
}

export function selectedModelMissingIn(
  active: { name: string; models: readonly string[] },
  value: AiExecutionSelection,
): boolean {
  return ownsSelection(active, value) && !!value.model && !active.models.includes(value.model);
}
