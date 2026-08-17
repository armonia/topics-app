/**
 * PERCHÉ UNA CARD IN REVIEW MOSTRA (O NON MOSTRA) UNA MISURA.
 *
 * La colonna review chiedeva «Approva» e sotto, per la maggior parte delle
 * card, non c'era niente. Misurato sul database vero il 17/08: 33 card in
 * review, 31 senza fotografia di consegna, 30 senza nemmeno una sessione.
 *
 * Il guaio non è che manchi la misura: per il lavoro fatto sul checkout
 * condiviso la misura NON PUÒ esistere, e inventarla sarebbe peggio. Il guaio è
 * che «non si può misurare» e «non è successo niente» si vedevano identici, e
 * chi guarda la colonna non ha modo di distinguere una card pronta da una
 * trascinata lì per sbaglio.
 *
 * ── PERCHÉ LA MISURA MANCA PROPRIO LÌ ───────────────────────────────────────
 * `deliveryPointer` risponde «quali commit sono di QUESTA card» sottraendo da
 * un ramo tutto ciò che sta anche altrove. Su un ramo isolato la domanda ha una
 * risposta. Su `main` no: i commit ci sono ma non portano scritto a quale card
 * appartengono, e attribuirli sarebbe indovinare. Quindi il silenzio è onesto —
 * va solo detto invece che subito.
 */

export type ReviewEvidenceKind =
  /** Ramo isolato + diff misurato: il caso buono, si mostra il numero. */
  | 'measured'
  /** Ramo isolato ma git non ha risposto: NULL non è zero. */
  | 'unmeasured'
  /** Ha lavorato un agente, ma sul checkout condiviso: i commit stanno su main
   *  e non sono attribuibili. Si dice, non si finge una misura. */
  | 'in-place'
  /** Nessun ramo, nessuna sessione: la card è stata spostata a mano. */
  | 'manual'
  /** Non è in review: la domanda non esiste. */
  | 'none';

export interface ReviewEvidence {
  kind: ReviewEvidenceKind;
  /** Il lavoro è avvenuto su un ramo suo. Governa se ha senso parlare di
   *  «atterraggio su main»: per una card in-place il codice è già lì. */
  isolated: boolean;
}

export function reviewEvidence(task: {
  status: string;
  deliveryBranch?: string | null;
  deliveryFilesChanged?: number | null;
  assignedTopicId?: string | null;
}): ReviewEvidence {
  if (task.status !== 'review') return { kind: 'none', isolated: false };
  if (task.deliveryBranch) {
    return task.deliveryFilesChanged != null
      ? { kind: 'measured', isolated: true }
      : { kind: 'unmeasured', isolated: true };
  }
  // Nessun ramo. La sessione distingue «ci ha lavorato qualcuno, qui dentro»
  // da «questa card in review ce l'ha messa una mano».
  return task.assignedTopicId
    ? { kind: 'in-place', isolated: false }
    : { kind: 'manual', isolated: false };
}
