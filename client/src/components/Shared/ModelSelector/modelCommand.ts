/**
 * MSEL-10, in a module of its own: the composer reads it at first paint, and
 * pulling the whole catalog (`useModelCatalog`) into the eager entry for one
 * completion would cost every session the selector's bytes.
 */
import type { ProvidersSnapshot } from '../../../types';
import { modelMaker } from '../../../../../shared/modelMaker';
import { friendlyModelLabel } from '../../../lib/modelLabel';

/** Lowercase, accents gone: an accented letter matches its plain twin. */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * MSEL-10: what `/model <text>` proposes. `/model` writes only the chat's
 * model, never its engine, so it offers only the models of the engine the
 * chat runs on now, with the selector's labels. Changing engine is the
 * selector's job.
 */
export function modelCommandSuggestions(
  snapshot: ProvidersSnapshot | null,
  provider: string | null | undefined,
  query: string,
): Array<{ id: string; label: string }> {
  const entry = snapshot?.providers.find((candidate) => candidate.name === provider);
  if (!entry) return [];
  const words = fold(query).split(/\s+/).filter(Boolean);
  return entry.models
    .map((id) => ({ id, label: modelMaker(id) === 'anthropic' || modelMaker(id) === 'openai' ? (entry.modelInfo?.[id]?.label ?? friendlyModelLabel(id)) : id }))
    .filter((model) => words.every((word) => fold(`${model.id} ${model.label}`).includes(word)));
}
