/**
 * Quali sessioni di terminale NON sono mostrate da nessuna interfaccia.
 *
 * IL FATTO. Esistono sessioni claude-code vive che nessuna struttura di
 * `ui_state` referenzia — né il pane store, né un layout di progetto, né le
 * pane di progetto. Nessuna finestra le mostra, quindi non esiste un gesto
 * umano per chiuderle: l'unica strada è una `DELETE` a mano, o aspettare un
 * riavvio del server. Nel frattempo consumano.
 *
 * PERCHÉ QUESTO MODULO È SOLO UN CENSIMENTO. «Non referenziata» è un giudizio
 * che attraversa quattro strutture diverse più i tombstone: se lo scan sbaglia
 * in un caso, chi agisce su quel giudizio uccide una sessione che qualcuno
 * stava usando. Quindi qui non si agisce — si CONTA, e l'azione (quando ci
 * sarà) dovrebbe essere il PARCHEGGIO e non la cancellazione: un falso positivo
 * su un parcheggio costa un click, su una cancellazione costa una conversazione.
 *
 * PURO: gli id referenziati entrano già estratti. Estrarli tocca il DB, deciderlo
 * no, e la decisione è la parte che va provata.
 */

/** Un id di sessione compare in QUALCHE struttura dell'interfaccia? */
export interface OrphanScanInput {
  /** Le sessioni vive, dal roster del server. */
  liveSessionIds: readonly string[];
  /**
   * Gli id che le strutture dell'interfaccia referenziano, da TUTTE le fonti
   * messe insieme: pane store, layout di progetto, pane di progetto.
   *
   * Una fonte sola non basta e non è un dettaglio: una pane di terminale può
   * vivere in un `project-layout-*` senza comparire nel pane store globale, e
   * contare solo quest'ultimo la farebbe risultare orfana.
   */
  referencedIds: ReadonlySet<string>;
  /**
   * Sessioni con un client ATTACCATO adesso. Non possono essere orfane per
   * definizione — qualcuno le sta guardando in questo istante, qualunque cosa
   * dica `ui_state` (che può essere indietro di una scrittura).
   */
  attachedIds?: ReadonlySet<string>;
  /**
   * Sotto-agenti: hanno un padre che li ha generati e li governa, non una tab.
   * Non sono orfani, sono figli — e trattarli come orfani ucciderebbe il lavoro
   * di un agente vivo.
   */
  subAgentIds?: ReadonlySet<string>;
}

export interface OrphanScanResult {
  /** Le candidate: vive, non referenziate, non attaccate, non sotto-agenti. */
  orphans: string[];
  /** Quante ne ha esaminate: serve a distinguere «nessuna orfana» da «non ho guardato». */
  examined: number;
  /** Perché le altre sono state risparmiate, contato per motivo. */
  sparedReasons: Record<string, number>;
}

/**
 * Il censimento. Nessun effetto: restituisce chi SAREBBE orfano.
 *
 * L'ordine dei risparmi non è casuale — si controlla prima ciò che è vero
 * ADESSO (un client attaccato) e poi ciò che è scritto (una referenza in
 * `ui_state`), perché il primo non può essere stantio e il secondo sì.
 */
export function scanOrphanSessions(input: OrphanScanInput): OrphanScanResult {
  const attached = input.attachedIds ?? new Set<string>();
  const subAgents = input.subAgentIds ?? new Set<string>();
  const orphans: string[] = [];
  const sparedReasons: Record<string, number> = {};
  const spare = (why: string) => { sparedReasons[why] = (sparedReasons[why] ?? 0) + 1; };

  for (const id of input.liveSessionIds) {
    if (attached.has(id)) { spare("qualcuno è attaccato adesso"); continue; }
    if (subAgents.has(id)) { spare("sotto-agente: ha un padre, non una tab"); continue; }
    if (input.referencedIds.has(id)) { spare("referenziata da una struttura dell'interfaccia"); continue; }
    orphans.push(id);
  }
  return { orphans, examined: input.liveSessionIds.length, sparedReasons };
}

/**
 * Gli id di sessione referenziati dentro un valore di `ui_state`, qualunque sia
 * la sua forma.
 *
 * Le strutture sono diverse fra loro (il pane store ha `panes` con id
 * `terminal:<sid>`, i layout di progetto hanno liste di pane, le pane di
 * progetto un'altra forma ancora) e cambiano nel tempo. Invece di conoscerle
 * tutte — e diventare sbagliati alla prossima — si cerca il PATTERN dell'id
 * ovunque compaia nel JSON serializzato.
 *
 * È volutamente GENEROSO: un id trovato per caso fa risparmiare una sessione
 * che forse era orfana (costo: una sessione in più viva), mentre un id NON
 * trovato ne farebbe uccidere una viva. I due errori non si equivalgono.
 */
export function referencedSessionIdsIn(value: string): Set<string> {
  const out = new Set<string>();
  // `terminal:<id>` è la forma delle pane; l'id nudo compare nei layout.
  const re = /terminal:([0-9a-fA-F-]{8,})|"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    const id = m[1] ?? m[2];
    if (id) out.add(id);
  }
  return out;
}
