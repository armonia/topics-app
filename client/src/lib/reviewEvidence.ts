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
  /** Un agente c'era, ma non ha prodotto NIENTE: niente ramo, niente file, e
   *  ce l'ha portata qui il sistema a budget finito. Non e' `in-place` — li'
   *  il lavoro esiste e non e' attribuibile; qui non esiste. */
  | 'empty'
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
  deliveredBy?: string | null;
}): ReviewEvidence {
  if (task.status !== 'review') return { kind: 'none', isolated: false };
  if (task.deliveryBranch) {
    return task.deliveryFilesChanged != null
      ? { kind: 'measured', isolated: true }
      : { kind: 'unmeasured', isolated: true };
  }
  // ── NIENTE RAMO E NIENTE FILE, PORTATA QUI DAL SISTEMA: NON E' «in-place» ──
  //
  // `in-place` dice una cosa precisa e rassicurante: «il lavoro c'e', sta su
  // main, non si puo' attribuire». Su una card dove l'agent non ha prodotto
  // nulla quella frase e' falsa, e manda a cercare commit che non esistono.
  //
  // Misurato il 17/08 su `5cf58e29`: nessun ramo, zero file, ogni turno morto
  // su un errore del provider — e la card mostrava «Lavorata qui», con il
  // tooltip che prometteva commit su main. Chi guarda non poteva saperlo:
  // «non capisco che succede».
  //
  // Il discriminante e' CHI l'ha portata in review. Un agente che consegna da
  // solo dichiara di aver finito, e allora il lavoro c'e' anche senza misura;
  // `delivered_by = 'system'` dice l'opposto — nessuno ha dichiarato niente, la
  // card e' arrivata qui perche' il budget e' finito.
  //
  // Serve pero' che un agente ci sia STATO: senza sessione non c'e' nessun
  // turno morto da raccontare, la card l'ha spostata una mano ed e' `manual`.
  // Quel caso viene prima, e l'ordine non e' cosmetico: `delivered_by` puo'
  // dire `system` anche su una card che nessun agente ha mai toccato (uno
  // spazzino che chiude un giro), e li' «l'agent non ha prodotto niente»
  // parlerebbe di un agente che non e' mai esistito.
  if (!task.assignedTopicId) return { kind: 'manual', isolated: false };
  if (task.deliveredBy === 'system') return { kind: 'empty', isolated: false };
  // Nessun ramo, ma un agente c'e' ed e' stato LUI a dichiarare finito: il
  // lavoro esiste, sta su main insieme a quello degli altri e non si puo'
  // attribuire. Il silenzio della misura e' onesto, e va detto.
  return { kind: 'in-place', isolated: false };
}
