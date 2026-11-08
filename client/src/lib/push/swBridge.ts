/**
 * Il canale service worker → pagina per il banner IN PAGINA.
 *
 * Gemello di `subscribeServiceWorkerTaskOpen` (openTaskLink.ts), che porta il
 * CLICK su una notifica di sistema. Qui viaggia il caso opposto: la notifica di
 * sistema non c'è, perché il dispositivo ha scelto `in-app` e la finestra è
 * visibile — quindi il contenuto arriva alla pagina, che lo disegna.
 */
import { useInAppBannerStore } from '../../state/inAppBanner';
import type { NotifyAction } from '../../../../shared/notify-actions';

/** Deve combaciare con `PUSH_BANNER_MESSAGE` in `client/public/sw.js`. */
export const SW_PUSH_BANNER_MESSAGE = 'topics:push-banner';

interface SwBannerMessage {
  type?: string;
  title?: string;
  body?: string;
  url?: string;
  tag?: string;
  actions?: NotifyAction[];
}

export function subscribeServiceWorkerBanner(): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {};
  const handler = (ev: MessageEvent) => {
    const data = ev.data as SwBannerMessage | null;
    if (!data || data.type !== SW_PUSH_BANNER_MESSAGE) return;
    useInAppBannerStore.getState().showInAppBanner({
      // Il `tag` della push diventa l'id del banner: due fine-turno dello stesso
      // topic si sostituiscono invece di impilarsi, come farebbero le notifiche
      // di sistema con lo stesso tag.
      id: data.tag,
      title: data.title || 'Topics',
      body: data.body || '',
      url: data.url,
      // I tasti arrivano dallo stesso payload della push: il worker li ha solo
      // inoltrati, non ricomposti (vedi `deliverPush` in client/public/sw.js).
      actions: Array.isArray(data.actions) ? data.actions : undefined,
    });
  };
  navigator.serviceWorker.addEventListener('message', handler);
  return () => navigator.serviceWorker.removeEventListener('message', handler);
}
