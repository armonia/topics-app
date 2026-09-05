import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import { createPortal } from 'react-dom';
import { Search, Settings, X, RefreshCw, Check } from 'lucide-react';
import { useProvidersSnapshot } from '../../hooks/useProvidersSnapshot';
import { useDismissable } from '../../hooks/useDismissable';
import { POPOVER_PANEL, Z_POPOVER } from '@/lib/popoverStyles';
import type { ProviderSnapshotEntry } from '../../types';
import { resolveEffectiveProvider } from '@/lib/effortTiers';
import { splitModelId } from '@/lib/modelLabel';
import { contextWindowFor, formatContextWindow } from '../../../../shared/context-window';

/**
 * L'etichetta la DICE il server, dentro lo snapshot (`entry.label`).
 *
 * Qui viveva una seconda tabella `PROVIDER_LABELS`, copia di quella in
 * `server/providers/snapshot-manager.ts` — e le due erano già divergenti:
 * `openai` era «OpenAI» di là e «OpenAI (ChatGPT)» di qua. Non se ne accorgeva
 * nessuno proprio perché era morta: `entry.label` arriva sempre e vince, quindi
 * la copia si vedeva al massimo per un fotogramma di boot, giusto il tempo di
 * dare un nome diverso allo stesso provider. È lo specchio che
 * `tests/unit/no-type-mirrors.test.ts` esiste per vietare.
 *
 * Il ripiego è il nome nudo: un provider senza etichetta è un provider che il
 * server non conosce, e inventargli un nome qui sarebbe indovinare.
 */
function labelFor(entry: ProviderSnapshotEntry): string {
  return entry.label ?? entry.name;
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
  /* L'EFFORT NON PASSA DI QUI, ed è una scelta. Questo bottone apre la lista dei
     modelli: ci finiva anche il tier perché era l'unico posto dove si vedeva,
     mentre a cambiarlo era un altro controllo — che a sua volta non lo mostrava.
     Adesso il valore sta sul trigger che lo governa (`SessionConfigPopover`) e
     qui resta solo ciò che riguarda il modello: nome e finestra. */
}

export function ProviderModelPicker({ override, defaultProviderLabel, onChange, onOpenSettings }: Props) {
  const tr = useT();
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

  // L'id esatto del modello in uso: e' l'IDENTITA', separata da come la si
  // mostra. Finisce anche in `data-model` sul bottone, cosi' chi deve sapere
  // "quale modello" (i test, e chiunque ispezioni la UI) non deve dedurlo
  // leggendo un'etichetta pensata per gli occhi.
  const activeModelId = effective?.model ?? override?.model ?? null;
  // Il `[1m]` viene staccato dal nome: dentro uno span `truncate` quel suffisso
  // compete per la larghezza col nome, e su una pane stretta a essere tagliato
  // via era proprio lui — cioe' l'unica differenza visibile fra una finestra da
  // 200k e una da 1M. Fuori dal truncate diventa un badge che non si accorcia.
  const { name: modelName } = splitModelId(activeModelId ?? '');

  // La finestra del modello in uso. Prima qui c'era un badge `1M` che compariva
  // SOLO sulle varianti col suffisso `[1m]`: leggendo la barra, un modello senza
  // badge poteva essere da 200k o da un milione: l'assenza non distingueva «non
  // e' lungo» da «non lo diciamo». Adesso il numero c'e' sempre, e quando non lo
  // conosciamo lo dichiara con la tilde invece di tacere.
  const activeWindow = useMemo(() => contextWindowFor(activeModelId), [activeModelId]);

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
        data-model={activeModelId ?? undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="provider-model-listbox"
        className="inline-flex flex-shrink-0 items-center gap-1 px-2 h-8 rounded-lg text-[11px] font-medium transition-colors text-app-text-muted hover:text-app-text hover:bg-app-hover"
        title="Provider & model"
      >
        {/* Qui c'era un lampo, e non diceva niente: accanto c'è già scritto
            «Opus 5». Stava anche a due bottoni dal lampo del Fast Mode, che di
            lampi ne fa uno solo con un significato — velocità — e questo lo
            diluiva. Il bottone resta `flex-shrink-0`: la larghezza la cede SOLO
            l'etichetta del modello, col suo `truncate`, o si deformerebbe il
            badge della finestra, che accorciarsi non può. */}
        {/* Shrinks further once the composer's @container (the pane width,
            not the viewport) drops below 380px — keeps the effort badge and
            the rest of the action bar reachable on a narrow tab. */}
        <span className="max-w-[160px] @max-[380px]:max-w-[70px] truncate">{modelName || 'Model'}</span>
        {/* La finestra del modello, sempre. Il numero e' l'unica cosa che
            distingue due modelli che sulla barra si assomigliano, ed e' la
            ragione per cui si sceglie l'uno o l'altro a meta' conversazione.
            La tilde non e' decorazione: dice che il modello non e' in tabella e
            quel numero e' il default, non una misura. */}
        <span
          data-testid="model-context-badge"
          data-context-tokens={activeWindow.tokens}
          data-context-known={activeWindow.known ? 'true' : 'false'}
          className={`text-[9px] font-semibold tracking-wide px-1 rounded flex-shrink-0 tabular-nums ${
            activeWindow.known ? 'bg-primary/15 text-primary' : 'bg-app-hover text-app-text-muted'
          }`}
          title={activeWindow.known
            ? tr('model.ctxWindow', { n: activeWindow.tokens.toLocaleString('it-IT') })
            : tr('model.ctxWindow.guess', { n: activeWindow.tokens.toLocaleString('it-IT') })}
        >
          {activeWindow.known ? '' : '≈'}{formatContextWindow(activeWindow.tokens)}
        </span>
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
            <Search size={12} className="text-app-text-secondary flex-shrink-0" />
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
                    {/* Il tier del provider stava qui accanto al nome. Se n'è
                        andato con l'altro badge: l'effort in forza — default del
                        provider oppure override della chat — si legge tutto in
                        UN posto, il pannello che lo cambia, che lo dice per
                        esteso («Default del provider (xhigh)»). Ripeterlo qui
                        significava due grafiche diverse per lo stesso valore in
                        due popover diversi. */}
                    {entry.isDefault && (
                      <span className="ml-auto text-[11px] bg-primary/20 text-primary px-1 rounded">Default</span>
                    )}
                  </div>
                  {provModels.map((m) => {
                    const isSelected = override?.provider === entry.name && override?.model === m;
                    const rowIdx = cursor++;
                    const isActive = rowIdx === activeIndex;
                    // La finestra di QUESTO modello. È il dato che fa scegliere
                    // fra due righe altrimenti identiche a occhio — e mancava
                    // proprio nel momento della scelta: si vedeva solo dopo, sul
                    // bottone, e solo per le varianti col suffisso.
                    const win = contextWindowFor(m);
                    return (
                      <button
                        key={`${entry.name}:${m}`}
                        id={`pmp-opt-${rowIdx}`}
                        role="option"
                        aria-selected={isSelected}
                        ref={(el) => { rowRefs.current[rowIdx] = el; }}
                        data-row-index={rowIdx}
                        data-model={m}
                        data-active={isActive ? 'true' : undefined}
                        onMouseEnter={() => setActiveIndex(rowIdx)}
                        onClick={() => select(entry.name, m)}
                        className={`w-full flex items-center gap-2 pl-5 pr-2.5 py-1 text-left text-[11px] transition-colors ${
                          isSelected
                            ? 'bg-primary/15 text-primary font-medium'
                            : isActive
                              ? 'bg-app-hover text-app-text'
                              : 'text-app-text-secondary hover:bg-app-hover'
                        }`}
                      >
                        {/* Tre colonne, e in quest'ordine: il nome cede lui la
                            larghezza (`truncate` + `min-w-0`), la finestra e la
                            spunta no. Il segno di spunta occupa il suo posto
                            ANCHE quando non c'è (`w-3` sempre reso): altrimenti
                            la colonna dei numeri ballerebbe di tre pixel sulla
                            riga selezionata, che è l'unica che si guarda. */}
                        <span className="font-mono truncate min-w-0">{m}</span>
                        <span
                          data-testid={`model-window-${m}`}
                          data-context-tokens={win.tokens}
                          data-context-known={win.known ? 'true' : 'false'}
                          className={`ml-auto flex-shrink-0 text-[10px] tabular-nums ${
                            isSelected ? 'text-primary/80' : 'text-app-text-muted'
                          }`}
                          title={win.known
                            ? tr('model.ctxWindow', { n: win.tokens.toLocaleString('it-IT') })
                            : tr('model.ctxWindow.guess', { n: win.tokens.toLocaleString('it-IT') })}
                        >
                          {win.known ? '' : '≈'}{formatContextWindow(win.tokens)}
                        </span>
                        <span className="w-3 flex-shrink-0 text-center" aria-hidden={!isSelected}>
                          {isSelected && <Check className="w-4 h-4" aria-hidden="true" />}
                        </span>
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
