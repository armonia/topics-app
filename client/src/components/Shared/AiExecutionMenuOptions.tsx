import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, Route, Settings, Sparkles } from 'lucide-react';
import type { ProviderSnapshotEntry, ProvidersSnapshot } from '../../types';
import { taskExecutionOptions, topicsRoutingAvailable } from '../../../../shared/task-coding-models';
import { contextWindowFor, formatContextWindow } from '../../../../shared/context-window';
import { friendlyModelLabel } from '../../lib/modelLabel';
import { POPOVER_ITEM } from '../../lib/popoverStyles';
import { openSettings } from '../../lib/openSettings';
import { useT } from '../../hooks/useT';
import { ownsSelection, selectedModelMissingIn, type AiExecutionSelection } from './aiExecutionSelection';

interface Props {
  snapshot: ProvidersSnapshot | null;
  surface: 'chat' | 'task';
  value: AiExecutionSelection;
  /**
   * What the routing switch checks for routability (review bug #2). `value`
   * alone conflates two things on chat: which panel is open/checked (override
   * only) and what ON would actually target (override, else the topic's
   * pinned provider). Defaults to `value` for callers where the two already
   * coincide (tasks: the stored model IS the target, no separate pin layer).
   */
  routingTarget?: AiExecutionSelection;
  onSelect: (selection: AiExecutionSelection) => void;
  automaticLabel: string;
  automaticHint: string;
  disabled?: boolean;
  allowRuntimeAutomatic?: boolean;
  onClose?: () => void;
  /**
   * The AICTRL-01 switch: does the turn route through the Topics native
   * engine, targeting `value` as a constraint, or execute directly on it?
   * Toggling it never touches `value`. Omitted on surfaces that do not yet
   * persist the routing choice.
   */
  topicsRouting?: { enabled: boolean; onToggle: (next: boolean) => void };
}

interface ExecutionRow {
  name: string;
  label: string;
  status: ProviderSnapshotEntry['status'];
  models: string[];
  /** Windows declared by the provider, per model id, when it declares any. */
  contextWindows?: Record<string, number>;
  supportsAutomatic: boolean;
  reason?: string;
}

/**
 * The context window of ONE model row, in the chat list.
 *
 * It is what tells two otherwise similar rows apart, and it has to be readable
 * at the moment of choosing, not only afterwards on the trigger (EFFORTUI-01,
 * `tests/e2e/effort-single-surface.spec.ts`). The name gives up the width
 * (`truncate`), this label never does, and the tilde says the model is not in
 * the table and the number is the default rather than a measurement.
 */
function ModelWindowLabel(
  { model, selected, declared }: { model: string; selected: boolean; declared?: number },
) {
  const tr = useT();
  const win = contextWindowFor(model, declared);
  const n = win.tokens.toLocaleString('it-IT');
  return (
    <span
      data-testid={`model-window-${model}`}
      data-context-tokens={win.tokens}
      data-context-known={win.known ? 'true' : 'false'}
      className={`shrink-0 text-micro tabular-nums ${selected ? 'text-primary/80' : 'text-app-text-muted'}`}
      title={win.known ? tr('model.ctxWindow', { n }) : tr('model.ctxWindow.guess', { n })}
    >
      {win.known ? '' : '≈'}{formatContextWindow(win.tokens)}
    </span>
  );
}

function chatExecutions(snapshot: ProvidersSnapshot | null): ExecutionRow[] {
  // AICTRL-01: topics is the routing switch above this list, never a menu row.
  return (snapshot?.providers ?? []).filter((entry) => entry.name !== 'topics').map((entry) => ({
    name: entry.name,
    label: entry.label ?? entry.name,
    status: entry.status,
    models: entry.models,
    contextWindows: entry.modelContextWindows,
    supportsAutomatic: true,
    reason: entry.lastError ?? entry.requirements.find((requirement) => !requirement.present)?.hint,
  }));
}

export function AiExecutionMenuOptions({
  snapshot,
  surface,
  value,
  routingTarget,
  onSelect,
  automaticLabel,
  automaticHint,
  disabled,
  allowRuntimeAutomatic = false,
  onClose,
  topicsRouting,
}: Props) {
  const tr = useT();
  const target = routingTarget ?? value;
  const routable = topicsRoutingAvailable(target.provider, target.model, snapshot);
  const executions = useMemo(
    () => surface === 'task' ? taskExecutionOptions(snapshot) : chatExecutions(snapshot),
    [snapshot, surface],
  );
  // Chat rows carry their context window; task rows never did, and their
  // compatible catalog is already filtered by execution engine.
  const showWindow = surface === 'chat';
  const [activeProvider, setActiveProvider] = useState<string | null>(value.provider);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreProviderRef = useRef(value.provider);
  const moveFocusRef = useRef(false);

  useLayoutEffect(() => {
    if (!moveFocusRef.current) return;
    moveFocusRef.current = false;
    const target = activeProvider
      ? panelRef.current?.querySelector<HTMLElement>('[data-ai-selector-back]')
      : panelRef.current?.querySelector<HTMLElement>(`[data-provider="${restoreProviderRef.current ?? ''}"]`)
        ?? panelRef.current?.querySelector<HTMLElement>('[data-ai-selector-auto]');
    target?.focus({ preventScroll: true });
  }, [activeProvider]);

  const openProvider = (provider: string) => {
    restoreProviderRef.current = provider;
    moveFocusRef.current = true;
    setActiveProvider(provider);
  };
  const returnToProviders = () => {
    moveFocusRef.current = true;
    setActiveProvider(null);
  };

  // AICTRL-04: `topics` never shows up in `executions` (AICTRL-01), but a
  // legacy pinned selection can still name it. It is a real, ready runtime,
  // not a vanished one — drill in on the actual registry entry instead of
  // falling through to the "no longer available" placeholder below.
  const hiddenActive = activeProvider && !executions.some((entry) => entry.name === activeProvider)
    ? snapshot?.providers.find((entry) => entry.name === activeProvider)
    : undefined;
  const active = executions.find((entry) => entry.name === activeProvider)
    ?? (hiddenActive ? {
      name: hiddenActive.name,
      label: hiddenActive.label ?? hiddenActive.name,
      status: hiddenActive.status,
      models: hiddenActive.models,
      supportsAutomatic: false,
      reason: hiddenActive.lastError,
    } : null)
    ?? (activeProvider ? {
      name: activeProvider,
      label: activeProvider,
      status: 'unavailable' as const,
      models: value.model ? [value.model] : [],
      supportsAutomatic: false,
      reason: tr('ai.selector.noLongerAvailable'),
    } : null);

  const routingRow = topicsRouting && (
    <button
      type="button"
      role="switch"
      aria-checked={topicsRouting.enabled}
      disabled={disabled || (!routable && !topicsRouting.enabled)}
      data-testid="ai-selector-topics-routing"
      title={routable ? tr('ai.selector.routingHint') : tr('ai.selector.routingUnavailable')}
      className={`${POPOVER_ITEM} disabled:opacity-40`}
      onClick={() => topicsRouting.onToggle(!topicsRouting.enabled)}
    >
      <Route className="h-3.5 w-3.5 shrink-0 text-app-text-muted" />
      <span className="min-w-0 flex-1 truncate">{tr('ai.selector.routing')}</span>
      {!routable && <span className="text-micro text-amber-300">{tr('ai.selector.unavailableShort')}</span>}
      <span
        className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${topicsRouting.enabled ? 'bg-emerald-400' : 'bg-app-border'}`}
        aria-hidden="true"
      >
        <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${topicsRouting.enabled ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
      </span>
    </button>
  );

  if (active) {
    const ready = active.status === 'ready';
    const missingSelectedModel = selectedModelMissingIn(active, value);
    const unavailableReason = active.reason || tr('ai.selector.noLongerAvailable');
    return (
      <div ref={panelRef} className="w-[min(22rem,calc(100vw-1rem))] max-w-full py-1" data-testid="ai-selector-models">
        {routingRow}
        <button
          className={`${POPOVER_ITEM} disabled:opacity-40`}
          onClick={returnToProviders}
          data-testid="ai-selector-back"
          data-ai-selector-back=""
          disabled={disabled}
        >
          <ArrowLeft className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{active.label}</span>
          <span className={`h-1.5 w-1.5 rounded-full ${ready ? 'bg-emerald-400' : 'bg-amber-400'}`} />
        </button>
        {value.model && ownsSelection(active, value) && (!ready || missingSelectedModel) && (
          <button
            role="option"
            aria-selected="true"
            disabled
            data-model={value.model}
            className={`${POPOVER_ITEM} opacity-60`}
            title={unavailableReason}
          >
            <span className="min-w-0 flex-1 truncate">{friendlyModelLabel(value.model)}</span>
            <span className="text-micro text-amber-300">{tr('ai.selector.unavailableShort')}</span>
            {showWindow && (
              <ModelWindowLabel model={value.model} selected declared={active.contextWindows?.[value.model]} />
            )}
            <Check className="h-3 w-3 shrink-0 text-amber-300" />
          </button>
        )}
        {(!ready || missingSelectedModel) && (
          <div className="mx-2 my-1 rounded-md border border-amber-400/30 bg-amber-400/10 px-2.5 py-2 text-mini text-app-text-secondary">
            <p>{unavailableReason}</p>
            <button
              className="mt-1.5 inline-flex items-center gap-1 text-primary hover:underline disabled:opacity-40"
              disabled={disabled}
              onClick={() => { openSettings('providers'); onClose?.(); }}
            >
              <Settings className="h-3 w-3" /> {tr('ai.selector.openSettings')}
            </button>
          </div>
        )}
        {ready && allowRuntimeAutomatic && active.supportsAutomatic && (
          <button
            role="option"
            aria-selected={value.provider === active.name && value.model === null}
            disabled={disabled}
            className={`${POPOVER_ITEM} disabled:opacity-40`}
            onClick={() => { onSelect({ provider: active.name, model: null }); onClose?.(); }}
          >
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-app-text-muted" />
            <span className="min-w-0 flex-1 truncate">{tr('ai.selector.autoWithin', { runtime: active.label })}</span>
            {value.provider === active.name && value.model === null && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
          </button>
        )}
        {ready && active.models.map((model) => {
          const selected = value.provider === active.name && value.model === model;
          return (
            <button
              key={model}
              role="option"
              aria-selected={selected}
              disabled={disabled}
              data-model={model}
              className={`${POPOVER_ITEM} disabled:opacity-40`}
              onClick={() => { onSelect({ provider: active.name, model }); onClose?.(); }}
            >
              <span className="min-w-0 flex-1 truncate">{friendlyModelLabel(model)}</span>
              {showWindow ? (
                <>
                  <ModelWindowLabel model={model} selected={selected} declared={active.contextWindows?.[model]} />
                  {/* The check keeps its slot on every row: without it the
                      window column would move on the selected row only. */}
                  <span className="flex w-3 shrink-0 justify-center" aria-hidden="true">
                    {selected && <Check className="h-3 w-3 text-emerald-400" />}
                  </span>
                </>
              ) : selected && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
            </button>
          );
        })}
        {ready && active.models.length === 0 && !missingSelectedModel && (
          <p className="px-3 py-4 text-center text-mini text-app-text-muted">{tr('ai.selector.noModels')}</p>
        )}
      </div>
    );
  }

  return (
    <div ref={panelRef} className="w-[min(22rem,calc(100vw-1rem))] max-w-full py-1" data-testid="ai-selector-runtimes">
      {routingRow}
      <div className="px-2.5 pb-1 pt-1.5">
        <p className="text-mini font-semibold text-app-text">{tr('ai.selector.execution')}</p>
        <p className="mt-0.5 text-micro text-app-text-muted">{tr('ai.selector.executionHint')}</p>
      </div>
      <button
        role="option"
        aria-selected={value.provider === null && value.model === null}
        disabled={disabled}
        data-ai-selector-auto=""
        title={automaticHint}
        className={`${POPOVER_ITEM} disabled:opacity-40`}
        onClick={() => { onSelect({ provider: null, model: null }); onClose?.(); }}
      >
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-app-text-muted" />
        <span className="min-w-0 flex-1 truncate">{automaticLabel}</span>
        {value.provider === null && value.model === null && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
      </button>
      {executions.map((entry) => (
        <button
          key={entry.name}
          data-provider={entry.name}
          role="option"
          aria-selected={value.provider === entry.name}
          disabled={disabled}
          className={`${POPOVER_ITEM} disabled:opacity-40`}
          onClick={() => openProvider(entry.name)}
          title={entry.status === 'ready' ? tr('ai.selector.chooseModel') : entry.reason || tr('ai.selector.unavailable')}
        >
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${entry.status === 'ready' ? 'bg-emerald-400' : 'bg-amber-400'}`} />
          <span className="min-w-0 flex-1 truncate">{entry.label}</span>
          <span className="text-micro text-app-text-muted">
            {entry.status === 'ready' ? tr('ai.selector.ready') : tr('ai.selector.unavailableShort')}
          </span>
        </button>
      ))}
      {executions.length === 0 && (
        <div className="px-3 py-4 text-center text-mini text-app-text-muted">
          <p>{tr('ai.selector.none')}</p>
          <button disabled={disabled} className="mt-1.5 text-primary hover:underline disabled:opacity-40" onClick={() => { openSettings('providers'); onClose?.(); }}>
            {tr('ai.selector.openSettings')}
          </button>
        </div>
      )}
    </div>
  );
}
