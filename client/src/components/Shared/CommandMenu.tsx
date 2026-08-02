import { useState, useRef } from 'react';
import { Terminal, Trash2, Brain, Loader } from 'lucide-react';
import { Menu } from './Menu';
import { NO_DRAG_REGION } from '../../lib/shell/dragRegion';

interface CommandMenuProps {
  onStatus: () => void;
  onClear: () => void;
  onReasoning: () => void;
  isLoading?: boolean;
}

// La voce «Model» viveva qui con una lista scritta a mano e ferma al 2025.
// Non era solo vecchia: era un controllo che MENTIVA. Gli id erano nella forma
// `anthropic/claude-sonnet-4-20250514`, e il guard che porta l'override sulla
// riga di comando della CLI è `/^[A-Za-z0-9._[\]-]{1,64}$/`
// (server/providers/claude-code.ts, getTopicSpawnOverridesForSession): la barra
// non ci passa. Quindi il server scriveva `topic.model`, rispondeva «Modello
// impostato: … — attivo dal prossimo turno», l'interfaccia mostrava la spunta,
// e allo spawn l'override veniva scartato in silenzio con ritorno al default.
//
// Il picker VERO è ProviderModelPicker in ChatInput: si alimenta dallo
// snapshot dei provider, quindi non invecchia, e produce `{provider, model}`
// separati — la forma che il guard accetta. Un secondo selettore, sbagliato e
// sempre visibile su desktop, non andava aggiornato: andava tolto.

export function CommandMenu({
  onStatus,
  onClear,
  onReasoning,
  isLoading,
}: CommandMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const handleAction = (action: () => void) => {
    action();
    setIsOpen(false);
  };

  return (
    <>
      <button
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)}
        className="w-7 h-7 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-tertiary hover:text-app-text-hover transition-colors app-no-drag" {...NO_DRAG_REGION}
        title="Commands"
      >
        {isLoading ? (
          <Loader size={14} className="animate-spin" />
        ) : (
          <Terminal size={14} />
        )}
      </button>

      {/* Routed through the shared Menu primitive (portal + real-measured
          computeMenuPosition + Z_POPOVER) instead of an `absolute` dropdown —
          this panel lives inside ChatPanel's `overflow-hidden`, which clipped
          it in narrow splits, especially with the model sub-picker expanded. */}
      <Menu
        open={isOpen}
        anchorRef={buttonRef}
        onClose={() => setIsOpen(false)}
        align="right"
        className="w-48 overflow-hidden"
      >
        {/* Status */}
        <button
          onClick={() => handleAction(onStatus)}
          className="w-full px-3 py-2 text-left text-[12px] text-app-text hover:bg-app-hover flex items-center gap-2 transition-colors"
        >
          <Terminal size={14} className="text-primary" />
          <span>Status</span>
          <span className="ml-auto text-[11px] text-app-text-muted">/status</span>
        </button>

        {/* Reasoning toggle */}
        <button
          onClick={() => handleAction(onReasoning)}
          className="w-full px-3 py-2 text-left text-[12px] text-app-text hover:bg-app-hover flex items-center gap-2 transition-colors"
        >
          <Brain size={14} className="text-purple-500 dark:text-purple-400" />
          <span>Reasoning</span>
          <span className="ml-auto text-[11px] text-app-text-muted">/reasoning</span>
        </button>

        <div className="h-px bg-app-border my-1" />

        {/* Clear */}
        <button
          onClick={() => handleAction(onClear)}
          className="w-full px-3 py-2 text-left text-[12px] text-red-500 dark:text-red-400 hover:bg-red-500/10 flex items-center gap-2 transition-colors"
        >
          <Trash2 size={14} />
          <span>Clear conversation</span>
          <span className="ml-auto text-[11px] text-app-text-muted">/clear</span>
        </button>
      </Menu>
    </>
  );
}
