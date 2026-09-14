import type { ProvidersSnapshot } from './types';

const CLAUDE_CODING_PROVIDERS = ['topics', 'claude-code', 'jcode'];
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
   * Windows declared by the provider, per model id. Always absent here: the
   * coding runtimes serve models the shared table already knows. The field
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

/** Resolve only executable coding runtimes; an API-chat default is never a fallback. */
export function taskProviderForModel(value: string | null | undefined, snapshot?: ProvidersSnapshot | null): string {
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
