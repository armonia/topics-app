import type { AIProvider } from './types';

/** A pinned runtime must never become a different provider after a restart. */
export function resolveTopicProvider(
  topic: { provider?: string | null } | null | undefined,
  registry: { getProvider(name: string): AIProvider; getDefaultProvider(): AIProvider },
): AIProvider {
  if (!topic?.provider) return registry.getDefaultProvider();
  const name = topic.provider === 'claude-code-team' ? 'claude-code' : topic.provider;
  try { return registry.getProvider(name); }
  catch {
    throw new Error(`Provider "${name}" non disponibile. Collegalo nelle Impostazioni prima di riprendere questa conversazione.`);
  }
}
