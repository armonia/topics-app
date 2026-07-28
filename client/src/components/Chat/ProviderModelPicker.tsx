import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, Settings, Zap, X, RefreshCw } from 'lucide-react';
import { useProvidersSnapshot } from '../../hooks/useProvidersSnapshot';
import { useDismissable } from '../../hooks/useDismissable';
import { POPOVER_PANEL, Z_POPOVER } from '@/lib/popoverStyles';
import type { ProviderSnapshotEntry } from '../../types';
import { resolveEffectiveProvider, providerEffortTier } from '@/lib/effortTiers';

const PROVIDER_LABELS: Record<string, string> = {
  openclaw: 'OpenClaw',
  claude: 'Claude (API)',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  openai: 'OpenAI (ChatGPT)',
};

function labelFor(entry: ProviderSnapshotEntry): string {
  return entry.label ?? PROVIDER_LABELS[entry.name] ?? entry.name;
}

export interface ProviderModelOverride {
  provider: string;
  model: string;
}

interface Props {
  /** Currently selected override (null = use topic/global default) */
  override: ProviderModelOverride | null;
  /** Default provider name to display when override is null */
  defaultProviderLabel?: string;
  onChange: (override: ProviderModelOverride | null) => void;
  onOpenSettings?: () => void;
  /** Per-topic effort-tier override (migration 033), letto in SOLA LETTURA
   *  per il badge: qui l'effort si VEDE, si cambia dal SessionConfigPopover.
   *  Averlo in due posti significava due sorgenti di verità per la stessa
   *  impostazione, in due popover diversi, con due grafiche diverse. */
  effort?: string | null;
}

export function ProviderModelPicker({ override, defaultProviderLabel, onChange, onOpenSettings, effort }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // Per-row refs let us scroll the highlighted row into view as the user
  // arrows past the visible window.
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Single subscription point — replaces the per-component fetches the picker
  // used to do. The hook handles initial fetch, WS push updates, and reconnect.
  const { snapshot, error, retry, refresh } = useProvidersSnapshot();
  // Memoize so the `?? []` fallback doesn't mint a fresh array each render,
  // which would invalidate the useMemo hooks below on every render.
  const entries: ProviderSnapshotEntry[] = useMemo(() => snapshot?.providers ?? [], [snapshot]);

  // Outside-pointer + Escape close is delegated to the shared useDismissable
  // contract (capture-phase pointerdown/touch + Escape, focus-restore to the
  // trigger). The popover keeps its OWN onKeyDown for arrow/enter nav below —
  // useDismissable handles closing, not arrow-key navigation.
  useDismissable({ open, onClose: () => setOpen(false), refs: [btnRef, popoverRef] });

  // Resolve the effective selection (override → topic provider → global default)
  // so the button can show the actual model name in use.
  const effective = useMemo(
    () => resolveEffectiveProvider(entries, override, defaultProviderLabel),
    [override, entries, defaultProviderLabel],
  );

  const buttonLabel = useMemo(() => {
    if (effective) return effective.model;
    if (override) return override.model;
    return 'Model';
  }, [effective, override]);

  // Effort/reasoning tier the server forces on the ACTIVE provider's sessions
  // (read-only policy, e.g. `--effort xhigh` for claude-code). Shown as a
  // badge next to the model name; absent for providers without a tier.
  const activeEffortTier = useMemo(
    () => providerEffortTier(entries, effective, override),
    [effective, override, entries],
  );

  // Il tier davvero in forza per questa topic = override per-topic → default
  // del provider. Il badge lo mostra; cambiarlo è affare del SessionConfigPopover.
  const effectiveEffort = effort ?? activeEffortTier ?? null;

  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries
      .filter((e) => e.status === 'ready')
      .map((e) => {
        const label = labelFor(e);
        const matchesProv = !q || label.toLowerCase().includes(q) || e.name.toLowerCase().includes(q);
        const matchedModels = q
          ? e.models.filter((m) => m.toLowerCase().includes(q))
          : e.models;
        const visibleModels = matchesProv ? e.models : matchedModels;
        return { entry: e, label, models: visibleModels, hasMatch: matchesProv || matchedModels.length > 0 };
      })
      .filter((g) => g.hasMatch);
  }, [entries, search]);

  // Flat list of selectable rows in render order — drives ↑/↓ keyboard nav.
  const flatRows = useMemo(() => {
    const rows: Array<{ provider: string; model: string }> = [];
    for (const g of filteredGroups) {
      for (const m of g.models) rows.push({ provider: g.entry.name, model: m });
    }
    return rows;
  }, [filteredGroups]);

  // Reset the highlight whenever the visible list changes (open, type to
  // search, snapshot push). Clamp into range so React doesn't render an
  // out-of-bounds highlight.
  useEffect(() => {
    setActiveIndex((idx) => {
      if (flatRows.length === 0) return 0;
      return Math.max(0, Math.min(idx, flatRows.length - 1));
    });
  }, [flatRows.length]);
  useEffect(() => { setActiveIndex(0); }, [search]);
  useEffect(() => { if (open) setActiveIndex(0); }, [open]);
  // Keep the highlighted row in view as the user arrows past the popover edge.
  useEffect(() => {
    if (!open) return;
    rowRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const select = (provider: string, model: string) => {
    if (override?.provider === provider && override?.model === model) {
      onChange(null); // toggle off
    } else {
      onChange({ provider, model });
    }
    setOpen(false);
  };

  const clearOverride = () => {
    onChange(null);
    setOpen(false);
  };

  const popoverPos = open && btnRef.current ? (() => {
    const rect = btnRef.current.getBoundingClientRect();
    return {
      bottom: window.innerHeight - rect.top + 6,
      left: Math.min(rect.left, window.innerWidth - 340),
    };
  })() : null;

  const noProvidersReady = entries.length > 0 && filteredGroups.length === 0 && search.trim() === '';

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(!open)}
        data-testid="provider-model-picker"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="provider-model-listbox"
        className="inline-flex items-center gap-1 px-2 h-8 rounded-lg text-[11px] font-medium transition-colors text-app-text-muted hover:text-app-text hover:bg-app-hover"
        title="Provider & model"
      >
        <Zap size={11} />
        {/* Shrinks further once the composer's @container (the pane width,
            not the viewport) drops below 380px — keeps the effort badge and
            the rest of the action bar reachable on a narrow tab. */}
        <span className="max-w-[160px] @max-[380px]:max-w-[70px] truncate">{buttonLabel}</span>
        {effectiveEffort && (
          <span
            data-testid="effort-tier-badge"
            data-overridden={effort ? 'true' : undefined}
            className={`text-[9px] uppercase tracking-wide px-1 rounded flex-shrink-0 ${
              effort ? 'bg-primary/30 text-primary font-semibold' : 'bg-primary/15 text-primary'
            }`}
            title={
              effort
                ? `Per-topic effort override: ${effectiveEffort} (provider default: ${activeEffortTier ?? '—'})`
                : `Effort tier Topics forces for this provider's sessions: ${effectiveEffort}`
            }
          >
            {effectiveEffort}
          </span>
        )}
      </button>

      {open && popoverPos && createPortal(
        <div
          ref={popoverRef}
          data-popover="provider-model-picker"
          // Keyboard nav lives at the popover root so we get every key —
          // arrow keys typed inside the search input bubble up to here, but
          // the popover container itself stays focusable for stray clicks.
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setOpen(false);
              e.stopPropagation();
              return;
            }
            if (flatRows.length === 0) return;
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActiveIndex((idx) => (idx + 1) % flatRows.length);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActiveIndex((idx) => (idx - 1 + flatRows.length) % flatRows.length);
            } else if (e.key === 'Enter') {
              const row = flatRows[activeIndex];
              if (row) { e.preventDefault(); select(row.provider, row.model); }
            }
          }}
          className={`${POPOVER_PANEL} w-[320px] max-h-[70vh] flex flex-col overflow-hidden`}
          data-testid="provider-model-popover"
          style={{
            position: 'fixed',
            bottom: popoverPos.bottom,
            left: popoverPos.left,
            zIndex: Z_POPOVER,
          }}
        >
          {/* Header — search + refresh */}
          <div className="flex items-center gap-1.5 px-2.5 py-2 border-b border-app-border">
            <Search size={12} className="text-app-text-muted flex-shrink-0" />
            <input
              autoFocus
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search provider or model"
              className="flex-1 min-w-0 bg-transparent text-[12px] text-app-text placeholder:text-app-text-muted focus:outline-none"
            />
            {search ? (
              <button
                onClick={() => setSearch('')}
                className="text-app-text-muted hover:text-app-text"
                title="Clear search"
              >
                <X size={11} />
              </button>
            ) : (
              <button
                onClick={() => void refresh()}
                className="text-app-text-muted hover:text-app-text"
                title="Refresh provider status"
              >
                <RefreshCw size={11} />
              </button>
            )}
          </div>

          {/* Provider/model groups */}
          <div
            id="provider-model-listbox"
            role="listbox"
            aria-activedescendant={flatRows.length ? `pmp-opt-${activeIndex}` : undefined}
            className="overflow-y-auto flex-1 py-1"
          >
            {/* Error state takes priority over the empty state — without it
                the picker would loop on "No providers ready" forever when
                /api/providers/snapshot fails on first paint, with no way to
                retry short of reloading the page. */}
            {error && !snapshot && (
              <div className="px-3 py-6 text-center">
                <div className="text-[11px] text-red-500 mb-2">Couldn't load providers.</div>
                <button
                  onClick={() => void retry()}
                  className="text-[11px] text-primary hover:underline"
                >
                  Retry
                </button>
              </div>
            )}
            {!error && noProvidersReady && (
              <div className="px-3 py-6 text-center">
                <div className="text-[11px] text-app-text-muted mb-2">No providers ready.</div>
                {onOpenSettings && (
                  <button
                    onClick={() => { onOpenSettings(); setOpen(false); }}
                    className="text-[11px] text-primary hover:underline"
                  >
                    Open Settings
                  </button>
                )}
              </div>
            )}
            {!error && !noProvidersReady && filteredGroups.length === 0 && (
              <div className="px-3 py-4 text-[11px] text-app-text-muted text-center">No matches.</div>
            )}
            {(() => {
              // Reset the row-refs array each render so removed rows don't
              // hold stale DOM nodes. We assign refs while iterating below.
              rowRefs.current = [];
              let cursor = 0;
              return filteredGroups.map(({ entry, label, models: provModels }) => (
                <div key={entry.name} className="py-0.5">
                  <div className="flex items-center gap-1.5 px-2.5 py-1">
                    <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-green-500" />
                    <span className="text-[11px] font-semibold text-app-text">{label}</span>
                    {entry.effortTier && (
                      <span
                        data-testid={`effort-tier-${entry.name}`}
                        className="text-[9px] uppercase tracking-wide text-app-text-muted border border-app-border px-1 rounded"
                        title={`Effort tier Topics forces for ${label} sessions: ${entry.effortTier}`}
                      >
                        {entry.effortTier}
                      </span>
                    )}
                    {entry.isDefault && (
                      <span className="ml-auto text-[11px] bg-primary/20 text-primary px-1 rounded">Default</span>
                    )}
                  </div>
                  {provModels.map((m) => {
                    const isSelected = override?.provider === entry.name && override?.model === m;
                    const rowIdx = cursor++;
                    const isActive = rowIdx === activeIndex;
                    return (
                      <button
                        key={`${entry.name}:${m}`}
                        id={`pmp-opt-${rowIdx}`}
                        role="option"
                        aria-selected={isSelected}
                        ref={(el) => { rowRefs.current[rowIdx] = el; }}
                        data-row-index={rowIdx}
                        data-active={isActive ? 'true' : undefined}
                        onMouseEnter={() => setActiveIndex(rowIdx)}
                        onClick={() => select(entry.name, m)}
                        className={`w-full flex items-center gap-2 px-5 py-1 text-left text-[11px] transition-colors ${
                          isSelected
                            ? 'bg-primary/15 text-primary font-medium'
                            : isActive
                              ? 'bg-app-hover text-app-text'
                              : 'text-app-text-secondary hover:bg-app-hover'
                        }`}
                      >
                        <span className="font-mono">{m}</span>
                        {isSelected && <span className="ml-auto text-[11px]">✓</span>}
                      </button>
                    );
                  })}
                </div>
              ));
            })()}
          </div>

          {/* Footer */}
          <div className="px-2.5 py-2 border-t border-app-border flex items-center justify-between gap-2">
            <div className="text-[11px] text-app-text-muted truncate">
              {override ? (
                <button onClick={clearOverride} className="hover:text-app-text underline">Reset to default</button>
              ) : effective ? (
                `Default: ${labelFor(entries.find((e) => e.name === effective.provider) ?? { name: effective.provider } as ProviderSnapshotEntry)}`
              ) : (
                'No provider configured'
              )}
            </div>
            {onOpenSettings && (
              <button
                onClick={() => { onOpenSettings(); setOpen(false); }}
                className="flex items-center gap-1 text-[11px] text-app-text-muted hover:text-app-text"
              >
                <Settings size={10} />
                Settings
              </button>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
