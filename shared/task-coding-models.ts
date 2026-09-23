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

/** AICTRL-01: ON with Automatico must genuinely dispatch through the native
 * Topics engine, which then chooses per its own rules — never silently fall
 * back to whatever provider a plain OFF resolution would have picked. When
 * the native engine or the requested model isn't reachable through it, this
 * is a hard gate, not a fallback: the caller surfaces the reason. */
export class TopicsRoutingUnavailableError extends Error {
  readonly code = 'topics_routing_unavailable';
  constructor(readonly provider: string | null, readonly model: string | null) {
    super(provider
      ? `Topics routing cannot dispatch to "${provider}"${model ? ` for model "${model}"` : ''}. Turn the switch off or choose a routable provider before starting the task.`
      : model
        ? `Topics routing cannot run model "${model}". Turn the switch off or choose a routable model before starting the task.`
        : 'The Topics routing engine is unavailable. Turn the switch off or reconnect it before starting the task.');
    this.name = 'TopicsRoutingUnavailableError';
  }
}

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

/** AICTRL-05 #4: "il motore serve QUESTO modello ora", un helper solo condiviso col lato chat invece di due copie che derivano. `nativeModels` assente = non verificabile, e la regola resta permissiva: mai piu' severa per un dato che manca. allow-italian: la scelta su cosa fare quando il dato manca */
export function isTopicsModelServed(model: string | null | undefined, nativeModels: string[] | undefined): boolean {
  return !model || !nativeModels || nativeModels.includes(model);
}

/** A provider is reachable through the Topics native engine only if that
 * engine is itself ready and actually serves the requested model. Codex is
 * never routable: the native engine has no OpenAI-compatible execution path. */
function isRoutableThroughTopics(
  provider: string,
  model: string | undefined,
  ready: ProvidersSnapshot['providers'],
): boolean {
  if (provider === 'topics' || !CLAUDE_CODING_PROVIDERS.includes(provider)) return false;
  const native = ready.find((entry) => entry.name === 'topics');
  if (!native) return false;
  return isTopicsModelServed(model, native.models);
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

/** The routing gate only waits for a target the engine could ever reach:
 * Codex is categorically outside it, so a warm-up never changes that answer. */
export function topicsRoutingWaitsForCatalog(provider: string | null, snapshot?: ProvidersSnapshot | null): boolean {
  if (provider !== null && !CLAUDE_CODING_PROVIDERS.includes(provider)) return false;
  return topicsCatalogPending(snapshot);
}

/** Same routability check, for the menu's switch row: null provider means
 * Automatic, which is always routable (topics picks per its own rules). */
export function topicsRoutingAvailable(
  provider: string | null,
  model: string | null | undefined,
  snapshot?: ProvidersSnapshot | null,
): boolean {
  if (provider === null) return (snapshot?.providers ?? []).some((entry) => entry.name === 'topics' && entry.status === 'ready');
  const ready = snapshot?.providers.filter((entry) => entry.status === 'ready' && isTaskCodingProvider(entry)) ?? [];
  return isRoutableThroughTopics(provider, model ?? undefined, ready);
}

/** AICTRL-04: a task created before this switch existed stored its "run via
 * Topics" decision by prefixing the model value itself (`topics:<model>`). A
 * routing field that was never set explicitly (`null`/`undefined`) still
 * reads as ON for that legacy encoding; anything set explicitly, true or
 * false, always wins over the old prefix. */
export function effectiveTopicsRouting(topicsRouting: boolean | null | undefined, modelValue?: string | null): boolean {
  if (topicsRouting != null) return topicsRouting;
  return taskModelSelection(modelValue).provider === 'topics';
}

/** Resolve only executable coding runtimes; an API-chat default is never a fallback.
 * `topicsRouting` is the switch from AICTRL-01: it never changes provider or
 * model, only whether the turn is dispatched through the Topics native engine
 * targeting that same selection (ON) or straight to the provider (OFF). */
export function taskProviderForModel(
  value: string | null | undefined,
  snapshot?: ProvidersSnapshot | null,
  topicsRouting?: boolean,
): string {
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
    if (topicsRouting) {
      // Legacy AICTRL-04 encoding: `topics:<model>` already meant "run
      // native", never a pin to a target provider — isRoutableThroughTopics
      // rightly refuses 'topics' as a target (it's the router, not one of
      // its destinations), so that check does not apply to this value.
      if (explicitlySelectedProvider === 'topics') return 'topics';
      // ON never falls through to a direct dispatch as a silent no-op: an
      // explicit provider Topics can't reach (Codex, categorically) is a
      // hard gate with a reason, the same contract the chat side enforces.
      if (isRoutableThroughTopics(explicitlySelectedProvider, selection.model, ready)) return 'topics';
      if (topicsRoutingWaitsForCatalog(explicitlySelectedProvider, snapshot)) throw new TaskProviderPendingError('topics');
      throw new TopicsRoutingUnavailableError(explicitlySelectedProvider, selection.model ?? null);
    }
    return explicitlySelectedProvider;
  }
  // Automatico + ON: Topics picks per its own rules, and that beats even a
  // Codex default — the switch is a routing decision, not a suggestion.
  if (topicsRouting) {
    const native = ready.find((entry) => entry.name === 'topics');
    if (native && (!selection.model || native.models.includes(selection.model))) return 'topics';
    if (topicsCatalogPending(snapshot)) throw new TaskProviderPendingError('topics');
    throw new TopicsRoutingUnavailableError(null, selection.model ?? null);
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
    ? ready.filter((entry) => CLAUDE_CODING_PROVIDERS.includes(entry.name) && entry.models.includes(selection.model!))
    : ready;
  const provider = compatible.find((entry) => entry.name === snapshot?.defaultProvider)?.name ?? compatible[0]?.name;
  if (provider) return provider;
  if (selection.model) throw new Error(`No coding agent is available for model "${selection.model}". Choose an available model in Settings.`);
  throw new Error('No coding agent is available. Connect Topics, Claude Code or Codex in Settings before starting the task.');
}

/** A reused conversation must be a coding runtime and honor an explicit model. */
export function taskModelMatchesSession(
  value: string | null | undefined,
  session?: { provider?: string | null; model?: string | null } | null,
): boolean {
  const selected = taskModelSelection(value);
  if (!session) return false;
  const provider = session.provider === 'claude-code-team' ? 'claude-code' : session.provider;
  if (!provider || (provider !== 'codex' && !CLAUDE_CODING_PROVIDERS.includes(provider))) return false;
  if (!selected.model && !selected.provider) return true;
  if (selected.provider === 'codex') {
    return provider === 'codex' && (!selected.model || selected.model === session.model);
  }
  if (selected.provider) {
    return provider === selected.provider && (!selected.model || selected.model === session.model);
  }
  return CLAUDE_CODING_PROVIDERS.includes(provider) && selected.model === session.model;
}
