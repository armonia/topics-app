/**
 * THE BODY OF THE MODEL SELECTOR: band, search, Automatic, one section per
 * company (MSEL-02..08). Every surface that picks a model draws this, through
 * `ModelSelector`, which owns the popover around it.
 *
 * Its own chunk (`modelListLazy.ts`): it is the content of a popover, nothing
 * of it is on screen at first paint.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, KeyRound, Route, Search, Settings2, Sparkles } from 'lucide-react';
import type { ProvidersSnapshot } from '../../../types';
import type { ModelMaker } from '../../../../../shared/modelMaker';
import { topicsRoute, type TopicsRoute, type TopicsRouteScope } from '../../../../../shared/task-coding-models';
import { contextWindowFor, formatContextWindow } from '../../../../../shared/context-window';
import { POPOVER_ITEM } from '../../../lib/popoverStyles';
import { openHome } from '../../../lib/openHome';
import { usePlanUsage } from '../../../state/planUsage';
import { useT } from '../../../hooks/useT';
import { useMenuAnchor } from '../menuAnchor';
import { SEGNALE_ATTESA } from '../../Sidebar/chromeSignals';
import { claudePlanCompact, claudeSubscription, providersReadyTail } from '../../Sidebar/formLevelTails';
import {
  filterModelCatalog,
  rowEngine,
  rowSelected,
  useModelCatalog,
  type AiExecutionSelection,
  type CatalogEngine,
  type CatalogRow,
  type CatalogSection,
} from './useModelCatalog';

export interface ModelListProps {
  scope: TopicsRouteScope;
  variant: 'compact' | 'full';
  layout: 'columns' | 'list';
  value: AiExecutionSelection;
  /** What the band judges when it differs from `value` (Automatic on a card
   *  runs the board default; a chat with no override runs its pin). */
  routingTarget?: AiExecutionSelection;
  onSelect: (selection: AiExecutionSelection) => void;
  automatic: { label: string; hint: string };
  /** «Esegui in Topics». Absent = no band (the default model of one provider). */
  topicsRouting?: { enabled: boolean; onToggle: (next: boolean) => void };
  /** Only this provider's models (the default model of one provider). */
  onlyProvider?: string;
  disabled?: boolean;
  onClose: () => void;
  /** Focus the search on open: desktop only, the phone keyboard would cover the sheet. */
  focusSearch: boolean;
  /** Deterministic catalog for render tests; live callers omit it. */
  snapshot?: ProvidersSnapshot | null;
}

const MAKER_KEY: Record<ModelMaker, string> = {
  anthropic: 'ai.selector.maker.anthropic',
  openai: 'ai.selector.maker.openai',
  google: 'ai.selector.maker.google',
  other: 'ai.selector.maker.other',
};

function routeOf(enabled: boolean, selection: AiExecutionSelection, snapshot: ProvidersSnapshot | null, scope: TopicsRouteScope): TopicsRoute {
  return topicsRoute(enabled, { provider: selection.provider ?? snapshot?.defaultProvider ?? null, model: selection.model }, snapshot, scope);
}

/** «Esegui in Topics»: a real switch, the whole band clicks, never disabled
 *  (neither position blocks anything), and the line under the title says what
 *  happens to the CURRENT choice, readable without hovering (MSEL-07). */
function RoutingBand({ enabled, route, engineLabel, onToggle }: {
  enabled: boolean;
  route: TopicsRoute;
  engineLabel: string;
  onToggle: () => void;
}) {
  const tr = useT();
  const through = enabled && route.via !== 'direct';
  const direct = enabled && route.via === 'direct' ? route : null;
  const line = direct
    ? direct.reason === 'family' ? tr('ai.selector.route.direct.family', { engine: engineLabel })
      : direct.reason === 'model' ? tr('ai.selector.route.direct.model')
        : tr('ai.selector.route.direct.engineDown')
    : tr('ai.selector.routingLine');
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      data-testid="model-selector-routing"
      data-route={!enabled ? 'off' : through ? 'topics' : 'direct'}
      onClick={onToggle}
      className={`mx-1 mb-1 flex w-[calc(100%-0.5rem)] items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors ${
        through ? 'border-l-2 border-primary bg-primary/10' : 'border-l-2 border-transparent bg-app-inset'
      }`}
    >
      <Route className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${through ? 'text-primary' : 'text-app-text-muted'}`} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block text-mini font-semibold text-app-text">{tr('ai.selector.routing')}</span>
        <span
          data-testid="model-selector-routing-line"
          className={`mt-0.5 block text-micro leading-snug ${direct ? SEGNALE_ATTESA : enabled ? 'text-app-text-secondary' : 'text-app-text-muted'}`}
        >
          {line}
        </span>
      </span>
      <span className={`relative mt-0.5 h-4 w-7 shrink-0 rounded-full transition-colors ${enabled ? 'bg-primary' : 'bg-app-border'}`} aria-hidden="true">
        <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${enabled ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
      </span>
    </button>
  );
}

/** The providers and their keys, at the foot of every selector (SETHOME-01). */
function ProvidersFooterRow({ snapshot, chosen, disabled, onClose }: {
  snapshot: ProvidersSnapshot | null;
  chosen: string | null;
  disabled?: boolean;
  onClose: () => void;
}) {
  const tr = useT();
  const anchor = useMenuAnchor();
  const tail = providersReadyTail(snapshot, chosen, tr);
  return (
    <div className="mt-1 shrink-0 border-t border-app-border pt-1">
      <button
        type="button"
        disabled={disabled}
        data-testid="ai-selector-providers"
        className={`${POPOVER_ITEM} disabled:opacity-40`}
        onClick={() => { const el = anchor?.current ?? null; onClose(); openHome('providers', el); }}
      >
        <KeyRound className="h-3.5 w-3.5 shrink-0 text-app-text-muted" />
        <span className="min-w-0 flex-1 truncate">{tr('home.providers')}</span>
        {tail && (
          <span
            data-testid="ai-selector-providers-tail"
            data-warn={tail.warn ? 'true' : undefined}
            className={`shrink-0 text-micro tabular-nums ${tail.warn ? SEGNALE_ATTESA : 'text-app-text-muted'}`}
          >
            {tail.text}
          </span>
        )}
      </button>
    </div>
  );
}

/** The Claude plan in one line, under the Anthropic heading. */
function ClaudePlanCompactLine({ snapshot }: { snapshot: ProvidersSnapshot | null }) {
  const tr = useT();
  const usage = usePlanUsage();
  const line = claudePlanCompact(claudeSubscription(snapshot), usage?.fiveHour ?? null, tr);
  if (!line) return null;
  return (
    <p
      data-testid="ai-selector-claude-plan"
      data-warn={line.warn ? 'true' : undefined}
      className={`px-3 pb-1 text-micro tabular-nums ${line.warn ? SEGNALE_ATTESA : 'text-app-text-muted'}`}
    >
      {line.text}
    </p>
  );
}

function retireDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

interface RowProps {
  row: CatalogRow;
  column: number;
  index: number;
  value: AiExecutionSelection;
  snapshot: ProvidersSnapshot | null;
  scope: TopicsRouteScope;
  variant: 'compact' | 'full';
  layout: 'columns' | 'list';
  routingEnabled: boolean;
  disabled?: boolean;
  onPick: (selection: AiExecutionSelection) => void;
  onClose: () => void;
}

function ModelRow({ row, column, index, value, snapshot, scope, variant, layout, routingEnabled, disabled, onPick, onClose }: RowProps) {
  const tr = useT();
  const anchor = useMenuAnchor();
  const selected = rowSelected(row, value);
  const engine = rowEngine(row, value, snapshot?.defaultProvider);
  const readyEngines = row.engines.filter((candidate) => candidate.ready);
  const usable = !row.stale && !!engine?.ready;
  const [long, setLong] = useState(() => !!row.longModel && value.model === row.longModel);
  const [segment, setSegment] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const id = long && row.longModel ? row.longModel : row.model;
  const route = engine ? routeOf(routingEnabled, { provider: engine.name, model: id }, snapshot, scope) : null;
  const via = route?.via === 'topics' ? tr('ai.selector.route.topics') : engine ? tr('ai.selector.route.via', { engine: engine.label }) : '';
  const win = contextWindowFor(id, row.windows[id]);
  const describedBy = `model-row-desc-${row.key.replace(/[^a-z0-9]/gi, '-')}`;
  const pick = (provider: string | undefined, model = id) => {
    if (!provider || disabled || !usable) return;
    onPick({ provider, model });
  };
  const moveColumn = (delta: number) => {
    const panel = rowRef.current?.closest('[data-model-selector-panel]');
    if (!panel) return;
    const target = [...panel.querySelectorAll<HTMLElement>(`[data-column="${column + delta}"][role="option"]:not([aria-disabled="true"])`)];
    (target[Math.min(index, target.length - 1)] ?? null)?.focus();
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.target !== rowRef.current) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      pick(engine?.name);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (readyEngines.length > 1) {
        setSegment(true);
        requestAnimationFrame(() => rowRef.current?.querySelector<HTMLElement>('[data-engine-choice]')?.focus());
      } else if (layout === 'columns') moveColumn(1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (segment) setSegment(false);
      else if (layout === 'columns') moveColumn(-1);
    }
  };
  const meta = [
    scope === 'chat' && usable ? `${win.known ? '' : '≈'}${formatContextWindow(win.tokens)}` : null,
  ].filter(Boolean);
  return (
    <div
      ref={rowRef}
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      aria-disabled={!usable || disabled ? true : undefined}
      aria-describedby={row.description || row.retiresAt || !usable ? describedBy : undefined}
      data-testid="model-row"
      data-model={id}
      data-provider={engine?.name}
      data-route={route?.via}
      data-column={column}
      data-index={index}
      onClick={() => pick(engine?.name)}
      onKeyDown={onKeyDown}
      className={`${POPOVER_ITEM} !items-start cursor-default flex-col !gap-0.5 outline-none focus-visible:bg-app-hover ${
        selected ? 'bg-primary/5' : ''
      } ${!usable || disabled ? 'opacity-60' : 'cursor-pointer'}`}
    >
      <span className="flex w-full min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate" data-testid="model-row-label">{row.label}</span>
        {row.longModel && (
          <button
            type="button"
            data-roving-skip=""
            role="switch"
            aria-checked={long}
            aria-label={tr('ai.selector.longWindow')}
            title={tr('ai.selector.longWindow')}
            data-testid="model-row-1m"
            disabled={disabled || !usable}
            onClick={(event) => {
              event.stopPropagation();
              const next = !long;
              setLong(next);
              if (selected && engine) onPick({ provider: engine.name, model: next ? row.longModel! : row.model });
            }}
            className={`shrink-0 rounded px-1 text-nano font-semibold tabular-nums ${long ? 'bg-primary/15 text-primary' : 'bg-app-hover text-app-text-muted'}`}
          >
            1M
          </button>
        )}
        {layout === 'list' && meta.map((text) => (
          <span key={text} data-testid={`model-window-${id}`} data-context-tokens={win.tokens} className="shrink-0 text-micro tabular-nums text-app-text-muted">{text}</span>
        ))}
        {layout === 'list' && usable && <ViaLabel via={via} route={route} multi={readyEngines.length > 1} open={segment} onToggle={() => setSegment((v) => !v)} />}
        <span className="flex w-3 shrink-0 justify-center" aria-hidden="true">
          {selected && <Check className={`h-3 w-3 ${usable ? 'text-emerald-400' : 'text-amber-300'}`} />}
        </span>
      </span>
      {layout === 'columns' && usable && (
        <span className="flex w-full min-w-0 items-center gap-1.5 text-micro text-app-text-muted">
          {meta.map((text) => <span key={text} data-testid={`model-window-${id}`} data-context-tokens={win.tokens} className="tabular-nums">{text}</span>)}
          <ViaLabel via={via} route={route} multi={readyEngines.length > 1} open={segment} onToggle={() => setSegment((v) => !v)} />
        </span>
      )}
      {(row.retiresAt || (variant === 'full' && row.description) || !usable) && (
        <span id={describedBy} className="block w-full text-micro leading-snug text-app-text-muted">
          {row.retiresAt && <span className={`block ${SEGNALE_ATTESA}`} data-testid="model-row-retires">{tr('ai.selector.retires', { date: retireDate(row.retiresAt) })}</span>}
          {variant === 'full' && row.description && <span className="block" data-testid="model-row-description">{row.description}</span>}
          {!usable && (
            <span className="flex items-center gap-1.5">
              <span className={SEGNALE_ATTESA}>{row.stale ? tr('ai.selector.noLongerAvailable') : engine?.reason || tr('ai.selector.unavailable')}</span>
              <button
                type="button"
                data-testid="model-row-settings"
                onClick={(event) => { event.stopPropagation(); const el = anchor?.current ?? null; onClose(); openHome('providers', el); }}
                className="inline-flex items-center gap-1 rounded px-1 text-primary hover:bg-app-hover"
              >
                <Settings2 className="h-3 w-3" aria-hidden="true" />{tr('chat.picker.openSettings')}
              </button>
            </span>
          )}
        </span>
      )}
      {segment && readyEngines.length > 1 && (
        <span role="radiogroup" aria-label={tr('ai.selector.engine')} className="flex w-full flex-wrap gap-1 pt-0.5" data-testid="model-row-engines">
          {readyEngines.map((candidate: CatalogEngine) => (
            <button
              key={candidate.name}
              type="button"
              role="radio"
              aria-checked={candidate.name === engine?.name}
              data-engine-choice={candidate.name}
              data-roving-skip=""
              onClick={(event) => { event.stopPropagation(); setSegment(false); pick(candidate.name); }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft' || event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setSegment(false); rowRef.current?.focus(); }
              }}
              className={`rounded px-1.5 py-0.5 text-micro ${candidate.name === engine?.name ? 'bg-primary/15 text-primary' : 'bg-app-hover text-app-text-secondary'}`}
            >
              {candidate.label}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}

/** «via Topics» / «via Codex»: a small button when more than one engine runs the model. */
function ViaLabel({ via, route, multi, open, onToggle }: { via: string; route: TopicsRoute | null; multi: boolean; open: boolean; onToggle: () => void }) {
  const tr = useT();
  const tone = route?.via === 'topics' ? 'text-primary' : 'text-app-text-muted';
  if (!multi) return <span data-testid="model-row-via" className={`shrink-0 truncate text-micro ${tone}`}>{via}</span>;
  return (
    <button
      type="button"
      data-roving-skip=""
      data-testid="model-row-via"
      aria-expanded={open}
      title={tr('ai.selector.engine')}
      onClick={(event) => { event.stopPropagation(); onToggle(); }}
      className={`shrink-0 truncate rounded px-1 text-micro underline decoration-dotted underline-offset-2 hover:bg-app-hover ${tone}`}
    >
      {via}
    </button>
  );
}

function SectionView({ section, column, props, expanded, onExpand, snapshot, routingEnabled }: {
  section: CatalogSection;
  column: number;
  props: ModelListProps;
  expanded: boolean;
  onExpand: () => void;
  snapshot: ProvidersSnapshot | null;
  routingEnabled: boolean;
}) {
  const tr = useT();
  const label = tr(MAKER_KEY[section.maker]);
  const rows = expanded ? [...section.rows, ...section.older] : section.rows;
  const anyReady = [...section.rows, ...section.older].some((row) => row.engines.some((engine) => engine.ready));
  const columns = props.layout === 'columns';
  return (
    <div
      role="group"
      aria-label={label}
      data-testid={`model-section-${section.maker}`}
      className={columns ? 'flex min-h-0 min-w-0 flex-col overflow-y-auto overscroll-contain border-l border-app-border first:border-l-0' : ''}
    >
      <div
        role="presentation"
        data-testid="model-section-heading"
        className="sticky top-0 z-10 flex items-center gap-1.5 bg-[var(--popover-bg)] px-3 pb-1 pt-1.5 text-micro font-semibold uppercase tracking-wide text-app-text-muted"
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${anyReady ? 'bg-emerald-400' : 'bg-amber-400'}`} aria-hidden="true" />
        <span className="truncate">{label}</span>
      </div>
      {section.maker === 'anthropic' && <ClaudePlanCompactLine snapshot={snapshot} />}
      {section.automatic.map((engine) => {
        const selected = props.value.provider === engine.name && props.value.model === null;
        return (
          <button
            key={`auto-${engine.name}`}
            type="button"
            role="option"
            aria-selected={selected}
            disabled={props.disabled}
            data-testid="model-row-automatic-within"
            data-provider={engine.name}
            data-column={column}
            onClick={() => props.onSelect({ provider: engine.name, model: null })}
            className={`${POPOVER_ITEM} disabled:opacity-40`}
          >
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-app-text-muted" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{tr('ai.selector.autoWithin', { runtime: engine.label })}</span>
            {selected && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
          </button>
        );
      })}
      {rows.map((row, index) => (
        <ModelRow
          key={row.key} row={row} column={column} index={index} value={props.value} snapshot={snapshot} scope={props.scope}
          variant={props.variant} layout={props.layout} routingEnabled={routingEnabled}
          disabled={props.disabled} onPick={props.onSelect} onClose={props.onClose}
        />
      ))}
      {section.notReady.map((engine) => (
        <div key={`down-${engine.name}`} data-testid="model-section-not-ready" className="mx-2 my-1 rounded-md border border-amber-400/30 bg-amber-400/10 px-2.5 py-1.5 text-micro text-app-text-secondary">
          <p><span className="font-semibold">{engine.label}</span>: {engine.reason || tr('ai.selector.unavailable')}</p>
        </div>
      ))}
      {section.older.length > 0 && (
        <button
          type="button"
          aria-expanded={expanded}
          data-testid="model-section-older"
          data-column={column}
          onClick={onExpand}
          className={`${POPOVER_ITEM} text-app-text-muted`}
        >
          <span className="min-w-0 flex-1 truncate">{expanded ? tr('ai.selector.olderHide') : tr('ai.selector.older', { n: section.older.length })}</span>
        </button>
      )}
    </div>
  );
}

export function ModelList(props: ModelListProps) {
  const tr = useT();
  const { scope, value, layout, onSelect, onClose } = props;
  const { snapshot, sections: all } = useModelCatalog(scope, value, props.snapshot);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Partial<Record<ModelMaker, boolean>>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const routingEnabled = props.topicsRouting?.enabled ?? false;
  const scoped = useMemo(() => props.onlyProvider
    ? all.map((section) => ({
      ...section,
      rows: section.rows.filter((row) => row.engines.some((engine) => engine.name === props.onlyProvider)),
      older: section.older.filter((row) => row.engines.some((engine) => engine.name === props.onlyProvider)),
      notReady: [], automatic: [],
    })).filter((section) => section.rows.length || section.older.length)
    : all, [all, props.onlyProvider]);
  const sections = useMemo(
    () => filterModelCatalog(scoped, query, (maker) => tr(MAKER_KEY[maker])),
    [scoped, query, tr],
  );
  const target = props.routingTarget ?? value;
  const route = routeOf(routingEnabled, target, snapshot, scope);
  const targetProvider = target.provider ?? snapshot?.defaultProvider ?? null;
  const engineLabel = snapshot?.providers.find((entry) => entry.name === targetProvider)?.label ?? targetProvider ?? '';
  const pick = (selection: AiExecutionSelection) => { onSelect(selection); onClose(); };

  // The search takes the focus once the popover is placed and visible (a
  // hidden element refuses `focus()`), after `Menu` has focused its panel.
  useEffect(() => {
    if (!props.focusSearch) return;
    let frames = 0;
    let handle = 0;
    const tick = () => {
      const input = searchRef.current;
      const host = panelRef.current?.closest<HTMLElement>('[data-popover]');
      const visible = !!input && (!host || getComputedStyle(host).visibility === 'visible');
      if (visible && document.activeElement !== input) {
        input!.focus({ preventScroll: true });
        if (document.activeElement === input && frames > 2) return;
      }
      if (frames++ < 12) handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [props.focusSearch]);

  const firstItem = () => panelRef.current?.querySelector<HTMLElement>('[data-model-list-body] [role="option"]:not([aria-disabled="true"])');
  const columns = layout === 'columns';
  const automaticSelected = value.provider === null && value.model === null;
  return (
    <div
      ref={panelRef}
      data-model-selector-panel=""
      data-testid="model-selector-panel"
      data-variant={props.variant}
      data-layout={layout}
      data-scope={scope}
      className="flex min-h-0 flex-1 flex-col"
    >
      {props.topicsRouting && (
        <RoutingBand
          enabled={routingEnabled}
          route={route}
          engineLabel={engineLabel}
          onToggle={() => props.topicsRouting!.onToggle(!routingEnabled)}
        />
      )}
      <label className="mx-1 mb-1 flex shrink-0 items-center gap-2 rounded-md bg-app-inset px-2.5">
        <Search className="h-3.5 w-3.5 shrink-0 text-app-text-muted" aria-hidden="true" />
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') { event.preventDefault(); firstItem()?.focus(); }
            else if (event.key === 'Enter') {
              event.preventDefault();
              const first = panelRef.current?.querySelector<HTMLElement>('[data-model-list-sections] [role="option"]:not([aria-disabled="true"])');
              first?.click();
            }
          }}
          placeholder={tr('ai.selector.search')}
          aria-label={tr('ai.selector.search')}
          data-testid="model-selector-search"
          className="h-8 min-w-0 flex-1 bg-transparent text-compact text-app-text outline-none placeholder:text-app-text-faint"
        />
      </label>
      <div role="listbox" aria-label={tr('chat.picker.title')} data-model-list-body="" className="flex min-h-0 flex-1 flex-col">
        <button
          type="button"
          role="option"
          aria-selected={automaticSelected}
          disabled={props.disabled}
          data-testid="model-row-automatic"
          title={props.automatic.hint}
          onClick={() => pick({ provider: null, model: null })}
          className={`${POPOVER_ITEM} shrink-0 !items-start disabled:opacity-40`}
        >
          <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-app-text-muted" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{props.automatic.label}</span>
            <span className="block text-micro leading-snug text-app-text-muted">{props.automatic.hint}</span>
          </span>
          {automaticSelected && <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400" />}
        </button>
        <div
          data-model-list-sections=""
          data-testid="model-selector-sections"
          className={columns
            ? 'grid min-h-0 flex-1 border-t border-app-border'
            : 'min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-app-border'}
          style={columns ? { gridTemplateColumns: `repeat(${Math.max(1, sections.length)}, minmax(10rem, 1fr))` } : undefined}
        >
          {sections.map((section, column) => (
            <SectionView
              key={section.maker}
              section={section}
              column={column}
              props={{ ...props, onSelect: pick }}
              expanded={!!expanded[section.maker]}
              onExpand={() => setExpanded((current) => ({ ...current, [section.maker]: !current[section.maker] }))}
              snapshot={snapshot}
              routingEnabled={routingEnabled}
            />
          ))}
          {sections.length === 0 && (
            <p className="px-3 py-4 text-center text-mini text-app-text-muted" data-testid="model-selector-empty">
              {query ? tr('chat.picker.noMatches') : tr('ai.selector.none')}
            </p>
          )}
        </div>
      </div>
      <ProvidersFooterRow snapshot={snapshot} chosen={value.provider} disabled={props.disabled} onClose={onClose} />
    </div>
  );
}
