/**
 * Cosa fare, al riavvio del server, di una riga `terminal_sessions` la cui PTY
 * non c'è più.
 *
 * IL PROBLEMA. `reconcileSessions` rilanciava con `--resume` OGNI riga claude
 * rimasta nel database. Senza chiedersi se una tab la mostrasse ancora, né da
 * quanto fosse ferma. Una riga sopravvissuta anche una sola volta alla chiusura
 * della sua tab veniva quindi riaccesa a ogni riavvio, per sempre — come
 * processo che nessuna schermata di Topics mostra, perché l'interfaccia non ha
 * una vista per una sessione senza pane. Misurato il 2026-08-03: 11 CLI
 * `claude --resume` vive per 2,4 GB, tutte di conversazioni chiuse dall'utente
 * fra il 03/07 e il 29/07, riaccese insieme dal riavvio del 02/08 17:26.
 *
 * PARCHEGGIARE, NON RILANCIARE. Lo stato di una sessione Claude sta su disco:
 * è ciò che `--resume` rilegge. Lasciare la riga `dormant` non perde niente e
 * `POST /sessions/:id/revive` la rimette dov'era — cosa che la pane fa da sola
 * quando torna attiva (`SingleTerminalPane`, effetto su `isActive`). Così un
 * riavvio costa zero processi e ciò che stai guardando torna comunque su.
 *
 * PERCHÉ È UNA FUNZIONE PURA. Stessa ragione di `terminal-idle-park.ts`: su
 * questo sottosistema un errore di giudizio costa il lavoro di qualcuno, quindi
 * la decisione si prova senza bridge, senza PTY e senza database. La regola
 * generale è simmetrica a quella del parcheggio: **nel dubbio non si cancella**.
 */

/** Cosa farne. */
export type RestartAction =
  /** Riga → `dormant`. La rianima chi la guarda. */
  | { action: "park" }
  /** Riga cancellata: `--resume` fallirebbe per sempre. */
  | { action: "drop" }
  /** PTY rilanciata subito (solo dove non esiste un percorso di rianimazione). */
  | { action: "recreate" };

/** Tutto ciò che serve per decidere, già raccolto dal chiamante. */
export interface RestartCandidate {
  /** `claude-code`, `claude-code-team`, `codex`, `shell`, … */
  type: string;
  /** L'id da passare a `--resume`. Assente = non c'è conversazione da riprendere. */
  claudeSessionId?: string | null;
  /** Il transcript è ancora su disco? Rilevante solo per i tipi claude. */
  hasTranscript: boolean;
}

const CLAUDE_TYPES: ReadonlySet<string> = new Set(["claude-code", "claude-code-team"]);

export function decideOnRestart(c: RestartCandidate): RestartAction {
  // `codex` si rilancia, e non è una svista: il suo pane STANDALONE non ha un
  // percorso di rianimazione (la rianimazione al focus vale per i tipi claude,
  // e il revive per cwd è solo dei progetti). Parcheggiarlo lo lascerebbe
  // arenato su «[Session expired]» senza modo di tornare — vedi il commento in
  // `reconcileSessions`. Finché quel buco c'è, per codex rilanciare è il male
  // minore.
  if (c.type === "codex") return { action: "recreate" };

  // Una sessione claude con una conversazione da riprendere: si parcheggia, ma
  // solo se il transcript esiste ancora. Senza transcript `--resume` fallirebbe
  // a ogni tentativo e la riga resterebbe una tab che «compare e sparisce»:
  // quella è l'unica riga che si cancella.
  if (CLAUDE_TYPES.has(c.type) && c.claudeSessionId) {
    return c.hasTranscript ? { action: "park" } : { action: "drop" };
  }

  // Tutto il resto — shell, opencode, e una riga claude senza id di ripresa —
  // si parcheggia. Non c'è niente da rilanciare (nessuna conversazione da
  // riprendere) e non c'è niente da provare a cancellare: la riga dormiente è
  // recuperabile e, per le shell, la spazza comunque il giro orario.
  return { action: "park" };
}
