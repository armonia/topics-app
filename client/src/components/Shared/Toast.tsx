import { useState, useEffect, useCallback, createContext, useContext } from 'react';
import { Check, X, AlertTriangle, Info } from 'lucide-react';
import { generateUUID } from '../../utils/uuid';

type ToastType = 'success' | 'error' | 'info' | 'warning';

interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
}

interface ToastContextType {
  toast: (type: ToastType, message: string, duration?: number) => void;
  success: (message: string, duration?: number) => void;
  error: (message: string, duration?: number) => void;
  info: (message: string, duration?: number) => void;
  warning: (message: string, duration?: number) => void;
  toasts: Toast[];
  removeToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

export function useToast(): ToastContextType {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    return { toast: () => {}, success: () => {}, error: () => {}, info: () => {}, warning: () => {}, toasts: [], removeToast: () => {} };
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
      <button onClick={() => onRemove(t.id)} className="flex-shrink-0 opacity-60 hover:opacity-100 transition-opacity">
        <X size={12} />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const addToast = useCallback((type: ToastType, message: string, duration = 3000) => {
    const id = generateUUID();
    setToasts(prev => [...prev.slice(-4), { id, type, message, duration }]);
  }, []);

  const contextValue: ToastContextType = {
    toast: addToast,
    success: (msg, dur) => addToast('success', msg, dur),
    error: (msg, dur) => addToast('error', msg, dur || 5000),
    info: (msg, dur) => addToast('info', msg, dur),
    warning: (msg, dur) => addToast('warning', msg, dur || 4000),
    toasts,
    removeToast,
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
 */
export function ToastOutlet({ fixed = false }: { fixed?: boolean }) {
  const { toasts, removeToast } = useToast();
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
