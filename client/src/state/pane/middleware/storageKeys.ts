/**
 * Le chiavi di localStorage dello store delle pane, e il motivo per cui stanno
 * in un file loro.
 *
 * `persistLocal.ts` le SCRIVE; `syncCrossTab.ts` le legge dall'evento `storage`
 * per capire se la notifica che gli è arrivata riguarda lo store o qualcos'
 * altro. Finché la costante viveva dentro `persistLocal`, quel bisogno si
 * pagava con un import — e siccome `persistLocal` importa a sua volta
 * `getTabId` da `syncCrossTab`, i due moduli si chiudevano in cerchio:
 *
 *     syncCrossTab.ts → persistLocal.ts → syncCrossTab.ts
 *
 * A runtime oggi non esplode, perché entrambi usano l'altro solo dentro una
 * funzione. Ma qui il pezzo importato è una `const` inizializzata al
 * caricamento, cioè proprio la forma che in un ciclo può essere letta prima di
 * esistere: basta che un domani `PANE_STORE_LOCAL_KEY` finisca in un'
 * espressione a livello di modulo perché diventi `undefined` — e un confronto
 * `e.key !== undefined` non fallisce rumorosamente, semplicemente scarta OGNI
 * notifica cross-tab. Un difetto muto, in un percorso che si accorge di
 * esistere solo con due schede aperte.
 *
 * Una chiave non è comportamento: è un nome su cui due moduli devono essere
 * d'accordo. Questo è il posto in cui un accordo del genere si scrive.
 */

/** Snapshot completo dello store (panes/groups/closedStack). */
export const PANE_STORE_LOCAL_KEY = 'pane-store-v2';
