/**
 * useCopyTabLink — «Copia link» detto allo stesso modo da OGNI superficie.
 *
 * Le voci che copiano il permalink di una tab sono tre (il menu contestuale
 * della tab, quello del topic in sidebar, la palette ⌘K) e nel repo vale la
 * regola che due superfici non possono dire cose diverse sullo stesso soggetto.
 * Qui stanno quindi in un posto solo: la costruzione del link, la copia e le
 * parole del feedback. Un call-site nuovo eredita tutto e non riscrive niente.
 *
 * Il feedback è un TOAST, non lo swap dell'icona alla TaskDetail: queste voci
 * vivono dentro un menu che si chiude al click, quindi un «copiato ✓» sul
 * bottone non si vedrebbe mai.
 *
 * La copia passa da `lib/clipboard.copyText`, che è l'unica porta che regge un
 * `navigator.clipboard` assente (fuori dai secure context è `undefined`, e
 * chiamarlo TIRA invece di rifiutare la promise): l'esito è un boolean, così il
 * toast dice «copiato» solo quando è vero.
 */
import { useCallback, useMemo } from 'react';
import { useToast } from '../components/Shared/Toast';
import { useRefMirror } from './useRefMirror';
import { copyText } from '../lib/clipboard';
import { buildTabLinkForTarget } from '../lib/tabLink';
import type { TabTarget } from '../../../shared/tab-link';

/** Copiato: il permalink di una tab. */
export const TAB_LINK_COPIED = 'Link copiato';
/** Copiato: la URL della pagina aperta in una pane browser. */
export const PAGE_URL_COPIED = 'URL copiato';
/** La clipboard non c'è o l'ha negata il browser (HTTP in LAN, webview). */
export const COPY_FAILED = 'Copia non riuscita';
/** Il target non è indirizzabile: non dovrebbe accadere (ogni voce è gated sul
 *  `null` di `tabTargetForPane`), ma un link a metà non va copiato in silenzio. */
export const LINK_UNAVAILABLE = 'Questa tab non ha un link';

export interface CopyTabLink {
  /** Costruisce il permalink del target e lo copia. */
  copyTabLink: (target: TabTarget | null | undefined) => Promise<void>;
  /** Copia una URL già pronta (la pagina di una pane browser). */
  copyUrl: (url: string | null | undefined) => Promise<void>;
}

export function useCopyTabLink(): CopyTabLink {
  // Il valore del context dei toast NON è memoizzato: `ToastProvider` ricrea
  // l'oggetto a ogni render di App, quindi metterlo nelle dipendenze darebbe a
  // queste funzioni un'identità nuova ogni giro — e chi le mette in un
  // `useMemo` (la palette) ricalcolerebbe per niente. Lo specchiamo in un ref,
  // che è stabile, e leggiamo l'ultimo valore al momento del click.
  const toast = useRefMirror(useToast());

  const copyTabLink = useCallback(async (target: TabTarget | null | undefined) => {
    const link = target ? buildTabLinkForTarget(target) : null;
    if (!link) { toast.current.warning(LINK_UNAVAILABLE); return; }
    if (await copyText(link)) toast.current.success(TAB_LINK_COPIED);
    else toast.current.warning(COPY_FAILED);
  }, [toast]);

  const copyUrl = useCallback(async (url: string | null | undefined) => {
    if (!url) { toast.current.warning(LINK_UNAVAILABLE); return; }
    if (await copyText(url)) toast.current.success(PAGE_URL_COPIED);
    else toast.current.warning(COPY_FAILED);
  }, [toast]);

  return useMemo(() => ({ copyTabLink, copyUrl }), [copyTabLink, copyUrl]);
}
