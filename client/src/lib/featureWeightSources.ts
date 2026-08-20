/**
 * CHI DICHIARA COSA, nell'inventario del peso.
 *
 * Le registrazioni stanno tutte qui e non sparse dentro i rispettivi store, per
 * una ragione che vale piu' della vicinanza al dato: l'inventario ha senso solo
 * se e' COMPLETO. Sparso, una funzionalita' che smette di dichiararsi non fa
 * rumore da nessuna parte — semplicemente sparisce dall'elenco, e un elenco che
 * omette in silenzio e' peggio di nessun elenco, perche' chi legge crede di
 * vedere tutto. Qui invece si legge in una schermata chi c'e' e chi manca.
 *
 * LE ETICHETTE sono quelle che l'utente riconosce, non i nomi dei moduli:
 * «Le tue schede», non `pane.store`. Chi legge il recap non sa (e non deve
 * sapere) come si chiama il file che tiene quello stato.
 *
 * SULLE UNITA': tutto cio' che sta qui e' `trattenuto`, cioe' CONTEGGI. Le voci
 * `misurato` — quelle con MB veri — non nascono qui: vengono dalla flotta e
 * dalle webview, che sono processi reali, e le costruisce `featureUsage.ts`
 * dagli stessi dati che alimentano i tooltip delle tab, senza aggiungere una
 * sola lettura di sistema.
 */

import { registerFeatureWeight, roughBytes } from './featureWeight';
import { usePaneStore } from '../state/pane/store';
import { previewsCount } from '../state/topicPreviews';
import { queueCount } from '../state/chatQueue';
import { taskTabsCount } from '../state/taskBrowserTabs';
import { sitesSnapshot } from '../state/browserSiteHistory';
import { getBoardTasks } from './boardTasksStore';
import { residencyHeapReport } from '../state/pane/residency/registry';

/**
 * Registra ogni funzionalita' che trattiene stato. Ritorna la de-registrazione
 * di tutte, cosi' un test puo' montarle e smontarle senza lasciare residui.
 *
 * Da chiamare UNA volta all'avvio dell'app.
 */
export function registerFeatureWeightSources(): () => void {
  const off: (() => void)[] = [];

  // LE SCHEDE. Il numero che l'utente conta a occhio guardando la barra delle
  // tab — piu' cio' che non vede: i tombstoni (le chiusure ricordate per non
  // farle resuscitare da un altro client) e la pila dell'annulla.
  off.push(registerFeatureWeight('pane.store', 'Le tue schede', 'trattenuto', () => {
    const st = usePaneStore.getState();
    const panes = Object.values(st.panes ?? {});
    // Per tipo: «12 schede» non dice se sono dodici chat o dodici browser, e la
    // differenza e' esattamente cio' che rende cara la finestra.
    const perTipo: Record<string, number> = {};
    for (const p of panes) perTipo[p.type] = (perTipo[p.type] ?? 0) + 1;
    return {
      entries: panes.length,
      items: Object.keys(st.tombstones ?? {}).length + (st.closedStack?.length ?? 0),
      bytes: roughBytes(st),
      detail: {
        perTipo,
        tombstoni: Object.keys(st.tombstones ?? {}).length,
        daAnnullare: st.closedStack?.length ?? 0,
      },
    };
  }));

  // LE CHAT IN MEMORIA le registra `useChat`, non questo file — l'unica
  // eccezione alla regola «tutto qui», e con una ragione: quel hook conosce due
  // cose che da fuori non si vedono, i marker di compattazione e quante
  // sessioni lo spazzino ha gia' sfrattato. Senza il secondo, «3 chat» non
  // distingue «ne ho aperte tre» da «ne ho aperte cento e novantasette sono
  // state restituite», che e' la differenza fra un accumulo e un ciclo sano.
  //
  // Il rischio della doppia registrazione non si corre: l'id e' lo stesso
  // (`chat.messages`) e il registro SOSTITUISCE invece di accumulare.

  // I TASK DELLA KANBAN. Nessuna tab, nessun processo: pesano e basta.
  off.push(registerFeatureWeight('board.tasks', 'Task della board', 'trattenuto', () => {
    const tasks = getBoardTasks();
    return { entries: tasks.length, bytes: roughBytes(tasks) };
  }));

  // LE ANTEPRIME. Hanno un tetto dichiarato: si mostra anche quanto ci si e'
  // vicini, perche' «198 su 200» e' un'informazione diversa da «198».
  off.push(registerFeatureWeight('topic.previews', 'Anteprime dei topic', 'trattenuto', () => {
    const c = previewsCount();
    return { entries: c.entries, detail: { tetto: c.max } };
  }));

  // LA CODA DEI TURNI. Quasi sempre vuota, quindi quasi sempre assente
  // dall'elenco — ed e' giusto cosi': quando c'e', vuol dire che qualcosa non
  // sta partendo, e allora la riga si nota.
  off.push(registerFeatureWeight('chat.queue', 'Turni in coda', 'trattenuto', () => {
    const c = queueCount();
    return { entries: c.entries, items: c.items };
  }));

  // LE TAB DEI TASK, comprese quelle PARCHEGGIATE — trattenute senza essere
  // visibili da nessuna parte, che e' il caso per cui questo inventario esiste.
  off.push(registerFeatureWeight('task.browserTabs', 'Tab dei task', 'trattenuto', () => {
    const c = taskTabsCount();
    return { entries: c.entries, items: c.items, detail: { parcheggiate: c.parked } };
  }));

  // LA CRONOLOGIA DEI SITI, che cresce da sola a ogni navigazione.
  off.push(registerFeatureWeight('browser.siteHistory', 'Cronologia dei siti', 'trattenuto', () => {
    const s = sitesSnapshot();
    return { entries: s.length, bytes: roughBytes(s) };
  }));

  // CHI E' MONTATO ADESSO. Non e' stato accumulato, e' la fotografia del tetto
  // di residenza: quante pane sono vive contro quante ne sono state aperte.
  off.push(registerFeatureWeight('pane.residency', 'Schede montate adesso', 'trattenuto', () => {
    const r = residencyHeapReport();
    return { entries: r.entries, items: r.items, detail: r.detail };
  }));

  return () => { for (const f of off) f(); };
}
