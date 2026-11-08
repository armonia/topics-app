// Pure value-mapping for the Behaviour-defaults controls (env-var audit, Phase B).
// Kept out of the component so the trickiest transform — the tri-state
// claude-code enable flag ↔ il valore del selettore ↔ the API patch — is unit-testable
// without a DOM. `null` everywhere means "Auto" (no override; env/default wins).

/** DB/API boolean|null → il valore del selettore («Claude Code enabled»). */
export function enabledToSelect(v: boolean | null): 'on' | 'off' | null {
  if (v == null) return null;
  return v ? 'on' : 'off';
}

/** Valore del selettore ('on'|'off'|null) → the boolean|null persisted to the API. */
export function selectToEnabled(v: string | null): boolean | null {
  if (v == null) return null;
  return v === 'on';
}
