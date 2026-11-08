/**
 * Il banner IN PAGINA — l'alternativa alla notifica di sistema quando l'app è
 * aperta e visibile.
 *
 * Esiste perché la preferenza «ad app aperta» ha due valori e devono essere due
 * cose davvero diverse: `native` = parla il sistema operativo, `in-app` = parla
 * la pagina. Senza questa superficie il secondo valore sarebbe solo un modo
 * elaborato di dire «niente notifica».
 *
 * Chi lo alimenta è il service worker: alla push, se l'app è visibile e la
 * preferenza è `in-app`, NON mostra la notifica di sistema e manda il contenuto
 * qui (vedi `lib/push/swBridge.ts`). Una voce sola, sempre — cambia chi la fa.
 */
import { create } from 'zustand';
import type { NotifyAction } from '../../../shared/notify-actions';

export interface InAppBanner {
  id: string;
  title: string;
  body: string;
  /** Il deep-link della notifica (`/task/<id>`, `/topic/<id>`): un banner che
   *  non ti porta dove serve è metà del gesto. */
  url?: string;
  /**
   * I TASTI, gli stessi che porterebbe la notifica di sistema.
   *
   * Viaggiano fin qui perché `in-app` sceglie DOVE si legge l'avviso, non se ci
   * si può rispondere: se scegliendo il banner in pagina perdessi il quick-reply
   * che la notifica nativa ha, la preferenza costerebbe una funzione invece di
   * cambiare una superficie.
   *
   * Solo `id` e `title`: la richiesta NON viaggia fin qui. L'id codifica il
   * verbo per intero e la pagina può importare `shared/notify-actions`, quindi
   * la compone (`runNotificationAction`) — è il service worker a ricevere le
   * `requests` già pronte, perché lui non può importare niente.
   */
  actions?: NotifyAction[];
  /**
   * When this banner was shown, strictly increasing.
   *
   * It is the banner's own clock: the expiry timer is keyed on it, so a signal
   * re-shown under the same tag restarts its TTL instead of inheriting the
   * remaining life of the one it replaced (see `inAppBannerTimers.ts`).
   */
  shownAt: number;
}

/** Quanto resta in pagina. Abbastanza per leggerlo senza fermare il lavoro,
 *  poco abbastanza da non diventare una decorazione permanente. */
export const IN_APP_BANNER_TTL_MS = 8000;

/**
 * How many banners the page shows at once.
 *
 * A burst is real (`task:review-ready` and `task:parked` carry a per-task tag
 * and nothing throttles them), and without a cap the column grows until it eats
 * the window: past the fourth card nobody is reading them anyway, they are
 * covering the app. The oldest go, the newest stay.
 */
export const MAX_IN_APP_BANNERS = 4;

interface InAppBannerState {
  banners: InAppBanner[];
  showInAppBanner: (b: Omit<InAppBanner, 'id' | 'shownAt'> & { id?: string }) => void;
  dismissInAppBanner: (id: string) => void;
}

/** Two banners shown in the same millisecond still get two different clocks. */
let lastShownAt = 0;
function nextShownAt(): number {
  lastShownAt = Math.max(Date.now(), lastShownAt + 1);
  return lastShownAt;
}

export const useInAppBannerStore = create<InAppBannerState>((set) => ({
  banners: [],
  showInAppBanner: (b) => {
    // L'id è il `tag` della push quando c'è: due fine-turno dello stesso topic
    // sono UNA cosa da guardare, e la seconda deve sostituire la prima invece di
    // impilarsi — la stessa regola che il `tag` impone alle notifiche di sistema.
    const id = b.id || `banner-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    set((s) => ({
      banners: [...s.banners.filter((x) => x.id !== id), { ...b, id, shownAt: nextShownAt() }].slice(
        -MAX_IN_APP_BANNERS,
      ),
    }));
  },
  dismissInAppBanner: (id) => set((s) => ({ banners: s.banners.filter((x) => x.id !== id) })),
}));
