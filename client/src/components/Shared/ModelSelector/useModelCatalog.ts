/**
 * THE CATALOG OF THE MODEL SELECTOR, AS PURE LOGIC (MSEL-02, MSEL-04, MSEL-05;
 * revision 2026-10-04 §3-4).
 *
 * The snapshot lists ENGINES (Claude Code, Codex, jcode, the APIs, the
 * endpoints), each with the models it runs. The selector shows MODELS, grouped
 * by the company that makes them: there is no catch-all group, every group is a
 * company or, when the company cannot be read, the provider that offers it.
 * The same model served by several engines is ONE row (`mergeKey`); the engine
 * that runs a group is written once, in its heading, and a row repeats it only
 * when it runs elsewhere. Everything is derived from the snapshot; nothing
 * about a model is written by hand in the client (MSEL-09).
 *
 * A module of its own, not inside `ModelList.tsx`, because a component module
 * may only export components (react-refresh/only-export-components) and the
 * tests read these rules without a DOM.
 */
import { useMemo } from 'react';
import type { ProvidersSnapshot, ProviderSnapshotEntry } from '../../../types';
import { useProvidersSnapshot } from '../../../hooks/useProvidersSnapshot';
import type { ModelInfo } from '../../../../../shared/types';
import { FIXED_MAKERS, engineMaker, makerLabel, modelMaker } from '../../../../../shared/modelMaker';
import { compareVersions, familyVersion, mergeKey } from '../../../../../shared/modelMergeKey';
import {
  taskExecutionOptions,
  taskModelSelection,
  topicsRoute,
  type TopicsRouteScope,
} from '../../../../../shared/task-coding-models';
import { modelDisplayLabel } from '../../../lib/modelLabel';
import { fold } from './modelCommand';

/** What a selector holds: a provider and a model. `null` model = Automatic
 *  (within the provider when the provider is set). */
export interface AiExecutionSelection {
  provider: string | null;
  model: string | null;
}

export type EngineStatus = ProviderSnapshotEntry['status'];

export interface CatalogEngine {
  name: string;
  label: string;
  status: EngineStatus;
  ready: boolean;
  /** «Automatico» within this engine is offered on cards. */
  supportsAutomatic: boolean;
}

/** The connect box action of a provider that is not ready (revision §4.6). */
export type ConnectAction = 'signIn' | 'addKey' | 'setUp';

export interface ConnectEntry extends CatalogEngine {
  action: ConnectAction;
}

export interface CatalogRow {
  /** The merge key: one row per model. `auto:<engine>` for an Automatic row. */
  key: string;
  /** The id the row's engine runs (base variant). `null` on an Automatic row. */
  model: string | null;
  /** The `[1m]` twin the row's engine offers, a switch inside the row. */
  longModel: string | null;
  /** The ids per engine: `gpt-oss:20b` on Ollama, `openai/gpt-oss-20b` on jcode. */
  ids: Record<string, { model: string; longModel: string | null }>;
  label: string;
  maker: string;
  /** Every ready engine that serves the row, in the snapshot's order. */
  engines: CatalogEngine[];
  /** The engine that runs the row (§3.5): the group's when it serves it. */
  engine: CatalogEngine | null;
  /** «Topics» when the row runs through Topics, else the engine's label. */
  who: string;
  viaTopics: boolean;
  /** The engine's label when `who` differs from the heading's: «via X» on the row. */
  via: string | null;
  description?: string;
  retiresAt?: string;
  older: boolean;
  /** Windows declared by the engines that offer the ids (MSEL-04). */
  windows: Record<string, number>;
  /** A stored value no ready engine offers any more: shown selected and disabled. */
  stale?: boolean;
  /** An «Automatico» row: a ready engine that lists no model, or Automatic within an engine on cards. */
  automatic?: boolean;
}

export type GroupStatus = 'ready' | 'unavailable' | 'error' | 'loading';

export interface CatalogGroup {
  /** A company id, `vendor:<v>` or `provider:<name>`: never a catch-all. */
  maker: string;
  label: string;
  rows: CatalogRow[];
  older: CatalogRow[];
  /** The ready engines that run rows of the group, in the snapshot's order; two or more open a choice. */
  engines: CatalogEngine[];
  engine: CatalogEngine | null;
  /** «Topics» or the engine's label: the heading's second line. */
  who: string | null;
  viaTopics: boolean;
  /** Providers of this company that are not ready, when the group has no row. */
  connect: ConnectEntry[];
  status: GroupStatus;
}

export interface CatalogOptions {
  /** The Run-in-Topics switch as the selector holds it. */
  routing?: boolean;
  /** Provider names whose connect box was dismissed on this device. */
  hidden?: readonly string[];
  /** The engine chosen in a heading's ⌄ for this opening, per company. */
  groupEngines?: Readonly<Record<string, string>>;
  /** Only this provider's models (the default model of one provider). */
  onlyProvider?: string;
}

const LONG = /\[1m\]$/i;

type ScopeEngine = CatalogEngine & { models: string[]; entry?: ProviderSnapshotEntry };

/** The engines a scope offers, with the models each may run there. `topics`
 *  is never one: it is the switch above the list (AICTRL-01). */
export function scopeEngines(snapshot: ProvidersSnapshot | null, scope: TopicsRouteScope): ScopeEngine[] {
  const entryOf = (name: string) => snapshot?.providers.find((entry) => entry.name === name);
  if (scope === 'task') {
    return taskExecutionOptions(snapshot).map((option) => ({
      name: option.name, label: option.label, status: option.status, ready: option.status === 'ready',
      supportsAutomatic: option.supportsAutomatic, models: option.models, entry: entryOf(option.name),
    }));
  }
  return (snapshot?.providers ?? []).filter((entry) => entry.name !== 'topics').map((entry) => ({
    name: entry.name, label: entry.label ?? entry.name, status: entry.status, ready: entry.status === 'ready',
    supportsAutomatic: false, models: entry.models, entry,
  }));
}

const ENGINE_ACTIONS: Record<string, ConnectAction> = { 'claude-code': 'signIn', codex: 'signIn', claude: 'addKey', openai: 'addKey' };

/** Subscriptions sign in, API keys are added, everything else is set up. */
export function connectAction(name: string): ConnectAction {
  return Object.prototype.hasOwnProperty.call(ENGINE_ACTIONS, name) ? ENGINE_ACTIONS[name]! : 'setUp';
}

/** What «Accedi» types (not runs) in a Topics terminal. */
export function signInCommand(name: string): string | null {
  if (name === 'codex') return 'codex login';
  if (name === 'claude-code') return 'claude login';
  return null;
}

function strip(engine: ScopeEngine): CatalogEngine {
  return { name: engine.name, label: engine.label, status: engine.status, ready: engine.ready, supportsAutomatic: engine.supportsAutomatic };
}

/** Whether a row is the stored value (either variant, on the stored engine). */
export function rowSelected(row: CatalogRow, value: AiExecutionSelection): boolean {
  if (row.automatic) return value.model === null && !!value.provider && value.provider === row.engine?.name;
  if (!value.model) return false;
  if (row.stale) return value.model === row.model;
  const ids = value.provider ? [row.ids[value.provider]].filter(Boolean) : Object.values(row.ids);
  return ids.some((id) => id!.model === value.model || id!.longModel === value.model);
}

/**
 * The groups of the selector. A stored value no ready engine offers stays as
 * a selected, disabled row (MP-TASK-06).
 */
export function buildModelCatalog(
  snapshot: ProvidersSnapshot | null,
  scope: TopicsRouteScope,
  value: AiExecutionSelection,
  options: CatalogOptions = {},
): CatalogGroup[] {
  const all = scopeEngines(snapshot, scope);
  const engines = options.onlyProvider ? all.filter((engine) => engine.name === options.onlyProvider) : all;
  const order = engines.map((engine) => engine.name);
  const hidden = new Set(options.hidden ?? []);
  const routing = !!options.routing;

  const rows = new Map<string, CatalogRow>();
  const declared = new Map<string, ModelInfo['generation']>();
  for (const engine of engines) {
    if (!engine.ready) continue;
    const info = engine.entry?.modelInfo ?? {};
    for (const id of engine.models) {
      const base = id.replace(LONG, '');
      // The `[1m]` twin of an id the engine also lists is the row's switch.
      if (LONG.test(id) && engine.models.includes(base)) continue;
      const key = mergeKey(base);
      let row = rows.get(key);
      if (!row) {
        const maker = modelMaker(base, { name: engine.name, label: engine.label });
        row = {
          key, model: null, longModel: null, ids: {}, label: modelDisplayLabel(base, info[base] ?? info[id]),
          maker: maker.id, engines: [], engine: null, who: '', viaTopics: false, via: null,
          older: false, windows: {},
        };
        rows.set(key, row);
      }
      const own = info[base] ?? info[id];
      if (own?.label) row.label = own.label;
      if (own?.description && !row.description) row.description = own.description;
      if (own?.retiresAt && !row.retiresAt) row.retiresAt = own.retiresAt;
      if (own?.generation && !declared.has(key)) declared.set(key, own.generation);
      const longId = LONG.test(id) ? null : engine.models.find((candidate) => candidate.toLowerCase() === `${id}[1m]`.toLowerCase()) ?? null;
      // A row listed only as `[1m]` keeps the long id as its own.
      row.ids[engine.name] = { model: id, longModel: longId };
      if (!row.engines.some((candidate) => candidate.name === engine.name)) row.engines.push(strip(engine));
      for (const variant of [id, longId]) {
        const window = variant ? engine.entry?.modelContextWindows?.[variant] : undefined;
        if (variant && window && !row.windows[variant]) row.windows[variant] = window;
      }
    }
  }

  // Generations (§3.4): a declared one wins; otherwise the newest version of
  // each family of the same company is current, the rest are older.
  const list = [...rows.values()];
  const versions = new Map(list.map((row) => [row.key, familyVersion(row.key)]));
  for (const row of list) {
    const stated = declared.get(row.key);
    if (stated) { row.older = stated === 'older'; continue; }
    const mine = versions.get(row.key)!;
    if (!mine.version) continue;
    row.older = list.some((other) => {
      if (other === row || other.maker !== row.maker) return false;
      const theirs = versions.get(other.key)!;
      return theirs.family === mine.family && !!theirs.version && compareVersions(theirs.version, mine.version!) > 0;
    });
  }

  // Automatic rows: a ready engine that lists no model (an ACP agent before its
  // first session), and Automatic within an engine on cards.
  const automatic: CatalogRow[] = [];
  for (const engine of engines) {
    if (!engine.ready) continue;
    const empty = engine.models.length === 0;
    if (!empty && !(scope === 'task' && engine.supportsAutomatic)) continue;
    const staticMaker = engineMaker(engine.name);
    const maker = staticMaker
      ?? (empty ? `provider:${engine.name}` : modelMaker(engine.models[0]!, { name: engine.name, label: engine.label }).id);
    automatic.push({
      key: `auto:${engine.name}`, model: null, longModel: null, ids: {}, label: '', maker, engines: [strip(engine)],
      engine: null, who: '', viaTopics: false, via: null, older: false, windows: {}, automatic: true,
    });
  }

  // The stored value, when no ready engine of the scope offers it any more.
  if (value.model) {
    const offered = list.some((row) => rowSelected(row, value));
    if (!offered) {
      const base = value.model.replace(LONG, '');
      const entry = snapshot?.providers.find((candidate) => candidate.name === value.provider);
      const maker = modelMaker(base, { name: value.provider ?? 'unknown', label: entry?.label ?? value.provider ?? undefined });
      const stale: CatalogRow = {
        key: `stale:${mergeKey(base)}`, model: value.model, longModel: null, ids: {}, label: modelDisplayLabel(base, entry?.modelInfo?.[base]),
        maker: maker.id, engines: [], engine: value.provider ? {
          name: value.provider, label: entry?.label ?? value.provider, status: entry?.status ?? 'unavailable', ready: false, supportsAutomatic: false,
        } : null, who: '', viaTopics: false, via: null, older: false, windows: {}, stale: true,
      };
      list.push(stale);
    }
  }

  const groups = new Map<string, CatalogGroup>();
  const groupOf = (maker: string, label: string) => {
    let group = groups.get(maker);
    if (!group) {
      group = { maker, label, rows: [], older: [], engines: [], engine: null, who: null, viaTopics: false, connect: [], status: 'ready' };
      groups.set(maker, group);
    }
    return group;
  };
  const labelOfMaker = (maker: string): string => {
    if (maker.startsWith('provider:')) {
      const name = maker.slice('provider:'.length);
      return engines.find((engine) => engine.name === name)?.label ?? name;
    }
    return makerLabel(maker);
  };
  for (const row of [...automatic, ...list]) {
    const group = groupOf(row.maker, labelOfMaker(row.maker));
    // An older model that is the stored value stays in sight, not folded.
    if (row.older && !row.stale && !rowSelected(row, value)) group.older.push(row);
    else group.rows.push(row);
  }

  // Providers that are not ready, present in the snapshot, of a known company:
  // the connect box of a group that has no row (§4.6).
  for (const engine of engines) {
    if (engine.ready || hidden.has(engine.name)) continue;
    const maker = engineMaker(engine.name);
    if (!maker) continue;
    const group = groups.get(maker);
    if (group && (group.rows.length || group.older.length)) continue;
    groupOf(maker, makerLabel(maker)).connect.push({ ...strip(engine), action: connectAction(engine.name) });
  }

  const routeOf = (engine: string, model: string | null) =>
    topicsRoute(routing, { provider: engine, model }, snapshot, scope).via === 'topics';

  for (const group of groups.values()) {
    const members = [...group.rows, ...group.older].filter((row) => !row.stale);
    const served = new Set(members.flatMap((row) => row.engines.map((engine) => engine.name)));
    group.engines = order.filter((name) => served.has(name)).map((name) => strip(engines.find((engine) => engine.name === name)!));
    const pickEngine = (): string | null => {
      const chosen = options.groupEngines?.[group.maker];
      if (chosen && served.has(chosen)) return chosen;
      const savedRow = members.find((row) => rowSelected(row, value));
      if (savedRow && value.provider && served.has(value.provider)) return value.provider;
      const fallback = snapshot?.defaultProvider;
      if (fallback && served.has(fallback)) return fallback;
      return group.engines[0]?.name ?? null;
    };
    const engineName = pickEngine();
    group.engine = group.engines.find((engine) => engine.name === engineName) ?? null;
    const typical = group.engine ? members.find((row) => !row.automatic && row.ids[group.engine!.name])?.ids[group.engine.name]?.model ?? null : null;
    group.viaTopics = !!group.engine && routeOf(group.engine.name, typical);
    group.who = group.engine ? (group.viaTopics ? 'Topics' : group.engine.label) : null;
    for (const row of members) {
      const name = group.engine && row.engines.some((engine) => engine.name === group.engine!.name)
        ? group.engine.name
        : order.find((candidate) => row.engines.some((engine) => engine.name === candidate)) ?? null;
      row.engine = row.engines.find((engine) => engine.name === name) ?? null;
      const ids = name ? row.ids[name] : undefined;
      if (!row.automatic) {
        row.model = ids?.model ?? row.model;
        row.longModel = ids?.longModel ?? null;
      }
      row.viaTopics = !!name && !row.automatic && routeOf(name, row.model);
      row.who = row.viaTopics ? 'Topics' : row.engine?.label ?? '';
      row.via = row.who && row.who !== group.who ? row.who : null;
    }
    // Automatic rows lead their group.
    group.rows.sort((a, b) => Number(!!b.automatic) - Number(!!a.automatic));
    group.status = members.length ? 'ready'
      : group.connect.some((engine) => engine.status === 'error') ? 'error'
        : group.connect.some((engine) => engine.status === 'loading') ? 'loading' : 'unavailable';
  }

  return [...groups.values()].filter((group) => group.rows.length || group.older.length || group.connect.length);
}

/**
 * The columns (§3.4): Anthropic, OpenAI and Google, fixed and in this order;
 * the other companies get a column each when there are four groups or fewer,
 * otherwise they stack in the column after the fixed ones, by number of models
 * and then by name. The stored value never moves its company first.
 */
export function catalogColumns(groups: CatalogGroup[]): CatalogGroup[][] {
  const fixed = FIXED_MAKERS.map((maker) => groups.find((group) => group.maker === maker)).filter((group): group is CatalogGroup => !!group);
  const size = (group: CatalogGroup) => group.rows.filter((row) => !row.automatic).length + group.older.length;
  const rest = groups
    .filter((group) => !(FIXED_MAKERS as readonly string[]).includes(group.maker))
    .sort((a, b) => size(b) - size(a) || a.label.localeCompare(b.label));
  const columns = fixed.map((group) => [group]);
  if (fixed.length + rest.length <= 4) for (const group of rest) columns.push([group]);
  else if (rest.length) columns.push(rest);
  return columns;
}

/**
 * MSEL-03: a substring search, case and accents ignored, on label, id,
 * company, engine and description. Several words must all be found. Older
 * generations are searched too. A group with nothing left disappears, and so
 * do the connect boxes.
 */
export function filterModelCatalog(groups: CatalogGroup[], query: string, automaticLabel: string): CatalogGroup[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return groups;
  const matches = (group: CatalogGroup, row: CatalogRow) => {
    const haystack = fold([
      row.automatic ? automaticLabel : row.label, ...Object.values(row.ids).flatMap((id) => [id.model, id.longModel ?? '']),
      row.model ?? '', group.label, group.maker,
      ...row.engines.map((engine) => `${engine.label} ${engine.name}`), row.description ?? '',
    ].join(' '));
    return words.every((word) => haystack.includes(word));
  };
  return groups.map((group) => ({
    ...group,
    rows: [...group.rows, ...group.older].filter((row) => matches(group, row)),
    older: [],
    connect: [],
  })).filter((group) => group.rows.length);
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
  options: CatalogOptions,
  snapshotOverride?: ProvidersSnapshot | null,
): { snapshot: ProvidersSnapshot | null; groups: CatalogGroup[] } {
  const { snapshot: live } = useProvidersSnapshot();
  const snapshot = snapshotOverride ?? live;
  const { routing, hidden, groupEngines, onlyProvider } = options;
  const groups = useMemo(
    () => buildModelCatalog(snapshot, scope, value, { routing, hidden, groupEngines, onlyProvider }),
    [snapshot, scope, value, routing, hidden, groupEngines, onlyProvider],
  );
  return { snapshot, groups };
}
