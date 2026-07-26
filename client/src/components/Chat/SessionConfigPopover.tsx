// SessionConfigPopover — the per-chat knobs you actually want to change MID
// conversation, in one place, reachable from the composer.
//
// Before this they were scattered and half-hidden:
//   - EFFORT lived inside the provider/model popover, below a provider search
//     field, behind a trigger labelled "Provider & model". The composer showed
//     the current tier only as a non-clickable badge, so "change the effort"
//     meant opening a menu about something else.
//   - AUTONOMIA (the permission mode — the single most conversational setting
//     there is: "stop asking me" / "ask me again") was reachable ONLY from the
//     topic settings modal, itself only reachable from a tab right-click.
//
// Both are per-topic server state: effort goes through the existing
// onEffortChange funnel (which respawns an idle CLI), autonomyLevel through
// onUpdateTopic. Nothing new is invented here — this is the missing surface for
// state the composer already had in scope.
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SlidersHorizontal, RotateCcw } from 'lucide-react';
import { useDismissable } from '@/hooks/useDismissable';
import { POPOVER_PANEL, POPOVER_MARGIN, Z_POPOVER } from '@/lib/popoverStyles';
import type { AutonomyLevel, Topic, UpdateTopicRequest } from '@/types';

const EFFORT_TIERS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

const AUTONOMY: { value: AutonomyLevel; label: string; desc: string }[] = [
  { value: 'ask', label: 'Chiedi', desc: 'Approvi ogni azione' },
  { value: 'auto-apply', label: 'Applica', desc: 'Applica e mostra' },
  { value: 'yolo', label: 'Autonomo', desc: 'Minimo feedback' },
];

/** Own width — lets the horizontal clamp work without a measure pass. */
const PANEL_W = 260;

interface SessionConfigPopoverProps {
  topic: Topic;
  /** Per-topic effort override; null = provider default. */
  effort: string | null;
  onEffortChange?: (effort: string | null) => void;
  /** Absent when the active provider exposes no effort tiers. */
  effortSupported: boolean;
  onUpdateTopic?: (id: string, data: UpdateTopicRequest) => Promise<Topic | null>;
}

export function SessionConfigPopover({
  topic,
  effort,
  onEffortChange,
  effortSupported,
  onUpdateTopic,
}: SessionConfigPopoverProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useDismissable({ open, onClose: () => setOpen(false), refs: [panelRef, btnRef] });

  const autonomy: AutonomyLevel = topic.autonomyLevel ?? 'ask';
  // With neither knob available there is nothing to show — stay invisible
  // rather than offer an empty panel.
  if (!effortSupported && !onUpdateTopic) return null;

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
        className={`flex-shrink-0 p-1.5 rounded-md transition-colors ${
          open ? 'bg-app-hover text-app-text' : 'text-app-text-muted hover:bg-app-hover hover:text-app-text'
        }`}
        title="Configurazione della chat — effort e autonomia"
        aria-label="Configurazione della chat"
        aria-expanded={open}
        data-testid="chat-session-config"
      >
        <SlidersHorizontal size={16} />
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
                    title="Torna al default del provider"
                  >
                    <RotateCcw size={10} />
                    Default
                  </button>
                )}
              </div>
              <div className="flex rounded-md border border-app-border overflow-hidden">
                {EFFORT_TIERS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => onEffortChange(t)}
                    className={`flex-1 px-1 py-1 text-[10px] uppercase tracking-wide transition-colors ${
                      effort === t
                        ? 'bg-primary text-white'
                        : 'text-app-text-secondary hover:bg-app-hover'
                    }`}
                    data-testid={`session-effort-${t}`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          )}

          {onUpdateTopic && (
            <div>
              <span className="block mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-app-text-tertiary">
                Autonomia
              </span>
              <div className="flex rounded-md border border-app-border overflow-hidden">
                {AUTONOMY.map(({ value, label, desc }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => { void onUpdateTopic(topic.id, { autonomyLevel: value }); }}
                    className={`flex-1 px-1 py-1.5 text-center transition-colors ${
                      autonomy === value
                        ? 'bg-primary text-white'
                        : 'text-app-text-secondary hover:bg-app-hover'
                    }`}
                    title={desc}
                    data-testid={`session-autonomy-${value}`}
                  >
                    <span className="block text-[11px] font-medium">{label}</span>
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[10px] leading-snug text-app-text-muted">
                {AUTONOMY.find((a) => a.value === autonomy)?.desc}
              </p>
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
