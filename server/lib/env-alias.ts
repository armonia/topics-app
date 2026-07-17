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

/**
 * Read `canonical`, falling back to a deprecated `alias`. When the alias is the
 * one that supplies the value, emit a one-time deprecation warning. Empty
 * strings are treated as unset. Returns undefined when neither is set.
 */
export function readEnvWithAlias(canonical: string, alias: string): string | undefined {
  const primary = process.env[canonical];
  if (primary != null && primary !== '') return primary;
  const legacy = process.env[alias];
  if (legacy != null && legacy !== '') {
    warnDeprecatedEnv(alias, canonical);
    return legacy;
  }
  return undefined;
}

// Test-only: reset the one-shot warning ledger so each test observes a fresh
// "first use" of an alias.
export function __resetDeprecatedEnvWarnings(): void {
  warnedAliases.clear();
}
