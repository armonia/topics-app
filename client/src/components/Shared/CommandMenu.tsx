import { useState, useRef } from 'react';
import { Terminal, Trash2, Cpu, Brain, ChevronDown, Check, Loader } from 'lucide-react';
import { POPOVER_SURFACE } from '@/lib/popoverStyles';
import { useDismissable } from '@/hooks/useDismissable';

interface CommandMenuProps {
  onStatus: () => void;
  onClear: () => void;
  onModel: (model: string) => void;
  onReasoning: () => void;
  isLoading?: boolean;
  currentModel?: string;
}

const AVAILABLE_MODELS = [
  { id: 'default', name: 'Default', description: 'Reset to default model' },
  { id: 'anthropic/claude-sonnet-4-20250514', name: 'Claude Sonnet 4', description: 'Fast & capable' },
  { id: 'anthropic/claude-opus-4-6', name: 'Claude Opus 4', description: 'Most powerful' },
  { id: 'openai/gpt-4o', name: 'GPT-4o', description: 'OpenAI flagship' },
  { id: 'openai/o3-mini', name: 'o3-mini', description: 'Reasoning model' },
];

export function CommandMenu({ 
  onStatus, 
  onClear, 
  onModel, 
  onReasoning, 
  isLoading,
  currentModel 
}: CommandMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Outside-pointer + Escape close via the shared useDismissable contract
  // (capture-phase pointerdown/touch + Escape, focus-restore to the trigger),
  // replacing the two hand-rolled mousedown/keydown effects. Closing also
  // collapses the nested model sub-picker, exactly as the old handlers did.
  // The dropdown is anchored inside menuRef (not portaled), so one ref covers
  // both the trigger button and the panel.
  useDismissable({
    open: isOpen,
    onClose: () => { setIsOpen(false); setShowModelPicker(false); },
    refs: [menuRef],
  });

  const handleAction = (action: () => void) => {
    action();
    setIsOpen(false);
    setShowModelPicker(false);
  };

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-7 h-7 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-tertiary hover:text-app-text-hover transition-colors app-no-drag"
        title="Commands"
      >
        {isLoading ? (
          <Loader size={14} className="animate-spin" />
        ) : (
          <Terminal size={14} />
        )}
      </button>

      {isOpen && (
        <div className={`absolute right-0 top-full mt-1 w-48 ${POPOVER_SURFACE} z-50 overflow-hidden`}>
          {/* Status */}
          <button
            onClick={() => handleAction(onStatus)}
            className="w-full px-3 py-2 text-left text-[12px] text-app-text hover:bg-app-hover flex items-center gap-2 transition-colors"
          >
            <Terminal size={14} className="text-primary" />
            <span>Status</span>
            <span className="ml-auto text-[11px] text-app-text-muted">/status</span>
          </button>

          {/* Model picker */}
          <div className="relative">
            <button
              onClick={() => setShowModelPicker(!showModelPicker)}
              className="w-full px-3 py-2 text-left text-[12px] text-app-text hover:bg-app-hover flex items-center gap-2 transition-colors"
            >
              <Cpu size={14} className="text-emerald-500 dark:text-emerald-400" />
              <span>Model</span>
              <ChevronDown size={12} className={`ml-auto text-app-text-muted transition-transform ${showModelPicker ? 'rotate-180' : ''}`} />
            </button>

            {showModelPicker && (
              <div className="border-t border-app-border bg-elevated">
                {AVAILABLE_MODELS.map((model) => (
                  <button
                    key={model.id}
                    onClick={() => handleAction(() => onModel(model.id))}
                    className="w-full px-3 py-1.5 text-left hover:bg-app-hover flex items-center gap-2 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-[11px] text-app-text truncate">{model.name}</div>
                      <div className="text-[11px] text-app-text-muted truncate">{model.description}</div>
                    </div>
                    {currentModel === model.id && (
                      <Check size={12} className="text-emerald-500 dark:text-emerald-400 flex-shrink-0" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

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
        </div>
      )}
    </div>
  );
}
