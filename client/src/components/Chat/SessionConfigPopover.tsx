// SessionConfigPopover — the per-chat knobs you actually want to change MID
// conversation, in one place, reachable from the composer.
//
// Before this they were scattered and half-hidden:
//   - EFFORT lived inside the provider/model popover, below a provider search
//     field, behind a trigger labelled "Provider & model". The composer showed
//     the current tier only as a non-clickable badge, so "change the effort"
//     meant opening a menu about something else.
//
// L'effort passa dal funnel `onEffortChange` che esisteva già (e che respawna
// una CLI a riposo): qui non si inventa niente, si dà una superficie a uno stato
// per-topic che il composer aveva già in mano.
//
// Qui c'era anche AUTONOMIA, rimossa il 30/07: mostrava "Chiedi — Approvi ogni
// azione" selezionato su ogni topic mentre lo spawn usa `bypassPermissions`.
// Non è collegabile finché il server non gestisce il canale di permesso della
// CLI — vedi openspec/changes/autonomy-level-needs-permission-channel/.
import { useMemo, useRef, useState } from 'react';
import { useT } from '@/hooks/useT';
import { createPortal } from 'react-dom';
import { SlidersHorizontal, RotateCcw } from 'lucide-react';
import { useDismissable } from '@/hooks/useDismissable';
import { POPOVER_PANEL, POPOVER_MARGIN, Z_POPOVER } from '@/lib/popoverStyles';
import { useProvidersSnapshot } from '@/hooks/useProvidersSnapshot';
import {
  EFFORT_TIERS,
  effortIndex,
  providerEffortTier,
  resolveEffectiveProvider,
  type ProviderSelection,
} from '@/lib/effortTiers';


/** Own width — lets the horizontal clamp work without a measure pass. */
const PANEL_W = 260;

interface SessionConfigPopoverProps {
  /** Per-topic effort override; null = provider default. */
  effort: string | null;
  onEffortChange?: (effort: string | null) => void;
  /** Absent when the active provider exposes no effort tiers. */
  effortSupported: boolean;
  /** Override provider/modello in forza, per risalire al tier di DEFAULT: senza
   *  quello lo slider non saprebbe dove mettere il pollice quando non c'è
   *  override, e "default" resterebbe una parola senza posizione. */
  providerOverride?: ProviderSelection | null;
  defaultProviderLabel?: string;
}

export function SessionConfigPopover({
  effort,
  onEffortChange,
  effortSupported,
  providerOverride,
  defaultProviderLabel,
}: SessionConfigPopoverProps) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useDismissable({ open, onClose: () => setOpen(false), refs: [panelRef, btnRef] });

  // Stessa risoluzione del picker (lib/effortTiers.ts): il tier di default è
  // quello del provider attivo, ed è il riferimento contro cui si legge
  // l'override per-topic.
  const { snapshot } = useProvidersSnapshot();
  const entries = useMemo(() => snapshot?.providers ?? [], [snapshot]);
  const defaultTier = useMemo(() => {
    const effective = resolveEffectiveProvider(entries, providerOverride ?? null, defaultProviderLabel);
    return providerEffortTier(entries, effective, providerOverride ?? null);
  }, [entries, providerOverride, defaultProviderLabel]);

  // Il pollice sta SEMPRE da qualche parte: sull'override se c'è, altrimenti
  // sul default del provider. Se nemmeno quello si conosce (provider senza
  // tier, snapshot non ancora arrivato) si parte da 'high', il centro scala,
  // ma senza spacciarlo per un valore in forza: la riga sotto dice quale dei
  // due casi è.
  const sliderTier = effort ?? defaultTier ?? null;
  const sliderIndex = Math.max(0, effortIndex(sliderTier) >= 0 ? effortIndex(sliderTier) : 2);
  // Quello che il trigger MOSTRA: lo stesso valore del pollice dello slider —
  // l'override se c'è, altrimenti il default del provider. Non è un dettaglio
  // grafico: un badge che compariva solo con l'override lasciava il caso comune
  // (nessun override) senza nessun numero, cioè con un bottone che non diceva
  // cosa governava. `null` solo quando l'effort in forza non si conosce davvero,
  // ed è l'unico caso in cui si torna all'icona: meglio nessun numero che uno
  // inventato.
  const shownTier = effort ?? defaultTier ?? null;

  // With neither knob available there is nothing to show — stay invisible
  // rather than offer an empty panel.
  // Rimasto solo l'effort (piu' l'etichetta del provider, informativa): senza
  // supporto all'effort il popover non ha piu' niente da mostrare. Prima la
  // guardia teneva in vita anche il caso "solo autonomia".
  if (!effortSupported) return null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => {
          const r = btnRef.current?.getBoundingClientRect();
          if (r) {
            // Opens ABOVE the composer (it sits at the bottom of the pane), so
            // the anchor is the button's top edge. Clamped on both axes.
            setPos({
              top: Math.max(POPOVER_MARGIN, r.top - 8),
              left: Math.max(
                POPOVER_MARGIN,
                Math.min(r.left, window.innerWidth - PANEL_W - POPOVER_MARGIN),
              ),
            });
          }
          setOpen((v) => !v);
        }}
        className={`flex-shrink-0 flex items-center justify-center h-8 px-1.5 rounded-lg transition-colors ${
          open ? 'bg-app-hover text-app-text' : 'text-app-text-muted hover:bg-app-hover hover:text-app-text'
        }`}
        title={shownTier
          ? effort
            ? tr('chat.effort.set', { effort, fallback: defaultTier ? tr('chat.effort.providerDefaultIs', { tier: defaultTier }) : '' })
            : tr('chat.effort.fromProvider', { tier: shownTier })
          : tr('chat.config.effort')}
        aria-label={shownTier
          ? tr('chat.config.aria', { tier: shownTier, how: effort ? tr('chat.effort.setSuffix') : tr('chat.effort.defaultSuffix') })
          : tr('chat.config')}
        aria-expanded={open}
        data-testid="chat-session-config"
      >
        {/* IL VALORE AL POSTO DELL'ICONA. Un `SlidersHorizontal` dice "qui si
            regola qualcosa" e nient'altro: il tier in forza — l'unica cosa che
            questo bottone governa — stava sul bottone del MODELLO, cioè su un
            controllo che apre un'altra lista e non lo cambia. Adesso il numero è
            sul controllo che lo cambia, ed è l'icona a essere superflua.
            SLOT A LARGHEZZA FISSA: le sigle vanno da 3 (LOW) a 6 (MEDIUM)
            caratteri, e l'icona ne occupa 16 di pixel. A larghezza libera ogni
            cambio di effort — e l'arrivo stesso dello snapshot dei provider —
            avrebbe spostato tutto ciò che sta a destra nella barra. Con lo slot
            fisso e il testo centrato non si muove un pixel, in nessuno dei tre
            stati. */}
        <span className="w-[42px] flex items-center justify-center">
          {shownTier ? (
            <span
              data-testid="session-effort-badge"
              data-effort-source={effort ? 'override' : 'default'}
              className={`w-full text-center text-[9px] uppercase tracking-wide px-1 py-0.5 rounded font-semibold tabular-nums ${
                // L'override è una scelta TUA e si vede; il default del provider
                // è un fatto, e sta smorzato. Due pesi diversi per due cose
                // diverse, senza bisogno di leggere il pannello per distinguerle.
                effort ? 'bg-primary/30 text-primary' : 'bg-app-hover/60 text-app-text-muted'
              }`}
            >
              {shownTier}
            </span>
          ) : (
            <SlidersHorizontal size={16} />
          )}
        </span>
      </button>

      {open && pos && createPortal(
        <div
          ref={panelRef}
          className={`fixed ${POPOVER_PANEL} p-3 overflow-y-auto overscroll-contain`}
          style={{
            // translateY(-100%) puts the panel entirely above the trigger
            // without needing to measure its height first.
            top: pos.top,
            left: pos.left,
            width: PANEL_W,
            transform: 'translateY(-100%)',
            maxHeight: `calc(${pos.top}px - ${POPOVER_MARGIN}px)`,
            zIndex: Z_POPOVER,
          }}
          data-testid="chat-session-config-panel"
        >
          {effortSupported && onEffortChange && (
            <div className="mb-3">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-app-text-tertiary">
                  Effort
                </span>
                {effort && (
                  <button
                    type="button"
                    onClick={() => onEffortChange(null)}
                    className="flex items-center gap-1 text-[10px] text-app-text-muted hover:text-app-text transition-colors"
                    title={tr('chat.effort.reset')}
                  >
                    <RotateCcw size={10} />
                    Default
                  </button>
                )}
              </div>
              {/* Slider, non pill: la scala low→max è ORDINATA, e cinque
                  bottoni affiancati non lo dicono. Trascinare sul tier che è
                  già il default del provider CANCELLA l'override, così la
                  topic continua a seguire il default se cambia. */}
              <input
                type="range"
                min={0}
                max={EFFORT_TIERS.length - 1}
                step={1}
                value={sliderIndex}
                onChange={(e) => {
                  const tier = EFFORT_TIERS[Number(e.target.value)];
                  onEffortChange(tier === defaultTier ? null : tier);
                }}
                aria-label="Reasoning effort"
                aria-valuetext={EFFORT_TIERS[sliderIndex]}
                data-testid="session-effort-slider"
                data-effort-tier={EFFORT_TIERS[sliderIndex]}
                data-effort-overridden={effort ? 'true' : undefined}
                className="w-full accent-primary cursor-pointer"
              />
              <div className="flex justify-between mt-0.5">
                {EFFORT_TIERS.map((t, i) => (
                  <span
                    key={t}
                    data-testid={`session-effort-${t}`}
                    className={`text-[9px] uppercase tracking-wide ${
                      i === sliderIndex
                        ? effort
                          ? 'text-primary font-semibold'
                          : 'text-app-text-secondary font-semibold'
                        : 'text-app-text-muted'
                    }`}
                  >
                    {t}
                  </span>
                ))}
              </div>
              <div className="mt-1 text-[10px] text-app-text-muted">
                {effort
                  ? `Override per questa chat${defaultTier ? ` · default ${defaultTier}` : ''}`
                  : defaultTier
                    ? `Default del provider (${defaultTier})`
                    : 'Default del provider'}
              </div>
            </div>
          )}

          {/* Il selettore "Autonomia" stava qui, e MENTIVA: mostrava "Chiedi —
              Approvi ogni azione" selezionato su ogni topic (è il default di
              schema, tutti i 461 nel DB reale) mentre lo spawn usa
              `bypassPermissions`. I livelli non sono collegabili finché il
              server non gestisce il canale di permesso della CLI —
              `can_use_tool` non compare da nessuna parte, quindi un
              `--permission-mode` che CHIEDE lascia il turno appeso al watchdog.
              Motivo e piano in
              openspec/changes/autonomy-level-needs-permission-channel/.
              Colonna, PATCH e tipo restano intatti. */}

        </div>,
        document.body,
      )}
    </>
  );
}
