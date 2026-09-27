import {
  taskModelSelection,
  taskProviderForModel,
  topicsCatalogPending,
  TaskProviderPendingError,
  topicsRoutingAvailable,
  TopicsRoutingUnavailableError,
} from '../../shared/task-coding-models';
import { EFFORT_TIERS } from '../../shared/effort';
import { PLAN_DISPATCH_HOLD_AT, providerHoldKey } from '../../shared/provider-hold';
import type { ProvidersSnapshot } from '../../shared/types';
import { isProviderHeld, planUsage } from '../lib/provider-hold';
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

/** General Auto compares eligible runtimes; a legacy provider alias still restricts its catalog.
 *  With the Topics switch ON (AICTRL-01) Topics picks by its own rules, so the
 *  catalog holds only targets the native engine reaches: picking Codex there
 *  parked the card with "Topics routing cannot dispatch". The engine itself is
 *  the router, not a target: pinned on it, the card was stored as the legacy
 *  `topics:<model>` value and kept running native after the switch went OFF.
 *  Only a legacy `topics:` selection, which already meant "run native", keeps
 *  the engine's own catalog. */
export async function pickAutomaticTaskModel(
  task: { text: string; description?: string | null },
  selection: string | null | undefined,
  deps: {
    snapshot: ProvidersSnapshot | null;
    getProvider: (name: string) => AIProvider | undefined;
    isHeld?: HeldCheck;
    topicsRouting?: boolean;
    requiredEffort?: string;
    codexModels?: typeof readCodexModels;
    log?: (message: string) => void;
  },
) {
  const restrictedProvider = taskModelSelection(selection).provider;
  if (restrictedProvider) taskProviderForModel(selection, deps.snapshot, deps.topicsRouting);
  const isHeld = deps.isHeld ?? (() => false);
  const eligible = automaticTaskModels(deps.snapshot, (deps.codexModels ?? readCodexModels)(), isHeld)
    .filter(model => !restrictedProvider || model.provider === restrictedProvider);
  const models = eligible.filter(model => !deps.topicsRouting || (model.provider === 'topics'
    ? restrictedProvider === 'topics'
    : topicsRoutingAvailable(model.provider, model.slug, deps.snapshot)));
  // The switch emptied a catalog that had runtimes: the reason is the switch,
  // not the effort. Without this the card parked with "choose a compatible
  // effort", which no effort fixes.
  if (!models.length && eligible.length) {
    if (topicsCatalogPending(deps.snapshot)) throw new TaskProviderPendingError('topics');
    throw new TopicsRoutingUnavailableError(null, null);
  }
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

/** The dispatcher's three questions about Automatic, answered from the live
 *  snapshot and the provider holds: which runtime a selection resolves to,
 *  whether any runtime is free, and the pick itself. server.ts injects only
 *  the readers, so the wiring a test drives is the one production runs. */
export function automaticDispatchHooks(env: {
  snapshot: () => ProvidersSnapshot;
  getProvider: (name: string) => AIProvider | undefined;
  codexModels?: typeof readCodexModels;
  log?: (message: string) => void;
}) {
  const codexModels = env.codexModels ?? readCodexModels;
  return {
    resolveTaskProvider: (model?: string | null, topicsRouting?: boolean) => taskProviderForModel(model, env.snapshot(), topicsRouting),
    // AGPT-01 extended: an unconstrained Auto task may start on ANY ready
    // runtime that is not held right now, whichever one that is.
    automaticModelAvailable: () => {
      const snapshot = env.snapshot();
      return automaticTaskModels(snapshot, codexModels(), provider => isProviderHeld(provider)).length > 0
        || snapshot.providers.some(provider => provider.status === 'loading' && !isProviderHeld(provider.name));
    },
    pickAutoModel: (
      task: { text: string; description?: string | null },
      selection?: string,
      options?: { effort?: string; topicsRouting?: boolean },
    ) => {
      const window = planUsage()?.fiveHour;
      const claudeApproachingLimit = !!window && window.utilization >= PLAN_DISPATCH_HOLD_AT && (window.resetsAtMs ?? 0) > Date.now();
      return pickAutomaticTaskModel(task, selection, {
        snapshot: env.snapshot(),
        getProvider: env.getProvider,
        // Any provider under its own hold is excluded, not only Claude. Claude
        // keeps one extra reason: the approaching-limit window has no Codex
        // equivalent (Codex has no usage endpoint).
        isHeld: provider => isProviderHeld(provider) || (providerHoldKey(provider) === 'claude' && claudeApproachingLimit),
        // AICTRL-01: with the switch ON only what Topics routes is a candidate.
        topicsRouting: options?.topicsRouting,
        requiredEffort: options?.effort && options.effort !== 'auto' ? options.effort : undefined,
        codexModels,
        log: env.log,
      });
    },
  };
}
