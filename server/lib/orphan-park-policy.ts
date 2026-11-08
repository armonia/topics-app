/**
 * Quando un'orfana si può PARCHEGGIARE davvero.
 *
 * IL CENSIMENTO NON BASTA. `scanOrphanSessions` risponde a «qualche struttura di
 * `ui_state` la nomina?», ed è la domanda giusta — ma la risposta è un giudizio
 * su ciò che è SCRITTO, e ciò che è scritto può essere indietro. Una pane di
 * terminale appena creata esiste sullo schermo prima che la sua riga di
 * `ui_state` sia stata persistita: in quella finestra il censimento la vede
 * orfana, con ragione, e sbagliando. Il campo `attached` copre il caso in cui
 * qualcuno è già collegato, non quello di una pane creata e non ancora guardata.
 *
 * DUE AVVISTAMENTI, NON UNO. Una sessione si parcheggia solo se risultava orfana
 * ANCHE al giro precedente. La finestra di una scrittura in ritardo si misura in
 * secondi, l'intervallo fra due censimenti in ore: la conferma costa un giro e
 * chiude l'unica falla che il censimento, da solo, non può chiudere.
 *
 * `ui_state` VUOTO NON È «NESSUNA REFERENZA». È l'errore che trasforma questo
 * meccanismo in un massacro: zero righe lette ⇒ insieme delle referenze vuoto ⇒
 * TUTTE le sessioni orfane. Una query che lancia la intercetta il chiamante, ma
 * un database appena creato — o svuotato, o su un percorso sbagliato — risponde
 * zero righe senza lanciare niente. Un censimento che non ha visto nessuna
 * struttura non ha guardato: non agisce, e non accumula nemmeno conferme.
 *
 * PURO per la ragione di sempre su questo sottosistema: qui si decide se
 * spegnere il processo di qualcuno, e quella decisione si prova senza PTY,
 * senza bridge e senza database.
 */

export interface OrphanParkInput {
  /** Le orfane di QUESTO giro, dal censimento. */
  orphansNow: readonly string[];
  /** Le orfane del giro PRECEDENTE. Vuoto al primo giro dopo il boot. */
  orphansBefore: ReadonlySet<string>;
  /**
   * Quante righe di `ui_state` ha letto il censimento. Zero non vuol dire
   * «nessuna interfaccia»: vuol dire «non ho guardato».
   */
  uiStateRows: number;
  /** Interruttore generale. Spento ⇒ si continua a censire e non si agisce. */
  enabled: boolean;
}

export type OrphanParkHold =
  /** Vista orfana per la prima volta: serve la conferma del prossimo giro. */
  | "prima-conferma";

export interface OrphanParkPlan {
  /** Chi va parcheggiato adesso. I cancelli di `decidePark` valgono comunque, dopo. */
  park: string[];
  /** Chi va ricordato per il prossimo giro. */
  remember: string[];
  /** Orfane su cui NON si agisce ancora, e perché. */
  held: Array<{ id: string; reason: OrphanParkHold }>;
  /**
   * Perché l'INTERO giro non ha agito, se non ha agito. `null` = ha agito.
   * Un giro bloccato non ricorda niente: le sue orfane non sono un fatto
   * osservato, e usarle come conferma del prossimo giro le farebbe valere.
   */
  blocked: string | null;
}

export function planOrphanPark(input: OrphanParkInput): OrphanParkPlan {
  const blocked = (reason: string): OrphanParkPlan => ({
    park: [],
    remember: [],
    held: [],
    blocked: reason,
  });

  if (!input.enabled) return blocked("parcheggio disattivato (TOPICS_ORPHAN_PARK=0)");
  // Vedi sopra: nessuna riga letta è «non ho guardato», non «nessuno la mostra».
  if (input.uiStateRows <= 0) return blocked("nessuna riga di ui_state letta");

  const park: string[] = [];
  const held: Array<{ id: string; reason: OrphanParkHold }> = [];
  for (const id of input.orphansNow) {
    if (input.orphansBefore.has(id)) park.push(id);
    else held.push({ id, reason: "prima-conferma" });
  }
  return { park, remember: [...input.orphansNow], held, blocked: null };
}

/** La riga di log di una passata. Un parcheggio che non si spiega è un parcheggio che nessuno può smentire. */
export function formatOrphanParkPlan(plan: OrphanParkPlan): string {
  if (plan.blocked) return `[orphan-park] nessuna azione: ${plan.blocked}`;
  const parts: string[] = [];
  parts.push(
    plan.park.length
      ? `parcheggio ${plan.park.length}: ${plan.park.map((id) => id.slice(0, 8)).join(", ")}`
      : "niente da parcheggiare",
  );
  if (plan.held.length) {
    parts.push(`${plan.held.length} in attesa della seconda conferma`);
  }
  return `[orphan-park] ${parts.join(" · ")}`;
}
