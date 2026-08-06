/**
 * Quanto costa un modello. UNA tabella, due lettori — stessa mossa già fatta
 * per la finestra di contesto (`shared/context-window.ts`), e per lo stesso
 * motivo: il client non può importare da `server/` (TS6307, e il confine è
 * cablato in `tests/unit/no-type-mirrors.test.ts`), quindi o si ricopia la
 * tabella — cioè si garantisce che fra sei mesi le due copie dicano prezzi
 * diversi sullo stesso modello — o la si mette dove entrambi la leggono.
 *
 * Il server continua a importarla dal suo modulo (`server/usage/pricing.ts`),
 * che la ri-esporta: nessun chiamante storico cambia una riga. Qui dentro NON
 * c'è nessuno stato: il registro dei modelli senza prezzo — che serve al
 * pannello di stato — resta di là, perché è memoria di processo e questo
 * modulo lo leggono anche 20 tab del browser.
 *
 * Prezzi in USD per 1M token. Fonte: tabella prezzi ufficiale (skill
 * `claude-api`), aggiornata al 2026-08-03.
 */

/** Prezzo di un modello, USD per 1M token. */
export interface ModelPrice { input: number; output: number }

/**
 * Questa tabella era ferma a modelli che NON si usano più, e il danno non era
 * "un prezzo mancante": era un prezzo SBAGLIATO, applicato in silenzio. Nessuna
 * delle chiavi vecchie compariva nei modelli reali (`claude-opus-4-8`,
 * `claude-opus-5`, …), quindi ogni turno Opus cadeva nel ripiego di famiglia —
 * che puntava al modello più VECCHIO della famiglia, a 15$/75$ — e finiva
 * tariffato al TRIPLO dei 5$/25$ veri. Misurato sul DB di prod: 643,66$
 * mostrati contro 214,55$ reali sul campione.
 *
 * Due lezioni, entrambe cablate qui sotto:
 *   · il ripiego di famiglia deve puntare al modello CORRENTE, non al primo che
 *     è stato scritto: sbagliare per difetto (un modello nuovo più economico
 *     tariffato come il vecchio) è meno peggio che sbagliare per eccesso, e
 *     comunque il ripiego non deve invecchiare da solo;
 *   · un modello SCONOSCIUTO deve vedersi. Prima tornava `0` con un
 *     `console.warn`, cioè "gratis" — indistinguibile da un turno che davvero
 *     non è costato niente.
 */
export const MODEL_PRICING: Record<string, ModelPrice> = {
  // Claude — generazione corrente
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  // Claude — legacy, ancora nei messaggi vecchi
  'claude-opus-4-5': { input: 15, output: 75 },
  'claude-opus-4-1': { input: 15, output: 75 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-haiku-3-5-20241022': { input: 0.80, output: 4 },
  // OpenAI
  'gpt-4o': { input: 2.50, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-o3': { input: 10, output: 40 },
  'gpt-o3-mini': { input: 1.10, output: 4.40 },
};

/**
 * Normalizza un id di modello prima del match.
 *
 * Il suffisso di finestra — `claude-opus-5[1m]` — fa parte dell'id che la CLI
 * riporta, non del nome del modello: senza toglierlo la chiave esatta non matcha
 * mai e si finisce nel ripiego. Stessa normalizzazione di
 * `shared/context-window.ts`.
 *
 * Il modello è lo STESSO, quindi la tariffa è la stessa. Non è modellato il
 * sovrapprezzo che il beta 1M applica alle richieste sopra i 200k token: qui si
 * lavora ad abbonamento, dove quel numero non è denaro ma un promemoria, e una
 * soglia inventata a metà sarebbe meno vera di una tariffa piatta.
 */
export function normalizeModel(model: string): string {
  return model.toLowerCase().replace(/\[[^\]]*\]\s*$/, '').trim();
}

/**
 * Il prezzo di un modello, o `null` se la tabella non sa dire niente di lui.
 *
 * Match esatto, poi normalizzato, poi per SOTTOSTRINGA (chiavi più lunghe per
 * prime: i nomi che arrivano dai provider sono pieni di date e suffissi, e una
 * tabella di uguaglianze esatte invecchia in una settimana), infine il ripiego
 * di famiglia. `null` è un esito legittimo e va MOSTRATO da chi chiama, non
 * trasformato in zero.
 */
export function modelPrice(model: string): ModelPrice | null {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];

  const lower = normalizeModel(model);
  if (MODEL_PRICING[lower]) return MODEL_PRICING[lower];

  // Partial match: check if model string contains a known key.
  // Sort by longest key first so "gpt-4o-mini" matches before "gpt-4o".
  const sortedEntries = Object.entries(MODEL_PRICING).sort((a, b) => b[0].length - a[0].length);
  for (const [key, pricing] of sortedEntries) {
    // Only match when the MODEL NAME contains a known pricing key. The reverse
    // direction (key contains model) misclassified short names — e.g. model
    // "gpt-4o" matched the longer key "gpt-4o-mini" (checked first by length)
    // and billed at the wrong rate. Short aliases ("opus", "o3") fall through
    // to the explicit family fallbacks below.
    if (lower.includes(key.toLowerCase())) return pricing;
  }

  // Ripiego di famiglia — sul modello CORRENTE della famiglia, non sul primo
  // che è stato scritto in questo file.
  if (lower.includes('fable') || lower.includes('mythos')) return MODEL_PRICING['claude-fable-5'];
  if (lower.includes('opus')) return MODEL_PRICING['claude-opus-5'];
  if (lower.includes('sonnet')) return MODEL_PRICING['claude-sonnet-5'];
  if (lower.includes('haiku')) return MODEL_PRICING['claude-haiku-4-5'];
  if (lower.includes('gpt-4o-mini')) return MODEL_PRICING['gpt-4o-mini'];
  if (lower.includes('gpt-4o')) return MODEL_PRICING['gpt-4o'];
  if (lower.includes('o3-mini')) return MODEL_PRICING['gpt-o3-mini'];
  if (lower.includes('o3')) return MODEL_PRICING['gpt-o3'];

  return null;
}

/**
 * Quanto costa un turno su `candidate` rispetto allo stesso turno su `base`.
 * 0,2 = un quinto; 1 = identico; 3 = il triplo. `null` se uno dei due modelli
 * non ha prezzo — un moltiplicatore inventato è peggio di nessun numero.
 *
 * Input e output hanno tariffe diverse, quindi i rapporti sono DUE. Su tutta la
 * tabella attuale coincidono (opus→haiku è 0,2 su entrambi; gpt-4o→mini è 0,06
 * su entrambi) perché i listini scalano per intero fra le fasce, ma non è una
 * legge: quando divergono vince quello dell'OUTPUT, che è la voce che domina il
 * conto di un turno agentico, e `spread` dice di quanto l'altro si discosta —
 * così chi disegna può dichiararlo invece di far passare per esatto un numero
 * che è una media.
 */
export function costMultiplier(base: string, candidate: string): {
  ratio: number;
  /** |rapporto input − rapporto output| / rapporto output. 0 = coincidono. */
  spread: number;
} | null {
  const b = modelPrice(base);
  const c = modelPrice(candidate);
  if (!b || !c || b.output <= 0 || b.input <= 0) return null;
  const outRatio = c.output / b.output;
  const inRatio = c.input / b.input;
  const spread = outRatio === 0 ? 0 : Math.abs(inRatio - outRatio) / outRatio;
  return { ratio: outRatio, spread };
}
