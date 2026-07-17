// Pure value-mapping for the Behaviour-defaults controls (env-var audit, Phase B).
// Kept out of the component so the trickiest transform — the tri-state
// claude-code enable flag ↔ a <select> value ↔ the API patch — is unit-testable
// without a DOM. `null` everywhere means "Auto" (no override; env/default wins).

/** DB/API boolean|null → the <select> value used by the "Claude Code enabled" control. */
export function enabledToSelect(v: boolean | null): 'on' | 'off' | null {
  if (v == null) return null;
  return v ? 'on' : 'off';
}

/** <select> value ('on'|'off'|null) → the boolean|null persisted to the API. */
export function selectToEnabled(v: string | null): boolean | null {
  if (v == null) return null;
  return v === 'on';
}
