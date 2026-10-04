import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, Loader2, Route } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { useProvidersSnapshot } from '../../hooks/useProvidersSnapshot';
import { ModelSelector } from '../Shared/ModelSelector/ModelSelector';
import { loadModelList, modelListReady } from '../Shared/ModelSelector/modelListLazy';
import { isChunkLoadError } from '../../lib/chunkReloadGuard';
import { resolveEffectiveProvider } from '../../lib/effortTiers';
import { chatRouteTarget, chatTopicsRoute } from '../../lib/topicsRoutingGate';
import { effectiveTopicsRouting } from '../../../../shared/task-coding-models';
import { modelTriggerText, triggerLine } from '../../lib/modelLabel';
import { HOME_ANCHOR_ATTR, HOME_ANCHOR_FOCUSED_ATTR, OPEN_MODEL_SELECTOR_EVENT, type OpenModelSelectorDetail } from '../../lib/openHome';
import type { ProvidersTarget } from '../Settings/AIProvidersSection';

export interface ProviderModelOverride {
  provider: string;
  model: string;
}

interface Props {
  override: ProviderModelOverride | null;
  defaultProviderLabel?: string;
  /** The topic's model when no runtime is pinned (what `/model` writes): the
   *  server judges the route on it, so the chip and the band do too. */
  pinnedModel?: string | null;
  onChange: (override: ProviderModelOverride | null) => void;
  /** «Automatico» within one engine (an engine that lists no model, revision
   *  §3.7): the chat's provider, with no model of its own. */
  onProviderOnly?: (provider: string) => void;
  /** AICTRL-01 switch: null = never set explicitly (legacy topics: fallback). */
  topicsRouting?: boolean | null;
  onTopicsRoutingChange?: (next: boolean) => void;
  /** Filled with this menu's door, for a typed `/model` and ⌘⇧M (`toggle`). */
  openRef?: React.RefObject<((mode?: 'open' | 'toggle') => void) | null>;
  /** Filled with the door to Claude Code's detail inside this chip's
   *  selector, for a typed `/usage` or `/cost`; the focus goes back to
   *  `returnFocus` on close. */
  openProvidersRef?: React.RefObject<((returnFocus?: HTMLElement | null) => void) | null>;
  /** This chip's pane is the focused one: a door with no anchor (the palette) opens here. */
  paneFocused?: boolean;
}

/** The chat composer's model selector (`ModelSelector`, scope `chat`, variant `compact`). */
export function ProviderModelPicker({ override, defaultProviderLabel, pinnedModel = null, onChange, onProviderOnly, topicsRouting, onTopicsRoutingChange, openRef, openProvidersRef, paneFocused = false }: Props) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  // «Provider e chiavi» is a level of this selector (revision 2026-10-04,
  // §5.1): the doors outside it (the palette, the plan-limit notice, a typed
  // `/usage`) open the selector on that level, and the focus goes back where
  // the door says once it closes.
  const [initialLevel, setInitialLevel] = useState<ProvidersTarget | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const close = () => {
    setOpen(false);
    setInitialLevel(null);
    const back = returnFocusRef.current;
    returnFocusRef.current = null;
    // After the menu has given the focus back to the chip.
    if (back) requestAnimationFrame(() => requestAnimationFrame(() => { if (back.isConnected) back.focus({ preventScroll: true }); }));
  };
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
    () => chatRouteTarget(topicsRouting, override, defaultProviderLabel, snapshot, pinnedModel),
    [topicsRouting, override, defaultProviderLabel, snapshot, pinnedModel],
  );
  const activeModelId = effective?.model ?? override?.model ?? null;
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
    if (open) { close(); return; }
    setInitialLevel(null);
    if (modelListReady()) {
      setOpen(true);
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
      setInitialLevel(null);
      if (modelListReady()) { setOpen(true); return; }
      setLoadState('loading');
      loadModelList().then(
        () => { setLoadState('idle'); setOpen(true); },
        (error: unknown) => setLoadState(isChunkLoadError(error) ? 'failed' : 'broken'),
      );
    };
    return () => { openRef.current = null; };
  }, [openRef]);
  const openOnLevel = useRef<(target: ProvidersTarget, returnFocus: HTMLElement | null) => void>(() => {});
  useEffect(() => {
    openOnLevel.current = (target, returnFocus) => {
      returnFocusRef.current = returnFocus;
      // The chip holds the focus as the panel opens, so the last Escape gives
      // it back here (the menu returns it to what held it on opening).
      buttonRef.current?.focus({ preventScroll: true });
      setInitialLevel(target);
      if (modelListReady()) { setOpen(true); return; }
      setLoadState('loading');
      loadModelList().then(() => { setLoadState('idle'); setOpen(true); }, onLoadError);
    };
  });
  useEffect(() => {
    if (!openProvidersRef) return;
    openProvidersRef.current = (returnFocus) => openOnLevel.current({ account: 'claude-code' }, returnFocus ?? null);
    return () => { openProvidersRef.current = null; };
  }, [openProvidersRef]);
  useEffect(() => {
    const chip = buttonRef.current;
    if (!chip) return;
    const onDoor = (event: Event) => {
      const detail = (event as CustomEvent<OpenModelSelectorDetail>).detail;
      event.preventDefault();
      openOnLevel.current(detail?.level === 'account' && detail.account ? { account: detail.account } : {}, detail?.returnFocus ?? null);
    };
    chip.addEventListener(OPEN_MODEL_SELECTOR_EVENT, onDoor);
    return () => chip.removeEventListener(OPEN_MODEL_SELECTOR_EVENT, onDoor);
  }, []);
  // MSEL-07: a mark on the chip when the current choice runs through Topics.
  const route = useMemo(
    () => chatTopicsRoute(topicsRouting, override, defaultProviderLabel, snapshot, pinnedModel),
    [topicsRouting, override, defaultProviderLabel, snapshot, pinnedModel],
  );
  const routingEnabled = effectiveTopicsRouting(topicsRouting, null, 'chat');
  // One closed format on every surface (revision §3.8): «label · who», no
  // context window. No override is Automatic, named with who decides.
  const automaticWho = effectiveProviderLabel ?? '';
  const chipText = !snapshot && !override
    ? tr('ai.selector.chipNone')
    : triggerLine(modelTriggerText(
      { provider: override?.provider ?? null, model: override?.model ?? null },
      { snapshot, tr, surface: 'chat', viaTopics: route.via === 'topics', automaticWho },
    ));
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
        // (the palette) opens this chip's selector on the providers level.
        {...{ [HOME_ANCHOR_ATTR]: 'providers', [HOME_ANCHOR_FOCUSED_ATTR]: paneFocused ? '' : undefined }}
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
        <span data-testid="provider-model-picker-label" className="max-w-[220px] truncate @max-[380px]:max-w-[110px]">
          {chipText}
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
        onClose={close}
        initialLevel={initialLevel}
        testId="provider-model-popover"
        ariaLabel={tr('chat.picker.title')}
        scope="chat"
        variant="compact"
        value={{ provider: override?.provider ?? null, model: override?.model ?? null }}
        routingTarget={routingTarget}
        onSelect={(selection) => {
          if (selection.provider && !selection.model && onProviderOnly) { onProviderOnly(selection.provider); return; }
          onChange(selection.provider && selection.model
            ? { provider: selection.provider, model: selection.model }
            : null);
        }}
        automatic={{
          who: automaticWho,
          hint: effectiveProviderLabel
            ? tr('ai.selector.auto.usesDefault', { name: effectiveProviderLabel })
            : tr('chat.picker.noneConfigured'),
        }}
        topicsRouting={onTopicsRoutingChange ? { enabled: routingEnabled, onToggle: onTopicsRoutingChange } : undefined}
      />
    </>
  );
}
