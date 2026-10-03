import type { ProvidersSnapshot } from './types';

/** Provider families the Topics native engine can actually execute. Exported
 * so the chat-side resolver (`resolve-topic-provider.ts`) checks the exact
 * same family, instead of keeping a second, independently-maintained copy of
 * this list (review bug #4: chat and task disagreed on what "routable" means). */
export const CLAUDE_CODING_PROVIDERS = ['topics', 'claude-code', 'jcode'];
const EXPLICIT_RUNTIME_PREFIXES = new Set([...CLAUDE_CODING_PROVIDERS, 'codex']);

function isTaskCodingProvider(entry: ProvidersSnapshot['providers'][number]): boolean {
  if (entry.capabilities !== undefined) return entry.capabilities.includes('coding-tasks');
  return CLAUDE_CODING_PROVIDERS.includes(entry.name) || entry.name === 'codex';
}

export interface TaskExecutionOption {
  name: string;
  label: string;
  status: ProvidersSnapshot['providers'][number]['status'];
  models: string[];
  /**
   * Windows declared by the provider, per model id. Always absent here, since
   * every coding runtime serves models that the static table already knows. It
   * exists so the one menu component can read it on either surface without a
   * cast, and it stays absent on this side on purpose.
   */
  contextWindows?: Record<string, number>;
  supportsAutomatic: boolean;
  reason?: string;
}

/** Discovery is retryable setup, not a failed execution attempt. */
export class TaskProviderPendingError extends Error {
  readonly code = 'task_provider_pending';
  constructor(readonly provider: string) {
    super(`Waiting for ${provider} provider discovery.`);
    this.name = 'TaskProviderPendingError';
  }
}

/**
 * MSEL-06: what a "Run in Topics" preference that was NEVER written means, per
 * scope. Here and only here. A chat reads it ON, a card and the board default
 * read it OFF: a turn through the engine does not survive a server restart and
 * cards are the longest turns (proposal, choice 2). No data is rewritten for
 * this: a `null` column stays `null`, only how it is read changes.
 */
export const TOPICS_ROUTING_DEFAULT = { chat: true, task: false } as const;

export type TopicsRouteScope = keyof typeof TOPICS_ROUTING_DEFAULT;

/** Where a turn goes once the preference and the resolved target are known. */
export type TopicsRoute =
  | { via: 'topics' }
  | { via: 'direct'; reason: 'off' | 'family' | 'model' | 'engine-down' }
  /** The engine catalog is still being discovered: only cards wait for it. */
  | { via: 'pending' };

/** Task model values also carry the routing hint for non-GPT Codex slugs. */
export function taskModelSelection(value?: string | null): { model?: string; provider?: string } {
  const model = value?.trim();
  if (!model || model === 'auto') return {};
  if (model === 'codex') return { provider: 'codex' };
  const separator = model.indexOf(':');
  if (separator > 0) {
    const provider = model.slice(0, separator);
    if (EXPLICIT_RUNTIME_PREFIXES.has(provider)) {
      const selectedModel = model.slice(separator + 1);
      return { provider, model: selectedModel === 'auto' ? undefined : selectedModel || undefined };
    }
  }
  if (model.startsWith('gpt-')) return { provider: 'codex', model };
  return { model };
}

/** Persist runtime and model in the existing task model field. Model-only
 * legacy values stay readable; new explicit choices are unambiguous. */
export function taskModelValue(provider: string, model?: string | null): string {
  return `${provider}:${model || 'auto'}`;
}

/** Server-authored coding capability plus the model-family boundary each
 * adapter really supports. Unready rows remain visible for explicit recovery. */
export function taskExecutionOptions(snapshot?: ProvidersSnapshot | null): TaskExecutionOption[] {
  return (snapshot?.providers ?? []).flatMap((entry) => {
    // Topics is the routing switch above this list (AICTRL-01), not a provider
    // row: it stays a real, selectable registry entry for resolution, just
    // never a synthetic menu choice.
    if (entry.name === 'topics') return [];
    if (!isTaskCodingProvider(entry)) return [];
    const models = entry.name === 'codex'
      ? entry.models
      : entry.models.filter((model) => model.startsWith('claude-'));
    return [{
      name: entry.name,
      label: entry.label ?? entry.name,
      status: entry.status,
      models,
      supportsAutomatic: entry.name !== 'jcode',
      reason: entry.lastError ?? entry.requirements.find((requirement) => !requirement.present)?.hint,
    }];
  });
}

/** Only executable coding catalogs: API chat connections are not task agents. */
export function availableTaskModels(snapshot?: ProvidersSnapshot | null): string[] {
  const models = new Set<string>();
  for (const entry of snapshot?.providers ?? []) {
    if (entry.status !== 'ready' || !isTaskCodingProvider(entry)) continue;
    if (CLAUDE_CODING_PROVIDERS.includes(entry.name)) {
      for (const model of entry.models) if (model.startsWith('claude-')) models.add(model);
    } else if (entry.name === 'codex') {
      for (const model of entry.models) models.add(model.startsWith('gpt-') ? model : `codex:${model}`);
      // A ready Codex installation can use its own default without a warm
      // model cache. This is a provider choice, not a guessed model id.
      if (!entry.models.length) models.add('codex');
    }
  }
  return [...models];
}

/** Names another runtime offers for a model the native engine lists under a
 * different id. The Claude Code picker says `claude-haiku-4-5`, the engine's
 * probed catalog says `claude-haiku-4-5-20251001`: without this table the
 * routing switch called the same model unroutable. The routing rule and the
 * engine both read it (`isTopicsModelServed`, and the engine's turn model), so
 * an alias added here is served and executed under the catalog id in one step. */
const NATIVE_MODEL_ALIASES: Record<string, string> = {
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
};

/** The id the native engine runs for `model`: its catalog id when `model` is an alias. */
export function nativeModelId(model: string): string {
  return NATIVE_MODEL_ALIASES[model] ?? model;
}

/** AICTRL-05 #4: "il motore serve QUESTO modello ora", un helper solo condiviso col lato chat invece di due copie che derivano. `nativeModels` assente = non verificabile, e la regola resta permissiva: mai piu' severa per un dato che manca. allow-italian: la scelta su cosa fare quando il dato manca */
export function isTopicsModelServed(model: string | null | undefined, nativeModels: string[] | undefined): boolean {
  return !model || !nativeModels || nativeModels.includes(nativeModelId(model));
}

/** Discovery still running is not a verdict. A `topics` catalog in `loading`,
 * or a snapshot that has not been assembled yet, cannot say whether the native
 * engine reaches a target: retrying answers it, so the task path defers and
 * requeues instead of parking the card forever. A `topics` entry MISSING from
 * a real snapshot is the other thing: the engine is not there at all. */
export function topicsCatalogPending(snapshot?: ProvidersSnapshot | null): boolean {
  if (!snapshot) return true;
  return snapshot.providers.some((entry) => entry.name === 'topics' && entry.status === 'loading');
}

/** Whether the switch ON runs this runtime and model through the engine: the
 * same answer as `topicsRoute` with the preference ON. A null provider means
 * Automatic, routable while the engine is ready. */
export function topicsRoutingAvailable(
  provider: string | null,
  model: string | null | undefined,
  snapshot?: ProvidersSnapshot | null,
): boolean {
  return topicsRoute(true, { provider, model }, snapshot, 'chat').via === 'topics';
}

/** AICTRL-04 + MSEL-06: the preference as a boolean. Anything written, true or
 * false, always wins. A value never written (`null`/`undefined`) reads ON for
 * the legacy `topics:<model>` encoding (a task saved before the switch existed
 * stored its "run via Topics" decision in the model value), and otherwise the
 * default of its scope (`TOPICS_ROUTING_DEFAULT`). */
export function effectiveTopicsRouting(
  topicsRouting: boolean | null | undefined,
  modelValue?: string | null,
  scope: TopicsRouteScope = 'task',
): boolean {
  if (topicsRouting != null) return topicsRouting;
  if (taskModelSelection(modelValue).provider === 'topics') return true;
  return TOPICS_ROUTING_DEFAULT[scope];
}

/**
 * MSEL-06: THE one reading of the preference. Every reader (menu, send gate,
 * chat resolver, dispatched topic identity, dispatcher, automatic picker) asks
 * this instead of keeping its own `!!`, `?? false` or `if`.
 *
 * `target` is ALREADY resolved the way the switch OFF would resolve it:
 * Automatic in a chat is the default provider, on a card the classifier's pick
 * (or Codex when Codex is the default). A `null` provider here means "nobody
 * named one": the engine decides, so it routes while the engine is ready.
 *
 * The order: the preference; a provider outside the Claude family goes direct;
 * the engine missing or down goes direct (a card waits while it is still being
 * discovered); a model the engine does not serve goes direct; else Topics.
 * The legacy `provider: 'topics'` is the engine itself, never "direct".
 */
export function topicsRoute(
  stored: boolean | null | undefined,
  target: { provider: string | null; model: string | null | undefined },
  snapshot: ProvidersSnapshot | null | undefined,
  scope: TopicsRouteScope,
  modelValue?: string | null,
): TopicsRoute {
  const engineOnly = target.provider === 'topics';
  if (!engineOnly && !effectiveTopicsRouting(stored, modelValue, scope)) return { via: 'direct', reason: 'off' };
  if (target.provider !== null && !CLAUDE_CODING_PROVIDERS.includes(target.provider)) return { via: 'direct', reason: 'family' };
  const engine = snapshot?.providers.find((entry) => entry.name === 'topics');
  if (!engine || engine.status !== 'ready') {
    if (scope === 'task' && topicsCatalogPending(snapshot)) return { via: 'pending' };
    return { via: 'direct', reason: 'engine-down' };
  }
  // An empty catalog is a snapshot still warming up, not a refusal (as `isTopicsModelServed` reads `undefined`).
  if (!isTopicsModelServed(target.model ?? null, engine.models.length ? engine.models : undefined)) return { via: 'direct', reason: 'model' };
  return { via: 'topics' };
}

/** Resolve only executable coding runtimes; an API-chat default is never a fallback.
 * `topicsRouting` is the switch from AICTRL-01: it never changes provider or
 * model. MSEL-06: the target is resolved first exactly as with the switch OFF
 * (Automatic follows the coding default, Codex included), then `topicsRoute`
 * decides whether the engine runs it. A target the engine cannot reach runs
 * direct, never a block: the route is declared, not refused. */
export function taskProviderForModel(
  value: string | null | undefined,
  snapshot?: ProvidersSnapshot | null,
  topicsRouting?: boolean,
): string {
  const target = directTaskProvider(value, snapshot);
  if (!topicsRouting) return target;
  const route = topicsRoute(true, { provider: target, model: taskModelSelection(value).model ?? null }, snapshot, 'task');
  if (route.via === 'pending') throw new TaskProviderPendingError('topics');
  return route.via === 'topics' ? 'topics' : target;
}

/** The runtime a task value names with the switch OFF. */
function directTaskProvider(value: string | null | undefined, snapshot?: ProvidersSnapshot | null): string {
  const selection = taskModelSelection(value);
  const ready = snapshot?.providers.filter((entry) => entry.status === 'ready' && isTaskCodingProvider(entry)) ?? [];
  // A coding default of Codex is also a provider constraint. Its temporary
  // loading state must not route an automatic GPT task onto ready Claude.
  const explicitlySelectedProvider = selection.provider;
  if (explicitlySelectedProvider) {
    const selected = snapshot?.providers.find((entry) => entry.name === explicitlySelectedProvider);
    if (selected?.status === 'loading') throw new TaskProviderPendingError(explicitlySelectedProvider);
    if (!selected || selected.status !== 'ready' || !ready.some((entry) => entry.name === explicitlySelectedProvider)) {
      const providerLabel = selected?.label ?? (explicitlySelectedProvider === 'codex' ? 'Codex' : explicitlySelectedProvider);
      throw new Error(`${providerLabel} is unavailable. Connect it in Settings before starting the task.`);
    }
    if (selection.model && !selected.models.includes(selection.model)) {
      throw new Error(`The selected coding runtime ${selected.label ?? selected.name} cannot run model "${selection.model}".`);
    }
    return explicitlySelectedProvider;
  }
  const wantsCodex = !selection.model && snapshot?.defaultProvider === 'codex';
  if (wantsCodex) {
    if (snapshot?.providers.find(entry => entry.name === 'codex')?.status === 'loading') {
      throw new TaskProviderPendingError('codex');
    }
    if (ready.some((entry) => entry.name === 'codex')) return 'codex';
    throw new Error('Codex is unavailable. Connect it in Settings before starting the task.');
  }
  const compatible = selection.model
    // The engine lists some models under another id (an alias, `nativeModelId`).
    ? ready.filter((entry) => CLAUDE_CODING_PROVIDERS.includes(entry.name)
      && (entry.models.includes(selection.model!) || (entry.name === 'topics' && entry.models.includes(nativeModelId(selection.model!)))))
    : ready;
  const provider = compatible.find((entry) => entry.name === snapshot?.defaultProvider)?.name ?? compatible[0]?.name;
  if (provider) return provider;
  if (selection.model) throw new Error(`No coding agent is available for model "${selection.model}". Choose an available model in Settings.`);
  throw new Error('No coding agent is available. Connect Topics, Claude Code or Codex in Settings before starting the task.');
}

/** MSEL-06, a reused session: the switch the dependent runs it with. The
 * session keeps its own switch (`null` there is a card topic from before the
 * column existed, read with the card scope). A dependent whose preference was
 * NEVER written (the card's and the board default's both `null`, no legacy
 * `topics:` prefix) adopts the session's: it defends no value anybody chose,
 * and parking it would block every such card on any session dispatched with
 * the switch OFF. A written preference is the dependent's own and is defended. */
export function reusedSessionRouting(
  value: string | null | undefined,
  session: { topicsRouting?: boolean | null } | null | undefined,
  stored: boolean | null | undefined,
): boolean {
  const sessionRouting = session?.topicsRouting ?? TOPICS_ROUTING_DEFAULT.task;
  if (stored == null && taskModelSelection(value).provider !== 'topics') return sessionRouting;
  return effectiveTopicsRouting(stored, value, 'task');
}

/** How a reused session runs, against how the dependent asks to run (S1, S3).
 * The turn goes on the reused topic, whose own switch decides who executes it
 * (resolveTopicProvider): the engine with it ON, the pinned runtime directly
 * with it OFF. So a dependent whose written switch differs, whatever it names
 * (Automatic, a bare model, a provider), would make its switch a silent no-op:
 * returns the session's switch then. `topicsRouting` is the dependent's STORED
 * preference, `null` when never written (see reusedSessionRouting). With the
 * switch OFF on both sides an explicit provider also names who runs the turn,
 * the engine itself (the legacy `topics:`) or a provider directly: returns
 * where the session runs when it is not that. */
export function reusedSessionRouteConflict(
  value: string | null | undefined,
  session: { provider?: string | null; topicsRouting?: boolean | null } | null | undefined,
  topicsRouting: boolean | null | undefined,
): 'switch-on' | 'switch-off' | 'engine' | 'direct' | null {
  if (!session) return null;
  const sessionRouting = session.topicsRouting ?? TOPICS_ROUTING_DEFAULT.task;
  if (reusedSessionRouting(value, session, topicsRouting) !== sessionRouting) return sessionRouting ? 'switch-on' : 'switch-off';
  const selected = taskModelSelection(value);
  if (sessionRouting || !selected.provider) return null;
  const sessionOnEngine = session.provider === 'topics';
  if (sessionOnEngine === (selected.provider === 'topics')) return null;
  return sessionOnEngine ? 'engine' : 'direct';
}

/** A reused conversation must be a coding runtime, run with the dependent's
 * switch and on the route an explicit provider asks for (`topicsRouting` is the
 * dependent's stored preference; see reusedSessionRouteConflict), and honor an
 * explicit model. A session bound to the engine with the switch ON (`provider:
 * 'topics'`, no runtime pinned) is a Claude Code session the engine routes, so
 * an explicit Claude Code target with its model and the switch ON continues it.
 * With the switch OFF the engine is the runtime itself, not a route to Claude
 * Code, and reusedSessionRouteConflict already refused that pairing. */
export function taskModelMatchesSession(
  value: string | null | undefined,
  session?: { provider?: string | null; model?: string | null; topicsRouting?: boolean | null } | null,
  topicsRouting?: boolean | null,
): boolean {
  const selected = taskModelSelection(value);
  if (!session) return false;
  const provider = session.provider === 'claude-code-team' ? 'claude-code' : session.provider;
  if (!provider || (provider !== 'codex' && !CLAUDE_CODING_PROVIDERS.includes(provider))) return false;
  if (reusedSessionRouteConflict(value, session, topicsRouting)) return false;
  if (!selected.model && !selected.provider) return true;
  if (selected.provider === 'codex') {
    return provider === 'codex' && (!selected.model || selected.model === session.model);
  }
  if (selected.provider) {
    const sameRuntime = provider === selected.provider || (provider === 'topics' && selected.provider === 'claude-code');
    return sameRuntime && (!selected.model || selected.model === session.model);
  }
  return CLAUDE_CODING_PROVIDERS.includes(provider) && selected.model === session.model;
}
