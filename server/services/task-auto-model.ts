import { taskModelSelection, taskProviderForModel } from '../../shared/task-coding-models';
import { EFFORT_TIERS } from '../../shared/effort';
import type { ProvidersSnapshot } from '../../shared/types';
import { familyOf } from '../providers/claude-models';
import type { AIProvider } from '../providers/types';
import { readCodexModels } from '../providers/codex/models';
import { pickCodingTaskPlan, type CodingModel } from './task-auto-plan';

const CLAUDE_TASK_RUNTIMES = new Set(['topics', 'claude-code']);
const CLAUDE_DESCRIPTIONS: Record<string, string> = {
  haiku: 'Fast affordable model for bounded routine tasks.',
  sonnet: 'Balanced coding workhorse for everyday multi-file work.',
  opus: 'Highly capable model for complex and demanding coding work.',
  fable: 'Highest capability for the hardest reasoning and complex coding work.',
};

/** Whether a runtime is one an unconstrained Auto may still pick: the default
 *  `() => false` is "nothing is held", so an absent predicate changes nothing. */
type HeldCheck = (provider: string) => boolean;

/** AGPT-01: excludes ANY held provider from the candidate pool, not only
 *  Claude. ACP sessions currently omit the Topics bridge, so they are not
 *  automatic task candidates either. */
export function automaticTaskModels(snapshot: ProvidersSnapshot | null, codexModels: ReturnType<typeof readCodexModels>, isHeld: HeldCheck = () => false): CodingModel[] {
  return (snapshot?.providers ?? []).flatMap((entry): CodingModel[] => {
    if (entry.status !== 'ready' || isHeld(entry.name)) return [];
    if (entry.name === 'codex') return codexModels.filter(model => entry.models.includes(model.slug)).map(model => ({ ...model, provider: entry.name }));
    if (!CLAUDE_TASK_RUNTIMES.has(entry.name)) return [];
    return entry.models.filter(model => model.startsWith('claude-')).map(slug => ({
      slug, provider: entry.name, description: CLAUDE_DESCRIPTIONS[familyOf(slug) ?? ''] ?? 'Available Claude coding model.',
      defaultEffort: 'medium', efforts: [...EFFORT_TIERS],
    }));
  });
}

/** Keep the planner's runtime binding through topic creation; model IDs are not provider IDs. */
export function automaticTaskProvider(provider: string, model: string | undefined, snapshot: ProvidersSnapshot | null): string {
  const entry = snapshot?.providers.find(p => p.name === provider);
  if (entry?.status === 'loading') throw Object.assign(new Error(`Waiting for ${provider} provider discovery.`), { code: 'task_provider_pending' });
  if (entry?.status !== 'ready' || !model || !entry.models.includes(model)
    || (provider !== 'codex' && !CLAUDE_TASK_RUNTIMES.has(provider))) {
    throw Object.assign(new Error(`The selected coding runtime ${provider} is unavailable for ${model ?? 'this model'}. Refresh its connection and retry.`), { code: 'task_model_unavailable' });
  }
  return provider;
}

/** General Auto compares eligible runtimes; a legacy provider alias still restricts its catalog. */
export async function pickAutomaticTaskModel(
  task: { text: string; description?: string | null },
  selection: string | null | undefined,
  deps: {
    snapshot: ProvidersSnapshot | null;
    getProvider: (name: string) => AIProvider | undefined;
    isHeld?: HeldCheck;
    requiredEffort?: string;
    codexModels?: typeof readCodexModels;
    log?: (message: string) => void;
  },
) {
  const restrictedProvider = taskModelSelection(selection).provider;
  if (restrictedProvider) taskProviderForModel(selection, deps.snapshot);
  const isHeld = deps.isHeld ?? (() => false);
  const models = automaticTaskModels(deps.snapshot, (deps.codexModels ?? readCodexModels)(), isHeld)
    .filter(model => !restrictedProvider || model.provider === restrictedProvider);
  if (!models.length && deps.snapshot?.providers.some(p => p.status === 'loading'
    && (restrictedProvider ? p.name === restrictedProvider : !isHeld(p.name) && (p.name === 'codex' || CLAUDE_TASK_RUNTIMES.has(p.name))))) {
    throw Object.assign(new Error('Waiting for coding provider discovery.'), { code: 'task_provider_pending' });
  }
  return pickCodingTaskPlan(task, {
    models, requiredEffort: deps.requiredEffort,
    complete: async (prompt, options, providerName) => {
      const provider = deps.getProvider(providerName);
      if (!provider?.connected) throw new Error(`${providerName} is disconnected`);
      return (await provider.complete([{ role: 'user', content: prompt }], options)).content ?? '';
    },
    log: deps.log,
  });
}
