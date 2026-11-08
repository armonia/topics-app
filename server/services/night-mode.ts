/**
 * Modalità notturna della board: dispaccia solo a macchina scarica, si ferma a
 * un orario.
 *
 * DA DOVE VIENE. Fuori da Topics esisteva già un turno notturno costruito a
 * mano (`~/jarvis/master/bin/master-night.sh`): si arma quando la persona se ne
 * va, parte quando le sessioni finiscono e il carico scende, si ferma alle 10.
 * Questa è quella logica portata dentro la board, e le regole sono le sue.
 *
 * PERCHÉ NON È UN CRON, ed è la parte che cambia il progetto: il turno deve
 * partire quando la macchina è davvero libera, non a un'ora indovinata. Una
 * partenza a orario fisso troverebbe la persona ancora al lavoro e le
 * mangerebbe la macchina; una che aspetta la quiete parte dopo, ma parte bene.
 *
 * L'ORARIO È UNA FINE, NON UN INIZIO. `untilHHMM` dice quando smettere, e
 * scaduto quello la modalità si spegne DA SOLA — non resta armata a fare da
 * trappola il giorno dopo. È la stessa ragione per cui lo script aveva un
 * guardiano separato: un turno che non sa finire è peggio di uno che non parte.
 *
 * PURO di proposito: `now`, carico e sessioni vive entrano come argomenti. La
 * decisione è la cosa che va provata, e provarla contro un orologio vero
 * significherebbe test che passano solo di notte.
 */

export interface NightModeInput {
  /** L'interruttore, acceso da una PERSONA. Mai da solo. */
  enabled: boolean;
  /** Quando smettere, `HH:MM` sull'orologio locale. Assente ⇒ nessuna fine. */
  untilHHMM?: string | null;
  /** Adesso. */
  now: Date;
  /** Load average a 1 minuto. */
  load1: number;
  /** Core della macchina: la soglia è per core, non assoluta. */
  cores: number;
  /**
   * Sessioni vive che NON sono agenti di questa board — la persona al lavoro.
   * È il segnale "sono via" del turno notturno: finché c'è qualcuno, si aspetta.
   */
  busySessions: number;
  /**
   * Carico per core oltre il quale la macchina è «occupata». Default 1.5:
   * lo script usava 20 su 12 core, cioè ~1,67 — arrotondato in giù perché una
   * soglia troppo alta fa partire il turno addosso a chi sta lavorando, e
   * l'errore in quella direzione costa di più.
   */
  maxLoadPerCore?: number;
}

export type NightDecision =
  /** Non acceso: la board si comporta come sempre. */
  | { action: "off" }
  /** Via libera: la macchina è libera e l'orario non è scaduto. */
  | { action: "dispatch" }
  /** Acceso ma non è il momento. `reason` è ciò che l'interfaccia mostra. */
  | { action: "wait"; reason: string }
  /** L'orario è passato: la modalità va SPENTA, non solo ignorata. */
  | { action: "expire"; reason: string };

const DEFAULT_MAX_LOAD_PER_CORE = 1.5;

/**
 * `HH:MM` → i minuti dalla mezzanotte, o `null` se non è un orario.
 *
 * Validazione stretta: un valore malformato NON deve diventare «nessuna
 * scadenza», o un errore di battitura trasformerebbe il turno in permanente.
 */
export function parseHHMM(v: string | null | undefined): number | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/**
 * L'orario di fine è SCADUTO rispetto a quando la modalità è stata accesa?
 *
 * Il confronto non può essere «adesso > HH:MM»: un turno acceso a mezzanotte e
 * mezza con fine alle 10:00 avrebbe l'ora di fine *dopo* l'accensione ma nello
 * stesso giorno, mentre uno acceso alle 23:00 con fine alle 10:00 la ha il
 * giorno dopo. Si ragiona quindi sull'ISTANTE di fine calcolato dall'accensione:
 * la prima occorrenza di `HH:MM` STRETTAMENTE successiva ad essa.
 */
export function deadlineFrom(startedAt: Date, untilHHMM: string): Date | null {
  const mins = parseHHMM(untilHHMM);
  if (mins == null) return null;
  const d = new Date(startedAt);
  d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
  if (d.getTime() <= startedAt.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

export interface NightModeState extends NightModeInput {
  /** Quando la modalità è stata accesa. Serve a calcolare la fine. */
  startedAt?: Date | null;
}

/** La decisione, in un posto solo. */
export function decideNight(input: NightModeState): NightDecision {
  if (!input.enabled) return { action: "off" };

  // Scadenza per prima: una modalità scaduta non deve nemmeno guardare il
  // carico — altrimenti a macchina occupata resterebbe in «attesa» per sempre
  // invece di spegnersi, che è il modo in cui un turno diventa una trappola.
  if (input.untilHHMM) {
    const start = input.startedAt ?? input.now;
    const dl = deadlineFrom(start, input.untilHHMM);
    if (dl && input.now.getTime() >= dl.getTime()) {
      return { action: "expire", reason: `orario di fine (${input.untilHHMM}) raggiunto` };
    }
  }

  if (input.busySessions > 0) {
    return {
      action: "wait",
      reason: `${input.busySessions} ${input.busySessions === 1 ? "sessione attiva" : "sessioni attive"}`,
    };
  }

  const cores = Math.max(1, input.cores);
  const perCore = (input.maxLoadPerCore ?? DEFAULT_MAX_LOAD_PER_CORE);
  const soglia = cores * perCore;
  if (input.load1 >= soglia) {
    return { action: "wait", reason: `carico ${input.load1.toFixed(1)} (soglia ${soglia.toFixed(1)})` };
  }

  return { action: "dispatch" };
}
