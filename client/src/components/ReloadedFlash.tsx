/**
 * ReloadedFlash — «Ricaricata», una volta, dopo un reload chiesto dall'utente.
 *
 * Non disegna niente: esiste solo per avere un `useToast()` che funzioni. Come
 * `BootDeepLinkResolver`, sta DENTRO `<ToastProvider>` perché è App a
 * renderizzare il provider, e `useToast()` dentro App restituisce il no-op.
 *
 * Il segno lo lascia chi ha ricaricato (vedi `lib/reloadFlash.ts`): il monitor
 * NSEvent che intercetta ⌘R prima di xterm e delle pane browser, la voce Reload
 * del menu, `app_reload_all`, o il ramo web di `reloadAllWindows`. Qui si legge
 * e si consuma. Un reload NON chiesto — un crash del WebContent, un ricarico
 * del guscio — non lascia nessun segno e quindi non parla: il toast afferma
 * «hai premuto e ha risposto», non «la pagina è ripartita».
 *
 * `info` e non `success`: non è un'operazione riuscita di cui congratularsi, è
 * un ACK. Durata corta, perché la sola cosa che deve fare è togliere il dubbio
 * nel secondo in cui nasce.
 */
import { useEffect, useRef } from 'react';
import { useToast } from './Shared/Toast';
import { consumeReloadFlash } from '@/lib/reloadFlash';

export function ReloadedFlash() {
  const toast = useToast();
  // Il context dei toast NON è memoizzato (ToastProvider ricrea l'oggetto a
  // ogni render): metterlo fra le dipendenze rifarebbe partire l'effetto — e
  // il flag è già consumato, quindi non ne uscirebbe un doppione, ma neanche
  // un motivo per rileggere lo storage a ogni render. Stesso ref-pattern di
  // BootDeepLinkResolver.
  const toastRef = useRef(toast);
  useEffect(() => { toastRef.current = toast; });
  useEffect(() => {
    if (consumeReloadFlash()) toastRef.current.info('Ricaricata', 1800);
  }, []);
  return null;
}
