import { useState, useEffect, useCallback, createContext, useContext } from 'react';
import { Check, X, AlertTriangle, Info } from 'lucide-react';
import { generateUUID } from '../../utils/uuid';

type ToastType = 'success' | 'error' | 'info' | 'warning';

/**
 * Un bottone dentro il toast — nato per l'«Annulla» dello sfissaggio.
 *
 * Un avviso che dice solo «è successo» a una cosa che l'utente non voleva
 * perdere lo lascia dov'era: sa il danno, non ha il rimedio. Il rimedio deve
 * stare nello stesso posto e nello stesso momento dell'avviso, perché è lì che
 * la mano è ancora sul gesto. Cliccandolo il toast si chiude da sé: l'azione è
 * una sola, e restare aperto suggerirebbe che se ne possa fare un'altra.
 */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
  action?: ToastAction;
}

interface ToastContextType {
  toast: (type: ToastType, message: string, duration?: number, action?: ToastAction) => void;
  success: (message: string, duration?: number, action?: ToastAction) => void;
  error: (message: string, duration?: number, action?: ToastAction) => void;
  info: (message: string, duration?: number, action?: ToastAction) => void;
  warning: (message: string, duration?: number, action?: ToastAction) => void;
  toasts: Toast[];
  removeToast: (id: string) => void;
  /** Mounted-outlet bookkeeping. Used by the root-level fallback outlet
   *  in App.tsx so we don't double-render the same toast list when a
   *  scoped outlet (e.g. ProjectWindow's) is also visible. The first
   *  non-fallback outlet to mount wins; the fallback shows up only when
   *  it has no scoped peer. */
  registerOutlet: () => () => void;
  scopedOutletCount: number;
}

const ToastContext = createContext<ToastContextType | null>(null);

// eslint-disable-next-line react-refresh/only-export-components -- idiomatic Context hook colocated with its ToastProvider/ToastOutlet components; splitting it out would fragment the toast module for no runtime benefit
export function useToast(): ToastContextType {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    return {
      toast: () => {}, success: () => {}, error: () => {}, info: () => {}, warning: () => {},
      toasts: [], removeToast: () => {},
      registerOutlet: () => () => {},
      scopedOutletCount: 0,
    };
  }
  return ctx;
}

const styles: Record<ToastType, { bg: string; icon: React.ReactNode }> = {
  success: { bg: 'bg-emerald-600', icon: <Check size={13} strokeWidth={2.5} /> },
  error:   { bg: 'bg-red-600',     icon: <X size={13} strokeWidth={2.5} /> },
  warning: { bg: 'bg-amber-500',   icon: <AlertTriangle size={13} strokeWidth={2.5} /> },
  info:    { bg: 'bg-blue-500',    icon: <Info size={13} strokeWidth={2.5} /> },
};

function ToastItem({ toast: t, onRemove }: { toast: Toast; onRemove: (id: string) => void }) {
  const [state, setState] = useState<'enter' | 'visible' | 'exit'>('enter');

  useEffect(() => {
    requestAnimationFrame(() => setState('visible'));
    const dur = t.duration || 3000;
    const exitTimer = setTimeout(() => setState('exit'), dur - 300);
    const removeTimer = setTimeout(() => onRemove(t.id), dur);
    return () => { clearTimeout(exitTimer); clearTimeout(removeTimer); };
  }, [t.id, t.duration, onRemove]);

  const { bg, icon } = styles[t.type];

  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 rounded-lg shadow-lg text-[11px] font-medium text-white transition-all duration-300 ${bg} ${
        state === 'enter' ? 'opacity-0 translate-y-2' :
        state === 'exit'  ? 'opacity-0 -translate-y-1' :
                            'opacity-100 translate-y-0'
      }`}
    >
      <span className="flex-shrink-0 opacity-90">{icon}</span>
      <span className="flex-1 min-w-0 truncate">{t.message}</span>
      {t.action && (
        <button
          data-testid="toast-action"
          onClick={() => { t.action!.onClick(); onRemove(t.id); }}
          className="flex-shrink-0 px-1.5 py-0.5 -my-0.5 rounded font-semibold underline underline-offset-2 decoration-white/40 hover:bg-white/15 transition-colors"
        >
          {t.action.label}
        </button>
      )}
      <button onClick={() => onRemove(t.id)} className="flex-shrink-0 opacity-60 hover:opacity-100 transition-opacity">
        <X size={12} />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [scopedOutletCount, setScopedOutletCount] = useState(0);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const addToast = useCallback((type: ToastType, message: string, duration = 3000, action?: ToastAction) => {
    const id = generateUUID();
    setToasts(prev => [...prev.slice(-4), { id, type, message, duration, action }]);
  }, []);

  const registerOutlet = useCallback(() => {
    setScopedOutletCount((n) => n + 1);
    return () => setScopedOutletCount((n) => Math.max(0, n - 1));
  }, []);

  const contextValue: ToastContextType = {
    toast: addToast,
    success: (msg, dur, action) => addToast('success', msg, dur, action),
    error: (msg, dur, action) => addToast('error', msg, dur || 5000, action),
    info: (msg, dur, action) => addToast('info', msg, dur, action),
    warning: (msg, dur, action) => addToast('warning', msg, dur || 4000, action),
    toasts,
    removeToast,
    registerOutlet,
    scopedOutletCount,
  };

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
    </ToastContext.Provider>
  );
}

/**
 * Renders toasts inside the nearest relative-positioned ancestor.
 * Place this inside the project container to scope toasts to that area.
 * Falls back to fixed bottom-right if used without a positioned parent.
 *
 * `fallback` outlets only render when no other (scoped) outlet is mounted —
 * use this at the root of App so global toasts (e.g. agent completion)
 * surface even when the user isn't inside a project, without
 * double-rendering when ProjectWindow's scoped outlet is also visible.
 */
export function ToastOutlet({ fixed = false, fallback = false }: { fixed?: boolean; fallback?: boolean }) {
  const { toasts, removeToast, registerOutlet, scopedOutletCount } = useToast();

  // Only scoped (= non-fallback) outlets register. The fallback then
  // checks the count and bows out if a scoped outlet is mounted.
  useEffect(() => {
    if (fallback) return;
    return registerOutlet();
  }, [fallback, registerOutlet]);

  if (fallback && scopedOutletCount > 0) return null;
  if (toasts.length === 0) return null;

  const posClass = fixed
    ? 'fixed bottom-4 right-4 z-[100] max-w-xs'
    : 'absolute bottom-3 left-3 right-3 z-50';

  return (
    <div className={`${posClass} flex flex-col gap-1.5 pointer-events-auto`}>
      {toasts.map(t => <ToastItem key={t.id} toast={t} onRemove={removeToast} />)}
    </div>
  );
}
