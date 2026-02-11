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
}

const ToastContext = createContext<ToastContextType | null>(null);

export function useToast(): ToastContextType {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Return a no-op version if not in provider
    return {
      toast: () => {},
      success: () => {},
      error: () => {},
      info: () => {},
      warning: () => {},
    };
  }
  return ctx;
}

const iconMap = {
  success: <Check size={14} className="text-emerald-500" />,
  error: <X size={14} className="text-red-500" />,
  warning: <AlertTriangle size={14} className="text-amber-500" />,
  info: <Info size={14} className="text-blue-500" />,
};

const bgMap = {
  success: 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800/40',
  error: 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800/40',
  warning: 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800/40',
  info: 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800/40',
};

function ToastItem({ toast, onRemove }: { toast: Toast; onRemove: (id: string) => void }) {
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    const dur = toast.duration || 3000;
    const exitTimer = setTimeout(() => setExiting(true), dur - 300);
    const removeTimer = setTimeout(() => onRemove(toast.id), dur);
    return () => {
      clearTimeout(exitTimer);
      clearTimeout(removeTimer);
    };
  }, [toast.id, toast.duration, onRemove]);

  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 rounded-lg border shadow-lg text-[12px] transition-all duration-300 ${bgMap[toast.type]} ${
        exiting ? 'opacity-0 translate-x-4' : 'opacity-100 translate-x-0'
      }`}
    >
      {iconMap[toast.type]}
      <span className="text-[#333] dark:text-[#ddd] font-medium">{toast.message}</span>
      <button
        onClick={() => onRemove(toast.id)}
        className="ml-auto w-4 h-4 flex items-center justify-center text-[#999] hover:text-[#555] dark:hover:text-[#ccc]"
      >
        <X size={10} />
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
    setToasts(prev => [...prev.slice(-4), { id, type, message, duration }]); // max 5 toasts
  }, []);

  const contextValue: ToastContextType = {
    toast: addToast,
    success: (msg, dur) => addToast('success', msg, dur),
    error: (msg, dur) => addToast('error', msg, dur || 5000),
    info: (msg, dur) => addToast('info', msg, dur),
    warning: (msg, dur) => addToast('warning', msg, dur || 4000),
  };

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      {/* Toast container */}
      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-auto">
          {toasts.map(t => (
            <ToastItem key={t.id} toast={t} onRemove={removeToast} />
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}
