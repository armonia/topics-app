import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { ConfirmDialog } from '../components/Shared/ConfirmDialog';
import { ConfirmInsidePopoverContext } from './confirmInsidePopover';

/**
 * useConfirm — un `window.confirm` che NON blocca il thread.
 *
 * `window.confirm` è un dialog modale nativo: in una WKWebView congela l'intera
 * webview finché non lo chiudi a mano — chat in streaming, terminali e pane
 * accanto restano fermi in ostaggio. Questo hook restituisce la stessa forma
 * sincrona-apparente (`if (!await confirm(...)) return;`) ma dietro c'è il
 * ConfirmDialog React: un solo turno di event loop, niente thread congelato.
 *
 * La Promise si risolve `true` sul tasto di conferma, `false` su annulla /
 * Escape / click sul velo. Un solo dialog alla volta per provider.
 */
export interface ConfirmOptions {
  title: string;
  /** Corpo del dialog: testo semplice o markup (nomi in mono, diff, elenchi). */
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 'danger' (default) = tasto rosso. */
  tone?: 'danger' | 'default';
  /** Set by `useConfirm` itself inside a popover that keeps its questions (the
   *  user menu, `ConfirmInsidePopoverContext`): the dialog leaves the popover
   *  open. Callers do not write it. */
  insidePopover?: boolean;
}

export type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

// eslint-disable-next-line react-refresh/only-export-components -- hook idiomatico colocato col suo ConfirmProvider; separarlo frammenterebbe il modulo senza vantaggio a runtime
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  const insidePopover = useContext(ConfirmInsidePopoverContext);
  const ask = useCallback<ConfirmFn>(
    (opts) => (ctx ? ctx(insidePopover ? { ...opts, insidePopover } : opts) : Promise.resolve(true)),
    [ctx, insidePopover],
  );
  // Fuori dal provider (test isolati) non c'è dialog da mostrare: si procede.
  return ask;
}

interface Pending {
  opts: ConfirmOptions;
  resolve: (value: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => setPending({ opts, resolve }));
  }, []);

  const settle = useCallback((value: boolean) => {
    setPending((p) => {
      p?.resolve(value);
      return null;
    });
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <ConfirmDialog
          title={pending.opts.title}
          confirmLabel={pending.opts.confirmLabel}
          cancelLabel={pending.opts.cancelLabel}
          tone={pending.opts.tone}
          insidePopover={pending.opts.insidePopover}
          onConfirm={() => settle(true)}
          onCancel={() => settle(false)}
        >
          {pending.opts.body}
        </ConfirmDialog>
      )}
    </ConfirmContext.Provider>
  );
}
