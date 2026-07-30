import { useEffect } from 'react';
import type { WSMessage } from '../types';
import {
  SETTINGS_SERVER_KEY,
  applyServerSettings,
  markSettingsHydrated,
  msSinceLocalSettingsChange,
} from '../lib/settings';

/** Quanto una modifica appena fatta qui ha la precedenza su un frame in volo.
 *  Stessa finestra di `useSidebarState`. */
const LOCAL_CHANGE_GRACE_MS = 2000;

/**
 * Il verso di LETTURA delle preferenze (`AppSettings`).
 *
 * `saveSettings` faceva il PUT da sempre, ma nessuno leggeva mai indietro: il
 * server accumulava una chiave `settings` che non tornava a nessuno. Bastava un
 * secondo dispositivo, un localStorage pulito o la WebView del guscio desktop
 * (che ha il suo storage) per ritrovarsi le notifiche riaccese e il font di
 * default, col valore giusto fermo sul server.
 *
 * Qui la chiave torna giù per le vie con cui il server la annuncia: la GET di
 * boot, `ui-state:init` (apertura del WS) e `ui-state:updated`, cioè il PUT a
 * chiave singola — l'unica via da cui `settings` può arrivare, visto che
 * `saveSettings` ne è l'unico scrittore. (`ui-state:patch` nasce solo dal PUT
 * bulk, che scrive chiavi del pane-store: se un giorno qualcosa scrivesse
 * `settings` in bulk, andrebbe aggiunto qui — e prima ancora alla union
 * `WSMessage`, dove `ui-state:patch` oggi non c'è.) localStorage resta la cache
 * di primo pixel: si dipinge subito col valore locale e si corregge quando
 * arriva quello del server, invece di sfarfallare partendo dai default.
 *
 * L'idratazione NON sovrascrive una modifica fatta proprio adesso: chi ha
 * appena toccato un toggle ha l'intenzione più fresca del frame in volo.
 */
export function useSettingsSync(
  onMessage?: (handler: (msg: WSMessage) => void) => () => void,
): void {
  // GET di boot. `markSettingsHydrated` va chiamata sull'ESITO — riuscito o
  // fallito — perché è anche il gate del PUT: se il server non risponde, un
  // client muto per sempre sarebbe peggio di un PUT che fallisce.
  useEffect(() => {
    let alive = true;
    fetch(`/api/ui-state/${SETTINGS_SERVER_KEY}`) // PANE-01-ALLOWED: settings key, not pane state
      .then((r): Promise<unknown> | null => (r.ok ? r.json() : null))
      .then((envelope: unknown) => {
        if (!alive) return;
        if (msSinceLocalSettingsChange() < LOCAL_CHANGE_GRACE_MS) return;
        applyServerSettings(envelope);
      })
      .catch(() => {})
      .finally(() => { if (alive) markSettingsHydrated(); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!onMessage) return;
    return onMessage((msg: WSMessage) => {
      if (msSinceLocalSettingsChange() < LOCAL_CHANGE_GRACE_MS) return;
      if (msg.type === 'ui-state:updated' && msg.key === SETTINGS_SERVER_KEY) {
        applyServerSettings(msg.value);
      } else if (msg.type === 'ui-state:init' && msg.data && SETTINGS_SERVER_KEY in msg.data) {
        applyServerSettings(msg.data[SETTINGS_SERVER_KEY]);
      }
    });
  }, [onMessage]);
}
