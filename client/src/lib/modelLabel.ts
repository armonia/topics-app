/**
 * The `[1m]` suffix is not part of the model NAME: it is a MODE.
 *
 * The CLI exposes long-context variants as their own id — `claude-opus-5[1m]`
 * next to `claude-opus-5` — and the picker used to print them as-is inside a
 * `truncate` span. On a narrow pane the piece that got clipped was exactly the
 * tail, i.e. the only difference between a 200k and a 1M window: two identical
 * buttons, two different models.
 *
 * This module only PEELS the mode off the id; it does not decide how the rest
 * is displayed. `friendlyModelLabel` (components/Board/format.ts) owns that,
 * and it is safe to call on any provider's id: it now special-cases `codex`
 * and `gpt-` ids too, so `claude-opus-5` -> "Opus 5" and `gpt-5.4-mini` ->
 * "GPT-5.4-mini" render the same way here as on the board.
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
