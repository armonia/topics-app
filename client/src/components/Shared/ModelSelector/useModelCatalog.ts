/**
 * THE CATALOG OF THE MODEL SELECTOR, AS PURE LOGIC (MSEL-02, MSEL-04, MSEL-05).
 *
 * The snapshot lists ENGINES (Claude Code, Codex, jcode, the APIs), each with
 * the models it runs. The selector shows MODELS, divided by the company that
 * makes them, with the engine written on the row: the same Sonnet offered by
 * Claude Code and by jcode is one row with two engines, not two rows in two
 * submenus. Everything here is derived from the snapshot; nothing about a
 * model is written by hand in the client (MSEL-09).
 *
 * A module of its own, not inside `ModelList.tsx`, because a component module
 * may only export components (react-refresh/only-export-components) and the
 * tests read these rules without a DOM.
 */
import { useMemo } from 'react';
import type { ProvidersSnapshot, ProviderSnapshotEntry } from '../../../types';
import { useProvidersSnapshot } from '../../../hooks/useProvidersSnapshot';
import type { ModelInfo } from '../../../../../shared/types';
import { MODEL_MAKER_ORDER, modelMaker, type ModelMaker } from '../../../../../shared/modelMaker';
import {
  taskExecutionOptions,
  taskModelSelection,
  type TopicsRouteScope,
} from '../../../../../shared/task-coding-models';
import { friendlyModelLabel } from '../../../lib/modelLabel';
import { fold } from './modelCommand';

/** What a selector holds: a provider and a model. `null` model = Automatic
 *  (within the provider when the provider is set, on cards). */
export interface AiExecutionSelection {
  provider: string | null;
  model: string | null;
}

export interface CatalogEngine {
  name: string;
  label: string;
  status: ProviderSnapshotEntry['status'];
  ready: boolean;
  /** Why it is not ready, when it says. */
  reason?: string;
  /** «Automatico in X» is offered on cards (jcode cannot run it). */
  supportsAutomatic: boolean;
}

export interface CatalogRow {
  /** The id without the `[1m]` suffix: one row per model. */
  key: string;
  /** The id of the base variant, or the long one when only that exists. */
  model: string;
  /** The `[1m]` twin, when an engine offers it: a toggle inside the row. */
  longModel: string | null;
  label: string;
  maker: ModelMaker;
  /** Every engine of the scope that lists the model, ready first, in the
   *  server's preference order (the snapshot is sorted that way). */
  engines: CatalogEngine[];
  description?: string;
  retiresAt?: string;
  older: boolean;
  /** Windows declared by the engine that offers the id (MSEL-04). */
  windows: Record<string, number>;
  /** A stored value no engine offers any more: shown selected and disabled. */
  stale?: boolean;
}

export interface CatalogSection {
  maker: ModelMaker;
  rows: CatalogRow[];
  older: CatalogRow[];
  /** Engines of this company that are not ready: a notice with the reason. */
  notReady: CatalogEngine[];
  /** «Automatico in X» rows, on cards. */
  automatic: CatalogEngine[];
}

const LONG = /\[1m\]$/i;

/** Which company an ENGINE belongs to, for the notice of a non-ready one and
 *  for «Automatico in X»: the company of what it runs. */
export function engineMaker(name: string, models: readonly string[]): ModelMaker {
  if (name === 'codex' || name === 'openai') return 'openai';
  if (name === 'claude-code' || name === 'claude' || name === 'jcode' || name === 'topics') return 'anthropic';
  if (name.startsWith('gemini')) return 'google';
  return models[0] ? modelMaker(models[0]) : 'other';
}

function reasonOf(entry: ProviderSnapshotEntry): string | undefined {
  return entry.lastError ?? entry.requirements.find((requirement) => !requirement.present)?.hint;
}

/** The engines a scope offers, with the models each may run there. `topics`
 *  is never one: it is the switch above the list (AICTRL-01). */
export function scopeEngines(snapshot: ProvidersSnapshot | null, scope: TopicsRouteScope): Array<CatalogEngine & { models: string[] }> {
  if (scope === 'task') {
    return taskExecutionOptions(snapshot).map((option) => ({
      name: option.name, label: option.label, status: option.status, ready: option.status === 'ready',
      reason: option.reason, supportsAutomatic: option.supportsAutomatic, models: option.models,
    }));
  }
  return (snapshot?.providers ?? []).filter((entry) => entry.name !== 'topics').map((entry) => ({
    name: entry.name, label: entry.label ?? entry.name, status: entry.status, ready: entry.status === 'ready',
    reason: reasonOf(entry), supportsAutomatic: false, models: entry.models,
  }));
}

function labelFor(id: string, info: ModelInfo | undefined): string {
  if (info?.label) return info.label;
  const maker = modelMaker(id);
  return maker === 'anthropic' || maker === 'openai' ? friendlyModelLabel(id) : id;
}

/**
 * The sections, in the order the selector shows them: the company of the
 * stored value first, then Anthropic, OpenAI, Google, Others. A stored value
 * no ready engine offers stays as a selected, disabled row (MP-TASK-06).
 */
export function buildModelCatalog(
  snapshot: ProvidersSnapshot | null,
  scope: TopicsRouteScope,
  value: AiExecutionSelection,
): CatalogSection[] {
  const engines = scopeEngines(snapshot, scope);
  const infoOf = (id: string): ModelInfo | undefined => {
    for (const entry of snapshot?.providers ?? []) {
      const info = entry.modelInfo?.[id];
      if (info) return info;
    }
    return undefined;
  };
  const rows = new Map<string, CatalogRow>();
  for (const engine of engines) {
    const entry = snapshot?.providers.find((candidate) => candidate.name === engine.name);
    for (const id of engine.models) {
      const key = id.replace(LONG, '');
      let row = rows.get(key);
      if (!row) {
        const info = infoOf(key) ?? infoOf(id);
        row = {
          key, model: key, longModel: null, label: labelFor(key, info), maker: modelMaker(key), engines: [],
          description: info?.description, retiresAt: info?.retiresAt, older: info?.generation === 'older', windows: {},
        };
        rows.set(key, row);
      }
      if (LONG.test(id)) row.longModel = id;
      if (!row.engines.some((e) => e.name === engine.name)) {
        row.engines.push({
          name: engine.name, label: engine.label, status: engine.status, ready: engine.ready,
          reason: engine.reason, supportsAutomatic: engine.supportsAutomatic,
        });
      }
      const declared = entry?.modelContextWindows?.[id];
      if (declared && !row.windows[id]) row.windows[id] = declared;
      if (infoOf(id)?.generation === 'older') row.older = true;
    }
  }
  // A row listed only as `[1m]` keeps the long id as its own.
  for (const row of rows.values()) {
    if (row.longModel && !engines.some((engine) => engine.models.includes(row.key))) {
      row.model = row.longModel;
      row.longModel = null;
    }
    row.engines.sort((a, b) => Number(b.ready) - Number(a.ready));
  }
  // The stored value, when no engine of the scope offers it any more.
  if (value.model) {
    const key = value.model.replace(LONG, '');
    const row = rows.get(key);
    const offered = row?.engines.some((engine) => !value.provider || engine.name === value.provider);
    if (!offered) {
      const providerEntry = snapshot?.providers.find((entry) => entry.name === value.provider);
      rows.set(`stale:${key}`, {
        key: `stale:${key}`, model: value.model, longModel: null, label: labelFor(key, infoOf(key)),
        maker: modelMaker(key), stale: true, older: false, windows: {},
        engines: value.provider ? [{
          name: value.provider, label: providerEntry?.label ?? value.provider, status: providerEntry?.status ?? 'unavailable',
          ready: false, reason: providerEntry ? reasonOf(providerEntry) : undefined, supportsAutomatic: false,
        }] : [],
      });
    }
  }
  const first = value.model ? modelMaker(value.model) : value.provider ? engineMaker(value.provider, []) : null;
  const order = first ? [first, ...MODEL_MAKER_ORDER.filter((maker) => maker !== first)] : [...MODEL_MAKER_ORDER];
  return order.map((maker): CatalogSection => {
    const all = [...rows.values()].filter((row) => row.maker === maker);
    const makerEngines = engines.filter((engine) => engineMaker(engine.name, engine.models) === maker);
    return {
      maker,
      // An older model that is the stored value stays in sight, not folded.
      rows: all.filter((row) => !row.older || row.stale || rowSelected(row, value)),
      older: all.filter((row) => row.older && !row.stale && !rowSelected(row, value)),
      // An engine that is down and lists nothing would vanish without a word:
      // its reason is said where its models would be (AICTRL-02).
      notReady: makerEngines.filter((engine) => !engine.ready && !engine.models.length),
      automatic: scope === 'task' ? makerEngines.filter((engine) => engine.ready && engine.supportsAutomatic) : [],
    };
  }).filter((section) => section.rows.length || section.older.length || section.notReady.length || section.automatic.length);
}

/**
 * MSEL-05: which engine runs a row. One rule, three steps: the engine the
 * stored value already names (a choice never jumps by itself), then the
 * snapshot's default, then the server's preference order (subscription first,
 * then the APIs), which is the order the engines are listed in.
 */
export function rowEngine(row: CatalogRow, value: AiExecutionSelection, defaultProvider: string | null | undefined): CatalogEngine | null {
  const ready = row.engines.filter((engine) => engine.ready);
  return ready.find((engine) => engine.name === value.provider)
    ?? ready.find((engine) => engine.name === defaultProvider)
    ?? ready[0]
    ?? row.engines[0]
    ?? null;
}

/** Whether a row is the stored value (either variant of it). */
export function rowSelected(row: CatalogRow, value: AiExecutionSelection): boolean {
  if (!value.model) return false;
  if (value.model !== row.model && value.model !== row.longModel) return false;
  return row.stale || !value.provider || row.engines.some((engine) => engine.name === value.provider);
}

/**
 * MSEL-03: a substring search, case and accents ignored, on label, id,
 * company, engine and description. Several words must all be found. Older
 * generations are searched too. A section with nothing left disappears.
 */
export function filterModelCatalog(
  sections: CatalogSection[],
  query: string,
  makerLabel: (maker: ModelMaker) => string,
): CatalogSection[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return sections;
  const matches = (row: CatalogRow) => {
    const haystack = fold([
      row.label, row.model, row.longModel ?? '', makerLabel(row.maker), row.maker,
      ...row.engines.map((engine) => `${engine.label} ${engine.name}`), row.description ?? '',
    ].join(' '));
    return words.every((word) => haystack.includes(word));
  };
  return sections.map((section) => ({
    ...section,
    rows: [...section.rows, ...section.older].filter(matches),
    older: [],
    notReady: [],
    automatic: section.automatic.filter((engine) => words.every((word) => fold(`${engine.label} ${makerLabel(section.maker)}`).includes(word))),
  })).filter((section) => section.rows.length || section.automatic.length);
}

/**
 * The runtime and model a stored TASK value names (`provider:model`, a bare
 * model, the legacy `topics:<model>`), as the selector reads it. A legacy
 * value resolves against the engines that offer the model, the default first.
 */
export function taskMenuSelection(value: string | null, snapshot: ProvidersSnapshot | null): AiExecutionSelection {
  const selected = taskModelSelection(value);
  const isLegacy = selected.model && (!selected.provider || selected.provider === 'topics');
  const offering = isLegacy
    ? taskExecutionOptions(snapshot).filter((entry) => entry.models.includes(selected.model!))
    : [];
  const provider = (selected.provider && selected.provider !== 'topics' ? selected.provider : undefined)
    ?? offering.find((entry) => entry.name === snapshot?.defaultProvider)?.name
    ?? offering[0]?.name
    ?? (selected.provider === 'topics' ? 'topics' : null);
  return { provider, model: selected.model ?? null };
}

/** The catalog of a selector, live: the shared snapshot store (one fetch, one
 *  subscription for every consumer), or a snapshot handed in by a test. */
export function useModelCatalog(
  scope: TopicsRouteScope,
  value: AiExecutionSelection,
  snapshotOverride?: ProvidersSnapshot | null,
): { snapshot: ProvidersSnapshot | null; sections: CatalogSection[] } {
  const { snapshot: live } = useProvidersSnapshot();
  const snapshot = snapshotOverride ?? live;
  const sections = useMemo(() => buildModelCatalog(snapshot, scope, value), [snapshot, scope, value]);
  return { snapshot, sections };
}
