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
import { useEffect } from 'react';
import { useToast } from './Shared/Toast';
import { consumeReloadFlash } from '@/lib/reloadFlash';

export function ReloadedFlash() {
  // `toast` è una dipendenza normale dell'effetto. Qui c'era uno specchio in un
  // ref perché il valore del context si ricostruiva a ogni render di App, e
  // metterlo fra le dipendenze avrebbe rifatto partire l'effetto a ogni giro.
  // Ora l'API dei toast vive in un context suo (`ToastApiContext`) la cui
  // identità non cambia mai dopo il mount, quindi l'effetto parte una volta
  // sola perché la dipendenza è davvero stabile — non perché gliel'abbiamo
  // nascosta. Stesso taglio già fatto in BootDeepLinkResolver.
  const toast = useToast();
  useEffect(() => {
    if (consumeReloadFlash()) toast.info('Ricaricata', 1800);
  }, [toast]);
  return null;
}
