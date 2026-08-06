/**
 * Quanto costa premere ⚡ — il numero sotto l'icona del Fast Mode.
 *
 * Non è un'etichetta di marketing: è il rapporto VERO fra il listino del
 * modello che il turno userebbe col Fast acceso e quello che userebbe adesso
 * (`shared/model-pricing.ts`, la stessa tabella con cui il server tariffa i
 * turni). 0,2× = un quinto. 1× = non cambia niente.
 *
 * Le due condizioni che rendono il numero onesto, entrambe copiate dal ramo
 * che decide DAVVERO il modello (`server/routes/chat.ts`, «Fast Mode model
 * resolution»):
 *
 *  1. **Un modello fissato VINCE sul Fast.** Se la topic ha un modello suo (o
 *     lo hai scelto dal picker), il Fast non lo cambia: il server lo dice pure
 *     nei log («fast mapping skipped»). Il badge non può promettere un
 *     risparmio che non arriverà, quindi in quel caso dice 1× — e il tooltip
 *     spiega perché.
 *  2. **Senza fast model non c'è numero.** `fastModel: null` (openclaw delega
 *     al gateway; oppure nessuna fascia veloce nella lista viva) e modelli che
 *     la tabella non conosce danno `null`: nessun badge. Un moltiplicatore
 *     inventato è peggio di nessun moltiplicatore.
 */
import { costMultiplier } from '../../../shared/model-pricing';
import type { ProvidersSnapshot } from '../types';

export interface FastCost {
  /** Il rapporto di costo: 0,2 = un quinto; 1 = identico; 3 = il triplo. */
  ratio: number;
  /** Il modello che il turno userebbe ADESSO. */
  baseModel: string;
  /** Il modello che userebbe col Fast acceso. */
  fastModel: string;
  /**
   * Il Fast non cambierebbe nulla perché un modello esplicito ha la
   * precedenza. `ratio` è 1 e il tooltip deve dirlo.
   */
  pinned: boolean;
  /** Quanto il rapporto sull'input si discosta da quello sull'output (0 = coincidono). */
  spread: number;
}

/**
 * `null` = niente badge. Sono tutti casi VERI, non errori: provider ignoto,
 * nessun fast model, modello senza prezzo, o fast e corrente coincidono.
 */
export function fastCost(args: {
  snapshot: ProvidersSnapshot | null;
  /** Il modello fissato per questa chat, se c'è (`{provider, model}`). */
  providerOverride?: { provider: string; model: string } | null;
}): FastCost | null {
  const { snapshot, providerOverride } = args;
  if (!snapshot) return null;

  const providerName = providerOverride?.provider ?? snapshot.defaultProvider;
  if (!providerName) return null;
  const entry = snapshot.providers.find((p) => p.name === providerName);
  if (!entry) return null;

  const fastModel = entry.fastModel ?? null;
  if (!fastModel) return null;

  // Il modello di adesso: quello fissato, altrimenti il default DICHIARATO dal
  // provider (che non è `models[0]` — la lista guida con l'id nudo mentre il
  // default può essere la sua variante a finestra lunga).
  const pinned = !!providerOverride?.model;
  const baseModel = providerOverride?.model || entry.defaultModel || '';
  if (!baseModel) return null;

  // Fissato = il Fast non tocca il modello: costo invariato, per definizione.
  if (pinned) return { ratio: 1, baseModel, fastModel, pinned: true, spread: 0 };
  if (baseModel === fastModel) return null; // già veloce: niente da dire

  const mult = costMultiplier(baseModel, fastModel);
  if (!mult) return null;
  return { ratio: mult.ratio, baseModel, fastModel, pinned: false, spread: mult.spread };
}

/**
 * Il numero come si legge su un badge da 9px: poche cifre, mai una precisione
 * che non serve. 0,2× · 0,06× · 1× · 2,5×.
 *
 * Il separatore decimale segue la lingua (`toLocaleString`): in un'interfaccia
 * italiana «0.2» si legge come un errore di battitura.
 */
export function formatMultiplier(ratio: number, locale?: string): string {
  const digits = ratio !== 0 && Math.abs(ratio) < 0.1 ? 2 : 1;
  const n = ratio.toLocaleString(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
  return `${n}×`;
}
