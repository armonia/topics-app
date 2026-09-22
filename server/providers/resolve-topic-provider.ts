import type { AIProvider } from './types';

/** Same routability rule as shared/task-coding-models.ts#isRoutableThroughTopics,
 * restated here because chat resolves against the live registry, not a
 * providers snapshot: only the Claude-family runtimes have a native path. */
const TOPICS_ROUTABLE_PROVIDERS = new Set(['claude-code', 'jcode']);

/** AICTRL-01 canonical rule: an explicit provider never turns ON into a
 * silent no-op. When the pinned provider cannot be reached through the
 * native engine (unroutable model family, or the engine itself down), the
 * turn must be blocked with a reason, never dispatched directly as if OFF. */
export class TopicsRoutingIncompatibleError extends Error {
  readonly code = 'topics_routing_incompatible';
  constructor(readonly provider: string, reason: string) {
    super(reason);
    this.name = 'TopicsRoutingIncompatibleError';
  }
}

/** A pinned runtime must never become a different provider after a restart.
 * AICTRL-01: `topicsRouting` never changes `topic.provider`; ON only redirects
 * EXECUTION to the topics native engine when that provider is reachable
 * through it, keeping the pinned choice visible and unchanged. */
export function resolveTopicProvider(
  topic: { provider?: string | null; topicsRouting?: boolean | null } | null | undefined,
  registry: { getProvider(name: string): AIProvider; getDefaultProvider(): AIProvider },
): AIProvider {
  if (!topic?.provider) return registry.getDefaultProvider();
  const name = topic.provider === 'claude-code-team' ? 'claude-code' : topic.provider;
  if (topic.topicsRouting) {
    if (!TOPICS_ROUTABLE_PROVIDERS.has(name)) {
      throw new TopicsRoutingIncompatibleError(name, `Il routing leggero non instrada verso "${name}". Spegni lo switch o scegli un provider Claude prima di riprendere questa conversazione.`);
    }
    let native: AIProvider;
    try { native = registry.getProvider('topics'); }
    catch { throw new TopicsRoutingIncompatibleError(name, 'Il motore nativo di Topics non è disponibile. Spegni lo switch o riprova più tardi.'); }
    if (!native.connected) throw new TopicsRoutingIncompatibleError(name, 'Il motore nativo di Topics non è connesso. Spegni lo switch o riprova più tardi.');
    return native;
  }
  try { return registry.getProvider(name); }
  catch {
    throw new Error(`Provider "${name}" non disponibile. Collegalo nelle Impostazioni prima di riprendere questa conversazione.`);
  }
}
