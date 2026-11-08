/**
 * Il censimento delle sessioni orfane: chi SAREBBE candidata al parcheggio.
 *
 * L'ordine dei passi non era burocrazia. «Nessuna interfaccia la referenzia» è
 * un giudizio che attraversa quattro strutture diverse di `ui_state`, e se
 * sbaglia in un caso solo chi agisce su quel giudizio spegne una sessione che
 * qualcuno stava usando — quindi lo si è guardato girare in SOLA LETTURA prima
 * di collegarci qualcosa. Sessantotto giri fra il 04/08 e il 10/08 non hanno mai
 * nominato una sessione (mai più di una viva alla volta, però: prova pulita ma
 * sottile, ed è il motivo per cui il cancello dei due avvistamenti in
 * `lib/orphan-park-policy.ts` non è un lusso). Da lì l'azione è collegata, ed è
 * il PARCHEGGIO e non la cancellazione: un falso positivo su un parcheggio costa
 * un click, su una `DELETE` una conversazione.
 *
 * Questo modulo resta senza effetti: CONTA e riferisce. Chi agisce è server.ts,
 * e decide con la regola pura. La decisione «è orfana?» vive in
 * `lib/orphan-sessions.ts`, pura e testata; qui c'è solo la raccolta, e l'unica
 * cosa che vale la pena provare è l'UNIONE fra righe — una sessione può essere
 * referenziata da UNA sola delle chiavi di `ui_state` (tipicamente un
 * `topics-project-panes-*`), e guardarne una alla volta la farebbe risultare
 * orfana.
 */

import {
  scanOrphanSessions,
  referencedSessionIdsIn,
  type OrphanScanResult,
} from "../lib/orphan-sessions";
import { planOrphanPark, formatOrphanParkPlan } from "../lib/orphan-park-policy";

export interface CensusSession {
  id: string;
  attached: boolean;
  isSubAgent: boolean;
}

export interface CensusDeps {
  /** Le sessioni vive del roster del server. */
  listSessions(): readonly CensusSession[];
  /** I valori GREZZI di tutte le righe di `ui_state`, in qualunque forma. */
  listUiStateValues(): readonly string[];
}

export interface CensusResult extends OrphanScanResult {
  /**
   * Quante righe di `ui_state` sono state lette.
   *
   * Serve a chi agisce, e serve parecchio: zero righe NON vuol dire «nessuna
   * interfaccia le mostra», vuol dire «non ho guardato» — e senza distinguere
   * le due cose un database vuoto o su un percorso sbagliato manderebbe a
   * dormire ogni sessione della macchina. Il cancello sta in
   * `lib/orphan-park-policy.ts`; questo è il numero su cui si chiude.
   */
  uiStateRows: number;
}

/**
 * Guarda e riferisce. Nessun effetto, per costruzione: non prende niente con cui
 * potrebbe agire.
 */
export function censusOnce(deps: CensusDeps): CensusResult {
  const sessions = deps.listSessions();
  // L'unione su TUTTE le righe, non riga per riga: una pane di terminale può
  // vivere in un `project-layout-*` senza comparire nel pane store globale.
  const referencedIds = new Set<string>();
  const values = deps.listUiStateValues();
  for (const value of values) {
    for (const id of referencedSessionIdsIn(value)) referencedIds.add(id);
  }
  const scan = scanOrphanSessions({
    liveSessionIds: sessions.map((s) => s.id),
    referencedIds,
    attachedIds: new Set(sessions.filter((s) => s.attached).map((s) => s.id)),
    subAgentIds: new Set(sessions.filter((s) => s.isSubAgent).map((s) => s.id)),
  });
  return { ...scan, uiStateRows: values.length };
}

/**
 * La riga di log.
 *
 * Nomina gli id delle candidate perché il senso del censimento è poterle
 * riconoscere: «due orfane» non permette a nessuno di dire «quella la stavo
 * usando». E riporta i motivi dei risparmi più le righe di `ui_state` lette,
 * così un censimento a zero candidate si distingue da un censimento che non ha
 * guardato niente.
 */
export function formatCensus(r: CensusResult): string {
  const spared = Object.entries(r.sparedReasons)
    .map(([why, n]) => `${n} ${why}`)
    .join(", ");
  const head = `[orphan-census] ${r.examined} sessioni esaminate su ${r.uiStateRows} righe di ui_state, ${r.orphans.length} candidate al parcheggio`;
  const who = r.orphans.length ? ` → ${r.orphans.join(", ")}` : "";
  return `${head}${who}${spared ? ` · risparmiate: ${spared}` : ""}`;
}

export interface CensusRunnerDeps extends CensusDeps {
  /**
   * Parcheggia. Iniettato, e non importato: così questo modulo resta una cosa
   * che si può far girare in un test senza una PTY, un bridge o un database, e
   * il test vede ESATTAMENTE la catena che gira in produzione.
   */
  park(ids: readonly string[]): void;
  /** Interruttore generale (`TOPICS_ORPHAN_PARK`). */
  enabled: boolean;
  log?: (msg: string) => void;
}

/**
 * La catena completa: censisci → decidi → parcheggia. Restituisce la funzione da
 * chiamare a ogni giro; la memoria del giro precedente vive qui dentro.
 *
 * STA IN UN SERVIZIO E NON INLINE IN server.ts per la stessa ragione di
 * `lib/session-parking.ts`: l'anello fra il giudizio e l'azione è il posto dove
 * una regressione può tornare senza che nessun test se ne accorga, perché un
 * test che monta la propria copia della catena prova la copia. Qui il test monta
 * questa funzione, cioè la cosa vera, e a server.ts restano solo i timer e le
 * dipendenze reali.
 */
export function createOrphanCensusRunner(deps: CensusRunnerDeps): () => void {
  const log = deps.log ?? ((m: string) => console.log(m));
  // Le orfane del giro precedente: la seconda conferma della regola.
  let orphansLastRound: ReadonlySet<string> = new Set();

  return function runOnce(): void {
    const r = censusOnce(deps);
    log(formatCensus(r));

    const plan = planOrphanPark({
      orphansNow: r.orphans,
      orphansBefore: orphansLastRound,
      uiStateRows: r.uiStateRows,
      enabled: deps.enabled,
    });
    orphansLastRound = new Set(plan.remember);
    // Silenzio quando non c'è niente da dire: una riga a ogni giro a vuoto
    // seppellirebbe l'unica riga che conta.
    if (plan.park.length > 0 || plan.held.length > 0 || plan.blocked) {
      log(formatOrphanParkPlan(plan));
    }
    if (plan.park.length > 0) deps.park(plan.park);
  };
}
