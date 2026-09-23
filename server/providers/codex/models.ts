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

/** The `model = "..."` line of ~/.codex/config.toml, top level only. */
export function readCodexConfiguredModel(configPath = join(process.env.CODEX_HOME || join(process.env.HOME || '', '.codex'), 'config.toml')): string | null {
  try {
    for (const line of readFileSync(configPath, 'utf8').split('\n')) {
      if (line.trimStart().startsWith('[')) return null;
      const m = /^\s*model\s*=\s*"([^"]+)"/.exec(line);
      if (m) return m[1]!;
    }
  } catch { /* no config: the CLI uses its built-in default */ }
  return null;
}
