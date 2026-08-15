/**
 * useOwnerName — come si chiama chi usa questa installazione.
 *
 * Serve dove l'app parlava di sé stessa in terza persona: il thread di una
 * scheda firmava le tue righe «user» pur sapendo il tuo nome. Il nome sta in
 * `installation_owners` e arriva da `/api/profile/owner`, una porta che risponde
 * con una riga sola — la sorella `stats` conta sessioni, messaggi e token, e per
 * un nome non si paga quel conto.
 *
 * UNA fetch per sessione dell'app, non una per componente: il valore è
 * praticamente immutabile e il thread ne monta una copia per riga. La promessa
 * è condivisa, così N montaggi nello stesso istante fanno una chiamata sola;
 * il fallimento non si ritenta e non si urla, perché senza nome il chiamante ha
 * già il suo ripiego («Tu») e un errore in console per un'etichetta è rumore.
 */
import { useSyncExternalStore } from 'react';
import { profileApi } from '../lib/api';

let nome: string | null = null;
let inVolo: Promise<void> | null = null;
const ascoltatori = new Set<() => void>();

function annuncia() { for (const l of ascoltatori) l(); }

function assicura(): void {
  if (nome !== null || inVolo) return;
  inVolo = profileApi.owner()
    .then((r) => { nome = r.name?.trim() || null; if (nome) annuncia(); })
    .catch(() => { /* senza nome il chiamante ha già il suo ripiego */ })
    .finally(() => { inVolo = null; });
}

function subscribe(l: () => void): () => void {
  ascoltatori.add(l);
  assicura();
  return () => { ascoltatori.delete(l); };
}

/** Il nome del proprietario, o `null` finché non è arrivato (o se non c'è). */
export function useOwnerName(): string | null {
  return useSyncExternalStore(subscribe, () => nome, () => null);
}

/** Solo per i test: svuota la cache di modulo. */
export function resetOwnerNameCache(): void {
  nome = null;
  inVolo = null;
}
