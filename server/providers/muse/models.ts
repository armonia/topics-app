import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { ModelInfo } from '../../../shared/types';

export interface MuseModel {
  /** Catalog `model_id` (`muse-spark-1.3-contributor`). */
  slug: string;
  /** `display_label`, when it says something different from the slug. */
  label?: string;
  description: string;
  /** `context_limit`: the window the model works with. */
  contextWindow?: number;
  /** Catalog `is_default`: the model the CLI serves without `--model`. */
  isDefault?: boolean;
  /** `reasoning_effort_variants[].tier`: the tiers this model exposes. */
  efforts: string[];
}

/**
 * The model when nothing at all is known: the default measured 06/10
 * (catalog-cache `is_default + is_current`, `model` in settings.json).
 * Never an invented id: if the CLI no longer knows it, the server falls back
 * to its default and the turn still succeeds (measured).
 */
export const MUSE_STATIC_FALLBACK_MODEL = 'muse-spark-1.3-contributor';

/**
 * Where the CLI keeps the catalog: `~/.local/share/muse/model-catalog/*.json`
 * (one file per `provider__profile`, e.g. `6d657461__p746268.json` for
 * meta/tbh). `XDG_DATA_HOME` wins when set; the explicit path —
 * for tests — wins over everything.
 */
export function museCatalogDir(dir?: string): string {
  if (dir) return dir;
  const dataHome = process.env.XDG_DATA_HOME || join(process.env.HOME || '', '.local/share');
  return join(dataHome, 'muse', 'model-catalog');
}

/**
 * Model catalog from the CLI cache. Only `visibility == "visible"`
 * (the image model is `hidden`), deduped by slug. Missing or unreadable cache →
 * empty list, which means "use the CLI default".
 */
export function readMuseModels(dir?: string): MuseModel[] {
  const seen = new Set<string>();
  const out: MuseModel[] = [];
  let files: string[];
  try {
    files = readdirSync(museCatalogDir(dir)).filter((f) => f.endsWith('.json')).sort();
  } catch { return []; }
  for (const file of files) {
    let rows: unknown;
    try {
      rows = (JSON.parse(readFileSync(join(museCatalogDir(dir), file), 'utf8')) as { rows?: unknown }).rows;
    } catch { continue; }
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      if (typeof r.model_id !== 'string' || !r.model_id.trim() || r.visibility !== 'visible' || seen.has(r.model_id)) continue;
      seen.add(r.model_id);
      out.push({
        slug: r.model_id,
        ...(typeof r.display_label === 'string' && r.display_label.trim() && r.display_label.trim() !== r.model_id
          ? { label: r.display_label.trim() } : {}),
        description: typeof r.description === 'string' ? r.description.slice(0, 400) : '',
        ...(typeof r.context_limit === 'number' && r.context_limit > 0 ? { contextWindow: r.context_limit } : {}),
        ...(r.is_default === true ? { isDefault: true } : {}),
        efforts: Array.isArray(r.reasoning_effort_variants)
          ? effortTiers(r.reasoning_effort_variants) : [],
      });
    }
  }
  return out;
}

function effortTiers(variants: unknown[]): string[] {
  return variants.flatMap((v) => (v && typeof v === 'object' && typeof (v as Record<string, unknown>).tier === 'string'
    ? [(v as Record<string, unknown>).tier as string] : []));
}

/**
 * The configured default: the `model` in `~/.config/muse/settings.json`
 * (`XDG_CONFIG_HOME` when set). Missing or unreadable → null, and the CLI
 * decides by itself.
 */
export function readMuseConfiguredModel(configPath?: string): string | null {
  try {
    const path = configPath
      ?? join(process.env.XDG_CONFIG_HOME || join(process.env.HOME || '', '.config'), 'muse', 'settings.json');
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { model?: unknown };
    return typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : null;
  } catch { return null; }
}

/**
 * The model the picker shows as default: the configured one when the
 * catalog confirms it (or when there is no catalog to consult), otherwise
 * the catalog `is_default`, otherwise the static fallback.
 */
export function museDefaultModel(configured: string | null, catalog: readonly MuseModel[]): string {
  if (configured && (catalog.length === 0 || catalog.some((m) => m.slug === configured))) return configured;
  return catalog.find((m) => m.isDefault)?.slug ?? MUSE_STATIC_FALLBACK_MODEL;
}

/** `muse-spark-1.3-contributor` → [1, 3]. Null for a version-less slug. */
function sparkVersion(slug: string): [number, number] | null {
  const m = /^muse-spark-(\d+)\.(\d+)/.exec(slug);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * The catalog metadata as carried by the snapshot: label, description and
 * generation. The CURRENT generation is the highest spark version in the
 * catalog (06/10: 1.3, with 1.2 `older`). A slug with no readable version
 * stays current: nothing bends to a guess.
 */
export function museModelInfo(models: readonly MuseModel[]): Record<string, ModelInfo> {
  const versions = models.map((m) => sparkVersion(m.slug)).filter((v): v is [number, number] => v !== null);
  const lead = versions.reduce<[number, number] | null>((best, v) =>
    !best || v[0] > best[0] || (v[0] === best[0] && v[1] > best[1]) ? v : best, null);
  return Object.fromEntries(models.map((model) => {
    const v = sparkVersion(model.slug);
    const info: ModelInfo = {
      ...(model.label ? { label: model.label } : {}),
      ...(model.description ? { description: model.description } : {}),
      generation: lead !== null && v !== null && (v[0] < lead[0] || (v[0] === lead[0] && v[1] < lead[1]))
        ? 'older' : 'current',
    };
    return [model.slug, info];
  }));
}

/** The windows the catalog declares, per model (`context_limit`). */
export function museContextWindows(models: readonly MuseModel[]): Record<string, number> {
  return Object.fromEntries(models.flatMap((model) => model.contextWindow ? [[model.slug, model.contextWindow]] : []));
}
