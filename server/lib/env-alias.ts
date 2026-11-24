/**
 * Deprecated-env-var plumbing.
 *
 * Part of the env-var audit (see docs/ENV.md): when two env names resolve to
 * the same knob we keep ONE canonical name and honour the other as a
 * deprecated alias for one release cycle, emitting a single warning the first
 * time the alias actually supplies a value. Behaviour is never changed by the
 * warning — the alias keeps working — so existing setups don't break.
 */

const warnedAliases = new Set<string>();

/** Warn once (per process) that `alias` is deprecated in favour of `canonical`. */
export function warnDeprecatedEnv(alias: string, canonical: string): void {
  if (warnedAliases.has(alias)) return;
  warnedAliases.add(alias);
  console.warn(
    `[env] ${alias} is deprecated; use ${canonical} instead. ` +
      `The old name is still honoured for now but will be removed.`,
  );
}

// Test-only: reset the one-shot warning ledger so each test observes a fresh
// "first use" of an alias.
/** @internal Test seam: forgets which deprecated aliases already warned, so each test sees the first warning. */
export function __resetDeprecatedEnvWarnings(): void {
  warnedAliases.clear();
}
