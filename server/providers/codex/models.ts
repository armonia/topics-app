import { readFileSync } from 'fs';
import { join } from 'path';

export interface CodexModel {
  slug: string;
  description: string;
  defaultEffort: string | null;
  efforts: string[];
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
      }];
    });
  } catch { return []; }
}
