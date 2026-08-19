import type { PaneType } from '../state/pane/types';

/**
 * Background tier of a layout CELL hosting a content pane (GroupLayout and
 * StandaloneChatGroup keep-alive wrappers — one decision, two call sites).
 *
 * Three tiers under the mac vibrancy shell:
 * - '' (fully transparent): `project` and `terminal` — they paint their own
 *   chrome and frost themselves;
 * - `pane-frost`: chat topics + kanban + browser — frosted tier (transparent
 *   under `.electron-mac`, opaque `bg-surface` fallback on the web; see
 *   index.css);
 * - `bg-surface`: every other pane keeps the opaque content backdrop that
 *   keeps dense text crisp (dashboard tables, file trees, session viewers).
 *
 * IL BROWSER STA NEL LIVELLO SMERIGLIATO, E LO DICE IL TIPO.
 *
 * La cella di una pane browser non ha testo denso da tenere nitido: sotto la
 * toolbar c'e' una webview NATIVA, che dipinge il suo fondo opaco per conto
 * suo (`NativeBrowserPlaceholder`). L'unica parte di quella cella che si vede
 * davvero e' la STRISCIA DI CHROME in cima — la barra delle tab e la toolbar
 * dell'indirizzo, entrambe senza fondo proprio — quindi il fondo che prende la
 * cella E' il fondo che si legge sotto le tab e la toolbar.
 *
 * Era gia' l'intenzione, ma la diceva una regola CSS che guardava la FORMA DEL
 * DOM invece del tipo: `html.electron-mac :has(> [data-testid="browser-native-panel"])`
 * pretendeva il pannello come figlio DIRETTO della cella. Dove un chiamante
 * interpone un div — le tab browser di una task sulla board — la regola non
 * agganciava, la cella restava `bg-surface` opaca, e la stessa pane usciva di
 * due tinte diverse a seconda di CHI la montava. E' la deriva gia' pagata due
 * volte da questa famiglia (la barra del progetto contro quella di primo
 * livello): la tinta di una superficie non deve dipendere da dove sta
 * nell'albero. Qui la decide il tipo, come per chat, kanban e terminale, e
 * nessun wrapper la puo' piu' cambiare.
 */
export function paneCellBg(type: PaneType): string {
  if (type === 'project' || type === 'terminal') return '';
  if (type === 'chat' || type === 'kanban' || type === 'board' || type === 'browser') return 'pane-frost';
  return 'bg-surface';
}

/**
 * CHI PASSA SOTTO LA BARRA DELLE TAB E CHI NO.
 *
 * Da quando la barra è un vetro fuori dal flusso (`.pane-chrome-bar`,
 * index.css), la cella di una pane comincia in cima alla card — cioè DIETRO la
 * barra. Per la conversazione è esattamente ciò che si vuole: i messaggi le
 * scorrono sotto e il varco in cima lo mette la lista (l'`Header` di Virtuoso
 * in MessageList), così a riposo non c'è niente di nascosto e in movimento
 * c'è la profondità.
 *
 * ATTENZIONE, e l'ho scoperto misurando: «la chat» non è solo il trascritto.
 * Sopra di lui, nella stessa colonna, ci stanno dei blocchi che compaiono e
 * spariscono — il banner «collego questo progetto?», l'esito di un comando, i
 * messaggi appuntati, e sul telefono la striscia di attività della sessione.
 * Lasciando la cella senza rientro finivano DIETRO il vetro: un banner che
 * chiede una cosa e non si vede è peggio di un banner che non c'è.
 *
 * Quindi il rientro ce l'hanno TUTTE le celle, chat compresa, e a passare sotto
 * la barra è il solo trascritto — che se lo riprende con un margine negativo, e
 * solo quando è davvero lui il primo della colonna (`.chat-under-chrome`,
 * index.css). Se sopra di lui c'è un banner, il varco vale zero e il rientro
 * della cella fa già il suo lavoro: nessuno dei due conta due volte.
 *
 * Per tutte le altre pane il rientro basta e avanza, e non è prudenza: è che
 * non potrebbero passare sotto nemmeno volendo.
 *
 *  · **terminale** — xterm è una griglia di righe misurata sul contenitore. Non
 *    esiste un «contenuto scrollato» a cui aggiungere un varco: ogni riga che
 *    finisce sotto la barra è una riga persa, e la prima è quella che stai
 *    scrivendo.
 *  · **browser** — sulla shell Tauri la pane è una WKWebView NATIVA, disegnata
 *    SOPRA tutto il DOM. Lì «passare sotto» si inverte: sarebbe la barra a
 *    sparire dietro la webview. È l'unico caso in cui il difetto non è estetico.
 *  · **tabelle e alberi densi** (dashboard, file, sessioni) — hanno la loro
 *    intestazione sticky in cima. Due intestazioni sovrapposte non sono un
 *    effetto, sono un pasticcio.
 *
 * Il rientro è espresso in `var(--chrome-bar-h)` e non in un `pt-10` scritto a
 * mano: l'altezza la dichiara UNA volta la card che possiede la barra, e la
 * stessa variabile la legge anche il varco della chat. Un numero solo, due
 * lettori — se la riga di chrome cambia altezza, si muovono insieme.
 */
export function paneCellTopInset(_type: PaneType): string {
  return 'pt-[var(--chrome-bar-h,0px)]';
}
