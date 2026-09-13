import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, Settings, Sparkles } from 'lucide-react';
import type { ProviderSnapshotEntry, ProvidersSnapshot } from '../../types';
import { taskExecutionOptions } from '../../../../shared/task-coding-models';
import { contextWindowFor, formatContextWindow } from '../../../../shared/context-window';
import { friendlyModelLabel } from '../../lib/modelLabel';
import { POPOVER_ITEM } from '../../lib/popoverStyles';
import { openSettings } from '../../lib/openSettings';
import { useT } from '../../hooks/useT';

export interface AiExecutionSelection {
  provider: string | null;
  model: string | null;
}

interface Props {
  snapshot: ProvidersSnapshot | null;
  surface: 'chat' | 'task';
  value: AiExecutionSelection;
  onSelect: (selection: AiExecutionSelection) => void;
  automaticLabel: string;
  automaticHint: string;
  disabled?: boolean;
  allowRuntimeAutomatic?: boolean;
  onClose?: () => void;
}

interface ExecutionRow {
  name: string;
  label: string;
  status: ProviderSnapshotEntry['status'];
  models: string[];
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
function ModelWindowLabel({ model, selected }: { model: string; selected: boolean }) {
  const tr = useT();
  const win = contextWindowFor(model);
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
  return (snapshot?.providers ?? []).map((entry) => ({
    name: entry.name,
    label: entry.label ?? entry.name,
    status: entry.status,
    models: entry.models,
    supportsAutomatic: true,
    reason: entry.lastError ?? entry.requirements.find((requirement) => !requirement.present)?.hint,
  }));
}

export function AiExecutionMenuOptions({
  snapshot,
  surface,
  value,
  onSelect,
  automaticLabel,
  automaticHint,
  disabled,
  allowRuntimeAutomatic = false,
  onClose,
}: Props) {
  const tr = useT();
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

  const active = executions.find((entry) => entry.name === activeProvider)
    ?? (activeProvider ? {
      name: activeProvider,
      label: activeProvider,
      status: 'unavailable' as const,
      models: value.model ? [value.model] : [],
      supportsAutomatic: false,
      reason: tr('ai.selector.noLongerAvailable'),
    } : null);

  if (active) {
    const ready = active.status === 'ready';
    const missingSelectedModel = !!value.model && !active.models.includes(value.model);
    const unavailableReason = active.reason || tr('ai.selector.noLongerAvailable');
    return (
      <div ref={panelRef} className="w-[min(22rem,calc(100vw-1rem))] max-w-full py-1" data-testid="ai-selector-models">
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
        {value.model && (!ready || missingSelectedModel) && (
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
            {showWindow && <ModelWindowLabel model={value.model} selected />}
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
                  <ModelWindowLabel model={model} selected={selected} />
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
