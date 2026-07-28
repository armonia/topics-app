/**
 * La scala dell'effort e la risoluzione del provider attivo, in UN posto solo.
 *
 * Prima l'effort si cambiava da DUE superfici — il popover del modello e il
 * SessionConfigPopover — ognuna con la sua copia di `EFFORT_TIERS`, la sua
 * grafica e la sua idea di cosa significhi "default". Ora il picker lo mostra
 * e basta (badge di sola lettura); a cambiarlo è il SessionConfigPopover, e la
 * scala + la risoluzione del tier di default vivono qui, condivise.
 *
 * `EFFORT_TIERS` rispecchia VALID_CLAUDE_EFFORTS sul server (migration 033):
 * è una scala ORDINATA, ed è il motivo per cui l'UI è uno slider e non cinque
 * pill affiancate — cinque pill non dicono che `max` sta dopo `xhigh`.
 */
import type { ProviderSnapshotEntry } from '../types';

export const EFFORT_TIERS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortTier = (typeof EFFORT_TIERS)[number];

export interface ProviderSelection {
  provider: string;
  model: string;
}

/**
 * La selezione in forza: override esplicito → provider di default della topic
 * → primo provider pronto. Ritorna null se non c'è nessun provider pronto con
 * almeno un modello (stato iniziale, o tutti i provider down).
 */
export function resolveEffectiveProvider(
  entries: ProviderSnapshotEntry[],
  override: ProviderSelection | null,
  defaultProviderLabel?: string,
): ProviderSelection | null {
  if (override) return { provider: override.provider, model: override.model };
  const ready = entries.filter((e) => e.status === 'ready');
  const candidate =
    ready.find((e) => e.name === defaultProviderLabel) ??
    ready.find((e) => e.isDefault) ??
    ready[0];
  if (!candidate || candidate.models.length === 0) return null;
  return { provider: candidate.name, model: candidate.models[0] };
}

/**
 * Il tier che il server impone alle sessioni del provider attivo (policy di
 * sola lettura, es. `--effort xhigh` per claude-code). È il "default" contro
 * cui si misura l'override per-topic: senza, non si può dire se l'utente ha
 * cambiato qualcosa o sta guardando l'impostazione di fabbrica.
 */
export function providerEffortTier(
  entries: ProviderSnapshotEntry[],
  effective: ProviderSelection | null,
  override: ProviderSelection | null,
): string | null {
  const name = effective?.provider ?? override?.provider;
  if (!name) return null;
  return entries.find((e) => e.name === name)?.effortTier ?? null;
}

/** Posizione sulla scala, o -1 se il tier non è uno dei cinque. */
export function effortIndex(tier: string | null | undefined): number {
  if (!tier) return -1;
  return (EFFORT_TIERS as readonly string[]).indexOf(tier);
}
