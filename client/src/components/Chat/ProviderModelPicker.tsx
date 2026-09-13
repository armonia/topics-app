import { Suspense, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { useProvidersSnapshot } from '../../hooks/useProvidersSnapshot';
import { Menu } from '../Shared/Menu';
import { AiExecutionMenuOptions, aiExecutionMenuReady, loadAiExecutionMenu } from '../Shared/aiExecutionMenuLazy';
import { resolveEffectiveProvider } from '../../lib/effortTiers';
import { splitModelId, friendlyModelLabel } from '../../lib/modelLabel';
import { contextWindowFor, formatContextWindow } from '../../../../shared/context-window';

export interface ProviderModelOverride {
  provider: string;
  model: string;
}

interface Props {
  override: ProviderModelOverride | null;
  defaultProviderLabel?: string;
  onChange: (override: ProviderModelOverride | null) => void;
  onOpenSettings?: () => void;
}

/** Chat adapter for the execution-first menu shared with coding tasks. */
export function ProviderModelPicker({ override, defaultProviderLabel, onChange }: Props) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { snapshot } = useProvidersSnapshot();
  const entries = useMemo(() => snapshot?.providers ?? [], [snapshot]);
  const effective = useMemo(
    () => resolveEffectiveProvider(entries, override, defaultProviderLabel),
    [entries, override, defaultProviderLabel],
  );
  const activeModelId = effective?.model ?? override?.model ?? null;
  const { name: modelName } = splitModelId(activeModelId ?? '');
  const activeWindow = useMemo(() => contextWindowFor(activeModelId), [activeModelId]);
  const matchesProv = (entry: (typeof entries)[number]) => entry.name === effective?.provider;
  const effectiveProviderLabel = entries.find(matchesProv)?.label ?? effective?.provider;
  const prefetchMenu = () => { loadAiExecutionMenu().catch(() => {}); };
  // The menu body is a chunk of its own (see `aiExecutionMenuLazy`). Opening
  // waits for it, so the panel is placed and focused with its rows already in
  // it. A chunk that fails to load leaves the chip closed: the stale-bundle
  // toast is what speaks then, and the next click tries again.
  const toggle = () => {
    if (open || aiExecutionMenuReady()) {
      setOpen((current) => !current);
      return;
    }
    loadAiExecutionMenu().then(() => setOpen(true), () => {});
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        onPointerEnter={prefetchMenu}
        onFocus={prefetchMenu}
        data-testid="provider-model-picker"
        data-model={activeModelId ?? undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex h-8 flex-shrink-0 items-center gap-1 rounded-lg px-2 text-mini font-medium text-app-text-muted transition-colors hover:bg-app-hover hover:text-app-text"
        title={tr('chat.picker.title')}
      >
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
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>
      <Menu
        open={open}
        anchorRef={buttonRef}
        onClose={() => setOpen(false)}
        role="listbox"
        minWidth={320}
        className="max-w-[calc(100vw-1rem)] overflow-hidden"
        testId="provider-model-popover"
        ariaLabel={tr('chat.picker.title')}
      >
        <Suspense fallback={null}>
          <AiExecutionMenuOptions
            snapshot={snapshot}
            surface="chat"
            value={{ provider: override?.provider ?? null, model: override?.model ?? null }}
            onSelect={(selection) => {
              onChange(selection.provider && selection.model
                ? { provider: selection.provider, model: selection.model }
                : null);
            }}
            automaticLabel={tr('chat.picker.resetDefault')}
            automaticHint={effectiveProviderLabel
              ? tr('chat.picker.defaultIs', { name: effectiveProviderLabel })
              : tr('chat.picker.noneConfigured')}
            onClose={() => setOpen(false)}
          />
        </Suspense>
      </Menu>
    </>
  );
}
