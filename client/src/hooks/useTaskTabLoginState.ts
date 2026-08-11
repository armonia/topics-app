/**
 * useTaskTabLoginState — «la preview atterra già loggata».
 *
 * Quando un agente consegna una pagina protetta, entra lui una volta nella tab
 * del task e chiama `browser_save_state({handle})`: il server lega quell'handle
 * a QUELLA tab (`server/services/task-tab-persist.ts`). Questo hook è l'altra
 * metà — chi monta la tab, drawer del task o pane promossa nel workspace del
 * progetto, batte una volta su `/api/browsers/:id/login-state/apply` e il server
 * reinietta cookie + localStorage prima che il reviewer debba fare login a mano.
 *
 * Tre scelte che vale la pena spiegare:
 *
 *  - L'HANDLE NON PARTE DA QUI. Il client dice solo «questo contesto»: il nome
 *    dell'handle lo rilegge il server dal record della tab. Se lo accettasse dal
 *    body, chiunque potrebbe iniettare una qualunque sessione salvata in un
 *    qualunque contesto.
 *  - SI ASPETTA CHE LA PANE ESISTA (`ready`). Prima della prima navigazione non
 *    c'è nessun contesto da iniettare — né quello Playwright né la WKWebView
 *    nativa — e la chiamata andrebbe a vuoto.
 *  - UNA VOLTA PER SESSIONE DELL'APP, non per mount. L'iniezione RI-NAVIGA la
 *    pagina (è così che `browser_load_state` torna dove eri, ora dentro): farla
 *    a ogni riapertura del drawer vorrebbe dire un ricaricamento a ogni sguardo.
 *    Il contesto, intanto, i cookie ce li ha già.
 */
import { useEffect } from 'react';
import { isTaskContextId } from '../state/taskBrowserTabs';

/** ContextId già serviti in questa sessione dell'app (vedi la nota sopra). */
const applied = new Set<string>();

export function useTaskTabLoginState(contextId: string, ready: boolean): void {
  useEffect(() => {
    if (!ready || !contextId || !isTaskContextId(contextId)) return;
    if (applied.has(contextId)) return;
    // Marcato PRIMA della fetch: due pane sullo stesso contextId (drawer +
    // workspace) monterebbero insieme e chiederebbero due iniezioni.
    applied.add(contextId);
    let alive = true;
    fetch(`/api/browsers/${encodeURIComponent(contextId)}/login-state/apply`, { method: 'POST' })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((body: { applied?: boolean; handle?: string | null } | null) => {
        // Rete caduta o server in errore: non era una risposta, quindi il
        // "già fatto" non vale — un mount successivo può riprovare. Un
        // `{applied:false, handle:null}` invece È una risposta ("questa tab non
        // ha nessun login salvato") e resta segnata: non si ripiomba addosso al
        // server a ogni switch di tab per farsi dire di nuovo di no.
        if (!alive) return;
        if (body === null) applied.delete(contextId);
      });
    return () => { alive = false; };
  }, [contextId, ready]);
}
