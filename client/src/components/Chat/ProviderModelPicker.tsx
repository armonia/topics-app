import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, Loader2, Route } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { useProvidersSnapshot } from '../../hooks/useProvidersSnapshot';
import { ModelSelector } from '../Shared/ModelSelector/ModelSelector';
import { loadModelList, modelListReady } from '../Shared/ModelSelector/modelListLazy';
import { isChunkLoadError } from '../../lib/chunkReloadGuard';
import { resolveEffectiveProvider } from '../../lib/effortTiers';
import { chatTopicsRoute, resolveTopicsRoutingTarget } from '../../lib/topicsRoutingGate';
import { effectiveTopicsRouting } from '../../../../shared/task-coding-models';
import { splitModelId, friendlyModelLabel } from '../../lib/modelLabel';
import { contextWindowFor, formatContextWindow } from '../../../../shared/context-window';
import { HOME_ANCHOR_ATTR } from '../../lib/openHome';

export interface ProviderModelOverride {
  provider: string;
  model: string;
}

interface Props {
  override: ProviderModelOverride | null;
  defaultProviderLabel?: string;
  onChange: (override: ProviderModelOverride | null) => void;
  /** AICTRL-01 switch: null = never set explicitly (legacy topics: fallback). */
  topicsRouting?: boolean | null;
  onTopicsRoutingChange?: (next: boolean) => void;
  /** Filled with this menu's door, for a typed `/model` and ⌘⇧M (`toggle`). */
  openRef?: React.RefObject<((mode?: 'open' | 'toggle') => void) | null>;
}

/** The chat composer's model selector (`ModelSelector`, scope `chat`, variant `compact`). */
export function ProviderModelPicker({ override, defaultProviderLabel, onChange, topicsRouting, onTopicsRoutingChange, openRef }: Props) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const openNowRef = useRef(open);
  useEffect(() => { openNowRef.current = open; }, [open]);
  // Where the menu chunk stands, as far as this chip knows: a click that waits
  // shows it is working, a load that failed shows it on the chip. `failed` =
  // the chunk did not arrive (a reload is the cure); `broken` = it arrived and
  // threw, a bug a reload does not fix, so the chip does not offer one.
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'failed' | 'broken'>('idle');
  const onLoadError = (error: unknown) => setLoadState(isChunkLoadError(error) ? 'failed' : 'broken');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { snapshot } = useProvidersSnapshot();
  const entries = useMemo(() => snapshot?.providers ?? [], [snapshot]);
  const effective = useMemo(
    () => resolveEffectiveProvider(entries, override, defaultProviderLabel),
    [entries, override, defaultProviderLabel],
  );
  // Review bug #2: the routing switch must agree with the send gate on what ON
  // targets, which needs the topic's pin even with no active override — `value`
  // below stays override-only on purpose, it drives the panel/checkmark UI.
  const routingTarget = useMemo(
    () => resolveTopicsRoutingTarget(entries, override, defaultProviderLabel),
    [entries, override, defaultProviderLabel],
  );
  const activeModelId = effective?.model ?? override?.model ?? null;
  const { name: modelName } = splitModelId(activeModelId ?? '');
  // The window the provider DECLARES, when there is one, ahead of the table:
  // for a configured endpoint it is the only honest source, and the table of
  // known models cannot possibly know about it.
  const declaredWindow = useMemo(() => {
    const entry = entries.find((candidate) => candidate.name === effective?.provider);
    return activeModelId ? entry?.modelContextWindows?.[activeModelId] : undefined;
  }, [entries, effective?.provider, activeModelId]);
  const activeWindow = useMemo(
    () => contextWindowFor(activeModelId, declaredWindow),
    [activeModelId, declaredWindow],
  );
  const matchesProv = (entry: (typeof entries)[number]) => entry.name === effective?.provider;
  const effectiveProviderLabel = entries.find(matchesProv)?.label ?? effective?.provider;
  // The failure itself is reported by the loader (the reload prompt); the
  // chip only records it, so a hover that failed does not look like nothing.
  const prefetchMenu = () => {
    if (modelListReady()) return;
    loadModelList().then(() => setLoadState('idle'), onLoadError);
  };
  // The menu body is a chunk of its own (see `ModelSelector/modelListLazy`). Opening
  // waits for it, so the panel is placed and focused with its rows already in
  // it. A chunk that fails to load leaves the menu closed but NOT the click
  // unanswered: the loader raises the reload prompt and the chip turns to a
  // warning. The next click tries again.
  const toggle = () => {
    if (open || modelListReady()) {
      setOpen((current) => !current);
      return;
    }
    setLoadState('loading');
    loadModelList().then(
      () => { setLoadState('idle'); setOpen(true); },
      onLoadError,
    );
  };
  // A typed `/model` opens the menu the chip opens, through the same chunk
  // load; ⌘⇧M (MSEL-08) opens it and, pressed again, closes it.
  useEffect(() => {
    if (!openRef) return;
    openRef.current = (mode = 'open') => {
      if (mode === 'toggle' && openNowRef.current) { setOpen(false); return; }
      if (modelListReady()) { setOpen(true); return; }
      setLoadState('loading');
      loadModelList().then(
        () => { setLoadState('idle'); setOpen(true); },
        (error: unknown) => setLoadState(isChunkLoadError(error) ? 'failed' : 'broken'),
      );
    };
    return () => { openRef.current = null; };
  }, [openRef]);
  // MSEL-07: a mark on the chip when the current choice runs through Topics.
  const route = useMemo(
    () => chatTopicsRoute(topicsRouting, override, defaultProviderLabel, snapshot),
    [topicsRouting, override, defaultProviderLabel, snapshot],
  );
  const routingEnabled = effectiveTopicsRouting(topicsRouting, null, 'chat');
  const failed = loadState === 'failed' || loadState === 'broken';
  const chipTitle = loadState === 'failed'
    ? tr('chat.picker.menuFailed')
    : loadState === 'broken' ? tr('chat.picker.menuBroken') : tr('chat.picker.title');

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        onPointerEnter={prefetchMenu}
        onFocus={prefetchMenu}
        data-testid="provider-model-picker"
        // The providers' home (SETHOME-01): a door with no anchor of its own
        // (the palette) opens the providers panel beside this chip.
        {...{ [HOME_ANCHOR_ATTR]: 'providers' }}
        data-model={activeModelId ?? undefined}
        data-load-state={loadState === 'idle' ? undefined : loadState}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-busy={loadState === 'loading' || undefined}
        className={`inline-flex h-8 flex-shrink-0 items-center gap-1 rounded-lg px-2 text-mini font-medium transition-colors hover:bg-app-hover hover:text-app-text ${
          failed ? 'text-amber-600 dark:text-amber-400' : 'text-app-text-muted'
        }`}
        title={chipTitle}
      >
        {route.via === 'topics' && (
          <span data-testid="model-route-mark" title={tr('ai.selector.route.topics')} className="inline-flex shrink-0">
            <Route className="h-3 w-3 text-primary" aria-label={tr('ai.selector.route.topics')} />
          </span>
        )}
        <span className="max-w-[160px] truncate @max-[380px]:max-w-[70px]">
          {modelName ? friendlyModelLabel(modelName) : 'Model'}
        </span>
        <span
          data-testid="model-context-badge"
          data-context-tokens={activeWindow.tokens}
          data-context-known={activeWindow.known ? 'true' : 'false'}
          className={`flex-shrink-0 rounded px-1 text-nano font-semibold tabular-nums ${
            activeWindow.known ? 'bg-primary/15 text-primary' : 'bg-app-hover text-app-text-muted'
          }`}
          title={activeWindow.known
            ? tr('model.ctxWindow', { n: activeWindow.tokens.toLocaleString('it-IT') })
            : tr('model.ctxWindow.guess', { n: activeWindow.tokens.toLocaleString('it-IT') })}
        >
          {activeWindow.known ? '' : '≈'}{formatContextWindow(activeWindow.tokens)}
        </span>
        {loadState === 'loading' ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
        ) : failed ? (
          <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronDown className="h-3 w-3 shrink-0" />
        )}
      </button>
      <ModelSelector
        open={open}
        anchorRef={buttonRef}
        onClose={() => setOpen(false)}
        testId="provider-model-popover"
        ariaLabel={tr('chat.picker.title')}
        scope="chat"
        variant="compact"
        value={{ provider: override?.provider ?? null, model: override?.model ?? null }}
        routingTarget={{ provider: routingTarget?.provider ?? null, model: routingTarget?.model ?? null }}
        onSelect={(selection) => {
          onChange(selection.provider && selection.model
            ? { provider: selection.provider, model: selection.model }
            : null);
        }}
        automatic={{
          label: tr('chat.picker.resetDefault'),
          hint: effectiveProviderLabel
            ? tr('chat.picker.defaultIs', { name: effectiveProviderLabel })
            : tr('chat.picker.noneConfigured'),
        }}
        topicsRouting={onTopicsRoutingChange ? { enabled: routingEnabled, onToggle: onTopicsRoutingChange } : undefined}
      />
    </>
  );
}
