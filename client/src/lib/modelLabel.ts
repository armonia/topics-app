/**
 * Il suffisso `[1m]` non è parte del NOME del modello: è una MODALITÀ.
 *
 * La CLI espone le varianti a finestra lunga come id a sé — `claude-opus-5[1m]`
 * accanto a `claude-opus-5` — e il picker le stampava così com'erano dentro uno
 * `span` con `truncate`. Su una pane stretta il pezzo che veniva tagliato via
 * era proprio la coda, cioè l'unica differenza fra una finestra da 200k e una da
 * 1M: due bottoni identici, due modelli diversi.
 *
 * Perché non `friendlyModelLabel` (components/Board/format.ts). Quella funzione
 * è tarata sugli id Claude: toglie il prefisso `claude-` e riunisce il resto coi
 * punti, quindi `claude-opus-5` → «Opus 5» ma `gpt-5.4-mini` → «Gpt 5.4.mini».
 * Sulla board va bene, perché lì i modelli sono quelli degli agenti; nel picker
 * ci sono anche Codex e OpenAI, e un id storpiato è peggio di un id grezzo. Qui
 * quindi non si abbellisce niente: si SEPARA soltanto la modalità dal nome, così
 * la modalità può stare in un badge che non si accorcia.
 */

export interface ModelIdParts {
  /** L'id senza il suffisso di modalità — resta la stringa esatta della CLI. */
  name: string;
  /** `true` se l'id portava `[1m]`: finestra di contesto lunga. */
  longContext: boolean;
}

/**
 * Separa la modalità dal nome. Non normalizza, non abbellisce, non cambia
 * maiuscole: `name` resta confrontabile con l'id che il server ha salvato,
 * a meno del suffisso.
 */
export function splitModelId(modelId: string): ModelIdParts {
  const m = /^(.*?)\[1m\]$/i.exec(modelId);
  if (!m) return { name: modelId, longContext: false };
  return { name: m[1], longContext: true };
}
