import { readFileSync } from 'fs';
import { join } from 'path';
import type { ModelInfo } from '../../../shared/types';

export interface CodexModel {
  slug: string;
  description: string;
  defaultEffort: string | null;
  efforts: string[];
  /** `display_name` of the cache. */
  label?: string;
  /** `context_window`: the window Codex works with by default (not `max_context_window`). */
  contextWindow?: number;
  /** `priority`: lower comes first in the CLI's own picker. */
  priority?: number;
  /** `upgrade.retirement_at` and `upgrade.model`, when the cache announces a retirement. */
  retiresAt?: string;
  replacement?: string;
}

/** Account-specific CLI catalog. Never turn missing cache data into guessed IDs. */
export function readCodexModels(cachePath = join(process.env.CODEX_HOME || join(process.env.HOME || '', '.codex'), 'models_cache.json')): CodexModel[] {
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as { models?: unknown };
    if (!Array.isArray(parsed.models)) return [];
    const seen = new Set<string>();
    return parsed.models.flatMap((model): CodexModel[] => {
      if (!model || typeof model.slug !== 'string' || !model.slug.trim() || model.visibility !== 'list' || seen.has(model.slug)) return [];
      seen.add(model.slug);
      return [{
        slug: model.slug,
        description: typeof model.description === 'string' ? model.description.slice(0, 400) : '',
        defaultEffort: typeof model.default_reasoning_level === 'string' ? model.default_reasoning_level : null,
        efforts: Array.isArray(model.supported_reasoning_levels)
          ? model.supported_reasoning_levels.flatMap((level: { effort?: unknown } | null) => typeof level?.effort === 'string' ? [level.effort] : []) : [],
        ...(typeof model.display_name === 'string' && model.display_name.trim() ? { label: model.display_name.trim() } : {}),
        ...(typeof model.context_window === 'number' && model.context_window > 0 ? { contextWindow: model.context_window } : {}),
        ...(typeof model.priority === 'number' ? { priority: model.priority } : {}),
        ...(typeof model.upgrade?.retirement_at === 'string' ? { retiresAt: model.upgrade.retirement_at } : {}),
        ...(typeof model.upgrade?.model === 'string' ? { replacement: model.upgrade.model } : {}),
      }];
    });
  } catch { return []; }
}

/**
 * The model a turn should name when nobody picked one.
 *
 * `codex exec` without `--model` takes `model` from ~/.codex/config.toml, and
 * that file is edited by hand and by the desktop app. On 23/09 it said
 * `gpt-6-sol`, which is not in this account's catalog: every Topics turn that
 * left the model to the CLI died with 400 "The 'gpt-6-sol' model is not
 * supported when using Codex with a ChatGPT account". The picker was right, the
 * default underneath it was not.
 *
 * So: when the configured default is missing from a non-empty catalog, name the
 * first listed model instead. An empty catalog (not fetched yet) proves
 * nothing, and the CLI keeps its own choice.
 */
export function codexFallbackModel(configured: string | null, catalog: readonly string[]): string | null {
  if (!configured || catalog.length === 0 || catalog.includes(configured)) return null;
  return catalog[0] ?? null;
}

/**
 * The `model = "..."` line of ~/.codex/config.toml, top level only. A TOML
 * literal string (`model = '...'`) is the same value written by hand.
 */
export function readCodexConfiguredModel(configPath = join(process.env.CODEX_HOME || join(process.env.HOME || '', '.codex'), 'config.toml')): string | null {
  try {
    for (const line of readFileSync(configPath, 'utf8').split('\n')) {
      if (line.trimStart().startsWith('[')) return null;
      const m = /^\s*model\s*=\s*(?:"([^"]+)"|'([^']+)')/.exec(line);
      if (m) return (m[1] ?? m[2])!;
    }
  } catch { /* no config: the CLI uses its built-in default */ }
  return null;
}

/** `gpt-6.1-sol` → 6. The generation a GPT slug belongs to; null for a slug
 *  that does not carry one (an account-specific codename). */
function majorVersion(slug: string): number | null {
  const m = /^gpt-(\d+)/.exec(slug);
  return m ? Number(m[1]) : null;
}

/**
 * MSEL-09: the cache's metadata, per model, as the snapshot carries it. The
 * CURRENT generation is the one of the first model by `priority` (the order
 * the CLI itself lists them in): on the cache measured on 2026-10-02 that is
 * 6.1-Sol, 6-Astra, 6-Sol and 6-Luna; the 5.x line is `older`. A slug with no
 * readable generation stays current: nothing is folded on a guess.
 */
export function codexModelInfo(models: readonly CodexModel[]): Record<string, ModelInfo> {
  const ranked = [...models].sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER));
  const lead = ranked.map((model) => majorVersion(model.slug)).find((major) => major !== null) ?? null;
  return Object.fromEntries(models.map((model) => {
    const major = majorVersion(model.slug);
    const info: ModelInfo = {
      ...(model.label ? { label: model.label } : {}),
      ...(model.description ? { description: model.description } : {}),
      ...(model.retiresAt ? { retiresAt: model.retiresAt } : {}),
      ...(model.replacement ? { replacement: model.replacement } : {}),
      generation: lead !== null && major !== null && major < lead ? 'older' : 'current',
    };
    return [model.slug, info];
  }));
}

/** The windows the cache declares, per model (`context_window`). */
export function codexContextWindows(models: readonly CodexModel[]): Record<string, number> {
  return Object.fromEntries(models.flatMap((model) => model.contextWindow ? [[model.slug, model.contextWindow]] : []));
}
