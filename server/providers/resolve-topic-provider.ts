import type { AIProvider } from './types';
import type { ProvidersSnapshot } from '../../shared/types';
import { effectiveTopicsRouting, topicsRoute } from '../../shared/task-coding-models';

/** The one case the switch can still refuse: a legacy topic pinned to
 * `provider: "topics"` (AICTRL-04) names the engine itself, so with the engine
 * down there is no "direct" to fall back to. Every other target the engine
 * cannot reach runs direct (MSEL-06), declared, never blocked. */
export class TopicsRoutingIncompatibleError extends Error {
  readonly code = 'topics_routing_incompatible';
  constructor(readonly provider: string, reason: string) {
    super(reason);
    this.name = 'TopicsRoutingIncompatibleError';
  }
}

/** A pinned runtime must never become a different provider after a restart.
 * AICTRL-01: `topicsRouting` never changes `topic.provider`. MSEL-06: the
 * target is resolved first as with the switch OFF (Automatic = the registry
 * default), then `topicsRoute`, scope `chat`, decides whether the engine runs
 * it. A preference never written (`null`) reads ON in a chat. */
export function resolveTopicProvider(
  topic: { provider?: string | null; model?: string | null; topicsRouting?: boolean | null } | null | undefined,
  registry: {
    getProvider(name: string): AIProvider;
    getDefaultProvider(): AIProvider;
    /** I modelli che il motore nativo serve ORA, dallo stesso snapshot che decide la stessa domanda lato task. Assente = chiamante che non lo sa ancora, e la regola resta permissiva: mai piu' severa per un dato che manca. allow-italian: la scelta su cosa fare quando la lista manca */
    getTopicsModels?(): string[] | undefined;
  },
): AIProvider {
  const name = topic?.provider === 'claude-code-team' ? 'claude-code' : topic?.provider || null;
  // Spento: diretto, senza nemmeno chiedere del motore. allow-italian: la scorciatoia del ramo spento
  if (name !== 'topics' && !effectiveTopicsRouting(topic?.topicsRouting, null, 'chat')) return direct(name, registry);
  let native: AIProvider | null = null;
  try { native = registry.getProvider('topics'); } catch { native = null; }
  if (name === 'topics') {
    if (!native?.connected) throw new TopicsRoutingIncompatibleError('topics', 'Questa chat è legata al motore di Topics, che non è connesso. Riprova più tardi o scegli un altro modello dal selettore.');
    return native;
  }
  const fallback = name ? null : registry.getDefaultProvider();
  // The engine as the snapshot would describe it, from the registry this
  // resolver already reads: the same rule as the task side, one function.
  const engine: ProvidersSnapshot = {
    providers: native ? [{
      name: 'topics', status: native.connected ? 'ready' : 'unavailable', isDefault: false,
      requirements: [], fetchedAt: '', models: registry.getTopicsModels?.() ?? [],
    }] : [],
    defaultProvider: null,
    generatedAt: '',
  };
  // Automatic resolves to the default first; a Claude model pinned without a
  // runtime (`/model`, or a card the engine picked) names the Claude family,
  // whatever the default: the engine is then its target.
  const target = name ?? (topic?.model?.startsWith('claude-') ? 'topics' : fallback!.name);
  const route = topicsRoute(topic?.topicsRouting, { provider: target, model: topic?.model ?? null }, engine, 'chat');
  if (route.via === 'topics' && native) return native;
  return fallback ?? direct(name, registry);
}

function direct(name: string | null, registry: { getProvider(name: string): AIProvider; getDefaultProvider(): AIProvider }): AIProvider {
  if (!name) return registry.getDefaultProvider();
  try { return registry.getProvider(name); }
  catch {
    throw new Error(`Provider "${name}" non disponibile. Collegalo da «Provider e chiavi», in fondo al selettore del modello, prima di riprendere questa conversazione.`);
  }
}
