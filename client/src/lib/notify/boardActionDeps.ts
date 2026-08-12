/**
 * Il CABLAGGIO dei tasti di una notifica verso la board — la parte non pura, in
 * un posto solo.
 *
 * `runNotificationAction` è puro per costruzione: risolvere il progetto,
 * chiamare, aprire il task arrivano come parametri. Quelle tre cose però sono
 * sempre le stesse, e da quando i tasti hanno DUE superfici in pagina — il
 * banner nativo del guscio (App.tsx) e il banner in pagina della push in-app
 * (`InAppBanners`) — scriverle due volte significherebbe due copie che possono
 * divergere in silenzio: basta che una delle due dimentichi
 * `credentials: 'same-origin'` e il tasto sembra rotto solo su una superficie.
 */
import { boardApi } from '../board';
import { openTaskInApp } from '../openTaskLink';
import type { NotificationActionDeps } from './notificationAction';

export function boardNotificationDeps(): NotificationActionDeps {
  return {
    resolveProjectId: async (id) => (await boardApi.resolve(id))?.projectId ?? null,
    send: async (req) => {
      // `credentials: 'same-origin'` è load-bearing: la sessione di Topics è un
      // cookie, e senza di lui la chiamata parte anonima e il gate
      // d'autenticazione la respinge.
      const resp = await fetch(req.path, {
        method: req.method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(req.body),
      });
      return resp.ok;
    },
    openTask: (id) => openTaskInApp({ taskId: id }),
  };
}
