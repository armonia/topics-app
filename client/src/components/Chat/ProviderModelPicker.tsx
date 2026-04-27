import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, Settings, Zap, X } from 'lucide-react';
import type { ProviderDiagnostic, ProviderModels, ProviderStatus } from '../../types';
import { providersApi } from '../../lib/api';

const STATUS_DOT: Record<ProviderStatus, string> = {
  ready: 'bg-green-500',
  loading: 'bg-yellow-500',
  error: 'bg-red-500',
  unavailable: 'bg-gray-400',
};

const PROVIDER_LABELS: Record<string, string> = {
  openclaw: 'OpenClaw',
  claude: 'Claude (API)',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  openai: 'OpenAI (ChatGPT)',
};

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
}

export function ProviderModelPicker({ override, defaultProviderLabel, onChange, onOpenSettings }: Props) {
  const [open, setOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState<ProviderDiagnostic[]>([]);
  const [models, setModels] = useState<Record<string, string[]>>({});
  const [search, setSearch] = useState('');
  const btnRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Fetch on open
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    Promise.all([
      providersApi.diagnoseAll(),
      providersApi.listModels(),
    ]).then(([d, m]) => {
      if (cancelled) return;
      setDiagnostics(d.providers ?? []);
      const map: Record<string, string[]> = {};
      for (const entry of (m.providers ?? []) as ProviderModels[]) {
        map[entry.provider] = entry.models;
      }
      setModels(map);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [open]);

  // Outside click + Escape
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popoverRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); e.stopPropagation(); }
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const buttonLabel = useMemo(() => {
    if (override) {
      const provLabel = PROVIDER_LABELS[override.provider] ?? override.provider;
      return `${provLabel} · ${override.model}`;
    }
    return defaultProviderLabel ?? 'Default';
  }, [override, defaultProviderLabel]);

  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    return diagnostics.map((d) => {
      const provLabel = PROVIDER_LABELS[d.name] ?? d.name;
      const provModels = models[d.name] ?? [];
      const matchesProv = !q || provLabel.toLowerCase().includes(q);
      const matchedModels = q
        ? provModels.filter((m) => m.toLowerCase().includes(q))
        : provModels;
      const visibleModels = matchesProv ? provModels : matchedModels;
      return { diag: d, label: provLabel, models: visibleModels, hasMatch: matchesProv || matchedModels.length > 0 };
    }).filter((g) => g.hasMatch);
  }, [diagnostics, models, search]);

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

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(!open)}
        data-testid="provider-model-picker"
        className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium border transition-colors ${
          override
            ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15'
            : 'border-app-border bg-app-hover/40 text-app-text-secondary hover:bg-app-hover'
        }`}
        title="Provider & model"
      >
        <Zap size={11} />
        <span className="max-w-[160px] truncate">{buttonLabel}</span>
      </button>

      {open && popoverPos && createPortal(
        <div
          ref={popoverRef}
          className="bg-surface border border-app-border rounded-lg shadow-xl w-[320px] max-h-[70vh] flex flex-col overflow-hidden"
          style={{
            position: 'fixed',
            bottom: popoverPos.bottom,
            left: popoverPos.left,
            zIndex: 9999,
          }}
        >
          {/* Header — search */}
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
            {search && (
              <button onClick={() => setSearch('')} className="text-app-text-muted hover:text-app-text">
                <X size={11} />
              </button>
            )}
          </div>

          {/* Provider/model groups */}
          <div className="overflow-y-auto flex-1 py-1">
            {filteredGroups.length === 0 && (
              <div className="px-3 py-4 text-[11px] text-app-text-muted text-center">No matches.</div>
            )}
            {filteredGroups.map(({ diag, label, models: provModels }) => (
              <div key={diag.name} className="py-0.5">
                <div className="flex items-center gap-1.5 px-2.5 py-1">
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_DOT[diag.status]}`} />
                  <span className="text-[11px] font-semibold text-app-text">{label}</span>
                  <span className="text-[10px] text-app-text-muted">{diag.status}</span>
                  {diag.isDefault && (
                    <span className="ml-auto text-[9px] bg-primary/20 text-primary px-1 rounded">Default</span>
                  )}
                </div>
                {diag.status !== 'ready' && diag.requirements.some((r) => !r.present) && (
                  <div className="px-5 pb-1 text-[10px] text-app-text-muted italic">
                    Configure in Settings
                  </div>
                )}
                {provModels.map((m) => {
                  const isSelected = override?.provider === diag.name && override?.model === m;
                  const disabled = diag.status !== 'ready';
                  return (
                    <button
                      key={`${diag.name}:${m}`}
                      onClick={() => !disabled && select(diag.name, m)}
                      disabled={disabled}
                      className={`w-full flex items-center gap-2 px-5 py-1 text-left text-[11px] transition-colors ${
                        isSelected
                          ? 'bg-primary/15 text-primary font-medium'
                          : disabled
                          ? 'text-app-text-muted cursor-not-allowed opacity-50'
                          : 'text-app-text-secondary hover:bg-app-hover'
                      }`}
                    >
                      <span className="font-mono">{m}</span>
                      {isSelected && <span className="ml-auto text-[10px]">✓</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {/* Footer */}
          <div className="px-2.5 py-2 border-t border-app-border flex items-center justify-between gap-2">
            <div className="text-[10px] text-app-text-muted truncate">
              {override
                ? <button onClick={clearOverride} className="hover:text-app-text underline">Reset to default</button>
                : `Default: ${defaultProviderLabel ?? '—'}`}
            </div>
            {onOpenSettings && (
              <button
                onClick={() => { onOpenSettings(); setOpen(false); }}
                className="flex items-center gap-1 text-[10px] text-app-text-muted hover:text-app-text"
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
