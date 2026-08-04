/**
 * Il censimento delle sessioni orfane, in SOLA LETTURA.
 *
 * È il punto 2 del task `90762124`, e l'ordine dei punti non è burocrazia:
 * «nessuna interfaccia la referenzia» è un giudizio che attraversa quattro
 * strutture diverse di `ui_state`, e se sbaglia in un caso solo chi agisce su
 * quel giudizio spegne una sessione che qualcuno stava usando. Quindi prima lo
 * si guarda girare sul campo — questo modulo LOGGA cosa avrebbe parcheggiato e
 * non tocca niente — e solo quando il log smette di nominare sessioni vive si
 * collega l'azione. Che sarà il PARCHEGGIO, non la cancellazione: un falso
 * positivo su un parcheggio costa un click, su una `DELETE` una conversazione.
 *
 * La decisione vive in `lib/orphan-sessions.ts` ed è pura e testata. Qui c'è
 * solo la raccolta, e l'unica cosa che vale la pena provare è l'UNIONE fra
 * righe: una sessione può essere referenziata da UNA sola delle chiavi di
 * `ui_state` (tipicamente un `project-layout-*`), e guardarne una alla volta la
 * farebbe risultare orfana.
 */

import {
  scanOrphanSessions,
  referencedSessionIdsIn,
  type OrphanScanResult,
} from "../lib/orphan-sessions";

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

/**
 * Guarda e riferisce. Nessun effetto, per costruzione: non prende niente con cui
 * potrebbe agire.
 */
export function censusOnce(deps: CensusDeps): OrphanScanResult {
  const sessions = deps.listSessions();
  // L'unione su TUTTE le righe, non riga per riga: una pane di terminale può
  // vivere in un `project-layout-*` senza comparire nel pane store globale.
  const referencedIds = new Set<string>();
  for (const value of deps.listUiStateValues()) {
    for (const id of referencedSessionIdsIn(value)) referencedIds.add(id);
  }
  return scanOrphanSessions({
    liveSessionIds: sessions.map((s) => s.id),
    referencedIds,
    attachedIds: new Set(sessions.filter((s) => s.attached).map((s) => s.id)),
    subAgentIds: new Set(sessions.filter((s) => s.isSubAgent).map((s) => s.id)),
  });
}

/**
 * La riga di log.
 *
 * Nomina gli id delle candidate perché il senso del punto 2 è poterle
 * riconoscere: «due orfane» non permette a nessuno di dire «quella la stavo
 * usando». E riporta i motivi dei risparmi, così un censimento a zero si
 * distingue da un censimento che non ha guardato.
 */
export function formatCensus(r: OrphanScanResult): string {
  const spared = Object.entries(r.sparedReasons)
    .map(([why, n]) => `${n} ${why}`)
    .join(", ");
  const head = `[orphan-census] ${r.examined} sessioni esaminate, ${r.orphans.length} SAREBBERO parcheggiate (sola lettura, nessuna azione)`;
  const who = r.orphans.length ? ` → ${r.orphans.join(", ")}` : "";
  return `${head}${who}${spared ? ` · risparmiate: ${spared}` : ""}`;
}
