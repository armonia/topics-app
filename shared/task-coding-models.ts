import type { ProvidersSnapshot } from './types';

const CLAUDE_CODING_PROVIDERS = ['topics', 'claude-code', 'jcode'];

/** Discovery is retryable setup, not a failed execution attempt. */
export class TaskProviderPendingError extends Error {
  readonly code = 'task_provider_pending';
  constructor(readonly provider: string) {
    super(`Waiting for ${provider} provider discovery.`);
    this.name = 'TaskProviderPendingError';
  }
}

/** Task model values also carry the routing hint for non-GPT Codex slugs. */
export function taskModelSelection(value?: string | null): { model?: string; provider?: 'codex' } {
  const model = value?.trim();
  if (!model || model === 'auto') return {};
  if (model === 'codex') return { provider: 'codex' };
  if (model.startsWith('codex:')) return { provider: 'codex', model: model.slice(6) || undefined };
  if (model.startsWith('gpt-')) return { provider: 'codex', model };
  return { model };
}

/** Only executable coding catalogs: API chat connections are not task agents. */
export function availableTaskModels(snapshot?: ProvidersSnapshot | null): string[] {
  const models = new Set<string>();
  for (const entry of snapshot?.providers ?? []) {
    if (entry.status !== 'ready') continue;
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
  const ready = snapshot?.providers.filter((entry) => entry.status === 'ready'
    && (CLAUDE_CODING_PROVIDERS.includes(entry.name) || entry.name === 'codex')) ?? [];
  // A coding default of Codex is also a provider constraint. Its temporary
  // loading state must not route an automatic GPT task onto ready Claude.
  const wantsCodex = selection.provider === 'codex' || (!selection.model && snapshot?.defaultProvider === 'codex');
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
  return CLAUDE_CODING_PROVIDERS.includes(provider) && selected.model === session.model;
}
