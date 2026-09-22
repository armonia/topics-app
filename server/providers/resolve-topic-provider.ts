import type { AIProvider } from './types';
import { CLAUDE_CODING_PROVIDERS, isTopicsModelServed } from '../../shared/task-coding-models';

/** Same family the task side checks (shared/task-coding-models.ts, review
 * bug #4: the two sides used to keep independently-maintained copies of this
 * list and could drift). `topics` itself is excluded: a legacy topic pinned
 * directly to `provider: "topics"` is a stale persisted value, not a routing
 * target — MP-TASK-01/AICTRL-04 handle reading it, not this gate. */
function isTopicsRoutableFamily(provider: string): boolean {
  return provider !== 'topics' && CLAUDE_CODING_PROVIDERS.includes(provider);
}

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
  topic: { provider?: string | null; model?: string | null; topicsRouting?: boolean | null } | null | undefined,
  registry: {
    getProvider(name: string): AIProvider;
    getDefaultProvider(): AIProvider;
    /** I modelli che il motore nativo serve ORA, dallo stesso snapshot che decide la stessa domanda lato task. Assente = chiamante che non lo sa ancora, e la regola resta permissiva: mai piu' severa per un dato che manca. allow-italian: la scelta su cosa fare quando la lista manca */
    getTopicsModels?(): string[] | undefined;
  },
): AIProvider {
  const name = topic?.provider === 'claude-code-team' ? 'claude-code' : topic?.provider || null;
  // ON si controlla PRIMA del ramo "nessun provider pinnato": Automatico+ON passa lo stesso dal motore nativo, non dal default del registry. allow-italian: perche' l'ordine dei rami conta
  if (topic?.topicsRouting) {
    // Legacy AICTRL-04 stale value: `provider: "topics"` was never a pin to
    // a target, it already meant "run native" — isTopicsRoutableFamily
    // rightly excludes 'topics' from the target family, so that exclusion
    // must not also become a block here.
    if (name && name !== 'topics' && !isTopicsRoutableFamily(name)) {
      throw new TopicsRoutingIncompatibleError(name, `Il routing leggero non instrada verso "${name}". Spegni lo switch o scegli un provider Claude prima di riprendere questa conversazione.`);
    }
    // Il modello si controlla anche con Automatico (`name` nullo): con un `name &&` davanti, una chat in Automatico passava senza controllo, cioe' il no-op silenzioso che ON deve rendere impossibile. allow-italian: nomina il buco chiuso qui
    if (topic?.model && !isTopicsModelServed(topic.model, registry.getTopicsModels?.())) {
      throw new TopicsRoutingIncompatibleError(name ?? 'auto', `Il routing leggero non serve il modello "${topic.model}". Spegni lo switch o scegli un modello instradabile prima di riprendere questa conversazione.`);
    }
    let native: AIProvider;
    try { native = registry.getProvider('topics'); }
    catch { throw new TopicsRoutingIncompatibleError(name ?? 'auto', 'Il motore nativo di Topics non è disponibile. Spegni lo switch o riprova più tardi.'); }
    if (!native.connected) throw new TopicsRoutingIncompatibleError(name ?? 'auto', 'Il motore nativo di Topics non è connesso. Spegni lo switch o riprova più tardi.');
    return native;
  }
  if (!name) return registry.getDefaultProvider();
  try { return registry.getProvider(name); }
  catch {
    throw new Error(`Provider "${name}" non disponibile. Collegalo nelle Impostazioni prima di riprendere questa conversazione.`);
  }
}
