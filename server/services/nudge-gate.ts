/**
 * UNA INTERRUZIONE, UN SOLLECITO.
 *
 * I COMMENTI di servizio hanno già il loro cancello (`claimInterruption`: un
 * riavvio, una riga). La CHAT del task non ce l'aveva, e in chat scrive il
 * dispatcher: a ogni ripresa inietta il sollecito di `buildContinueNudge`, un
 * paragrafo intero, come messaggio dell'utente. Su `topic:7d043b7e` sono
 * arrivate quattro copie identiche di «Your previous turn on this task was
 * interrupted» in novanta secondi (00:37:07, 00:38:01, 00:38:18, 00:38:28).
 * Chi legge quel thread non vede più la conversazione: vede il sollecito.
 *
 * Il cancello NON blocca la ripresa. Un turno va acceso comunque, e lo si
 * accende con un messaggio: quindi il verdetto non è «scrivi / non scrivere»
 * ma «testo intero / riga corta». La prima ripresa della finestra porta il
 * sollecito per esteso; le successive portano una riga sola e numerata, che
 * dice all'agente esattamente la stessa cosa in dodici parole e a chi legge
 * dice quante riprese ci sono state.
 *
 * La finestra è ANCORATA alla prima rivendicazione, non scorrevole: dopo la
 * finestra il testo intero torna a passare, perché una interruzione nuova
 * qualche minuto dopo merita di nuovo le istruzioni complete. E l'impronta
 * conta: un sollecito DIVERSO (l'ultimo turno, quello che impone la consegna)
 * non è la ripetizione di questo e passa sempre intero.
 *
 * Qui dentro non c'è né orologio né memoria: la rivendicazione la conserva chi
 * chiama, sul TASK. Per la ragione scritta nella migration del 14/08: il terzo
 * che scrive è quasi sempre un processo NUOVO, appena ripartito, ed è proprio
 * il riavvio il motivo per cui sta sollecitando. Un insieme in RAM gli direbbe
 * che il campo è libero.
 */

/** La finestra di default: due minuti, la stessa in cui stavano le quattro copie. */
export const NUDGE_CLAIM_MS = 120_000;

/** Quello che il task ricorda del sollecito precedente. */
export interface NudgeClaim {
  /** ISO della prima rivendicazione della finestra, o `null` se non ce n'è. */
  at: string | null;
  /** Impronta del testo rivendicato allora. */
  fingerprint: string | null;
  /** Quante riprese ha già coperto questa rivendicazione (1 = solo la prima). */
  repeats: number;
}

/** Cosa iniettare davvero, e cosa il task deve ricordare dopo. */
export interface NudgeVerdict {
  /** Il messaggio da mandare all'agente: intero la prima volta, corto dopo. */
  text: string;
  /** `true` = testo intero (prima volta nella finestra). */
  fresh: boolean;
  /** La rivendicazione aggiornata, da riscrivere sul task. */
  claim: NudgeClaim;
}

/** Nessuna rivendicazione: il primo sollecito di sempre parte da qui. */
export const NO_NUDGE_CLAIM: NudgeClaim = { at: null, fingerprint: null, repeats: 0 };

/**
 * Impronta stabile del testo: spazi compattati, maiuscole irrilevanti.
 *
 * Il sollecito porta l'id del task al suo interno, quindi due task diversi
 * hanno impronte diverse anche a testo «uguale»: la rivendicazione vive
 * comunque su una riga sola, ma l'impronta resta leggibile come identità del
 * messaggio e non del task.
 */
export function nudgeFingerprint(text: string): string {
  const normal = text.trim().replace(/\s+/g, " ").toLowerCase();
  // djb2: basta a distinguere due soliciti, e non porta dentro una dipendenza.
  let h = 5381;
  for (let i = 0; i < normal.length; i++) h = (((h << 5) + h) ^ normal.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0") + ":" + normal.length.toString(16);
}

/**
 * La riga corta che sostituisce il paragrafo ripetuto.
 *
 * Dice tre cose e basta: che è una ripresa, la quale, e che le istruzioni sono
 * quelle di sopra. Un agente che riceve questa riga ha davanti a sé la stessa
 * sessione di prima, con il sollecito per esteso ancora nel contesto.
 */
export function shortNudge(repeat: number, taskId?: string): string {
  const card = taskId ? ` on \`${taskId}\`` : "";
  return (
    `Interrupted again (resume #${repeat}${card}): same nudge as above, not repeated in full. ` +
    "Carry on exactly where you were, then deliver with a summary comment and status=\"review\"."
  );
}

/** Millisecondi fra due istanti, con `null` se il primo non è una data leggibile. */
function elapsed(from: string | null, to: number): number | null {
  if (!from) return null;
  const t = Date.parse(from);
  return Number.isFinite(t) ? to - t : null;
}

/**
 * Il cancello. Dato il sollecito che si vorrebbe mandare e quello che il task
 * ricorda, dice cosa mandare davvero e cosa ricordare.
 */
export function gateNudge(args: {
  text: string;
  claim?: NudgeClaim | null;
  now: string | number | Date;
  windowMs?: number;
  taskId?: string;
}): NudgeVerdict {
  const text = args.text ?? "";
  const claim = args.claim ?? NO_NUDGE_CLAIM;
  const windowMs = args.windowMs ?? NUDGE_CLAIM_MS;
  const nowMs = args.now instanceof Date
    ? args.now.getTime()
    : typeof args.now === "number" ? args.now : Date.parse(args.now);
  const nowIso = new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();

  // Un sollecito vuoto non è un sollecito: non si rivendica niente e non si
  // sporca la memoria del task con un'impronta che nessuno riconoscerà.
  if (!text.trim()) return { text, fresh: true, claim };

  const fingerprint = nudgeFingerprint(text);
  const age = elapsed(claim.at, Number.isFinite(nowMs) ? nowMs : Date.now());
  const dentro = age !== null && age >= 0 && age < windowMs;
  // La finestra da sola non basta: un sollecito DIVERSO entro la finestra è
  // un'altra cosa da dire, non la stessa ripetuta.
  if (dentro && claim.fingerprint === fingerprint) {
    const repeats = Math.max(1, claim.repeats) + 1;
    return {
      text: shortNudge(repeats, args.taskId),
      fresh: false,
      // `at` resta quello della PRIMA: la finestra è ancorata, non scorrevole,
      // o venti riprese ravvicinate la terrebbero aperta per sempre e il testo
      // intero non tornerebbe mai.
      claim: { at: claim.at, fingerprint, repeats },
    };
  }
  return { text, fresh: true, claim: { at: nowIso, fingerprint, repeats: 1 } };
}
