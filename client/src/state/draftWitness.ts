/**
 * Il testimone: chi ha tolto di mezzo la bozza?
 *
 * «Si apre al volo e poi si chiude subito», tre volte, e nessuna delle mie due
 * ipotesi ha retto: la regola che chiudeva le bozze vuote è SPENTA e la tab
 * sparisce lo stesso. Non sono riuscito a riprodurlo — né dal «+» della barra
 * con due tab aperte, né dopo un click singolo, né nel giro segnalato per
 * intero — quindi smetto di indovinare da qui e faccio parlare l'app che lo
 * vive: ogni percorso che può togliere una pane dall'elenco lascia il suo nome
 * PRIMA di farlo, e chi guarda l'elenco cambiare lo legge.
 *
 * Se una bozza sparisce e nessuno ha lasciato il nome, il colpevole è comunque
 * identificato — è l'archivio delle pane (uno snapshot che arriva da un altro
 * client, o l'idratazione all'avvio), l'unico che può togliere una pane senza
 * passare da qui.
 *
 * Diagnostica, a tempo: si toglie appena il percorso ha un nome.
 */

export type DraftRemovalReason =
  | 'chiusura-manuale'
  | 'congedo-bozza-vuota'
  | 'validazione-pane'
  | 'sincronizzazione-archivio'
  | 'potatura-terminali'
  | 'promozione-a-topic'
  | 'chiusura-remota';

/**
 * Il cartello. Sta qui e non nell'hook perché ADESSO lo chiamano due strati
 * diversi: l'elenco delle pane e l'elenco che disegna le tab. Una tab può
 * sparire dal secondo restando nel primo — filtrata per spazio, o potata dal
 * riordino — e in quel caso il testimone di prima non vedeva niente.
 */
export function announceDraftGone(where: string, reason: string, ids: string[]): void {
  const msg = `Chat nuova sparita da «${where}» per: ${reason}`;
  console.warn('[bozza]', msg, ids);
  try {
    const el = document.createElement('div');
    el.textContent = msg;
    el.setAttribute('data-draft-witness', `${where}:${reason}`);
    el.style.cssText =
      'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147483647;' +
      'background:#b91c1c;color:#fff;padding:8px 14px;border-radius:10px;font:500 12px system-ui;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.35);max-width:90vw;text-align:center';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 12_000);
  } catch { /* diagnostica: non deve poter rompere niente */ }
}

let lastReason: { reason: DraftRemovalReason; at: number } | null = null;

/** Lascia il nome PRIMA di togliere la pane. */
export function noteDraftRemoval(reason: DraftRemovalReason): void {
  lastReason = { reason, at: Date.now() };
}

/**
 * Chi ha tolto la bozza sparita adesso. Il nome vale solo se è stato lasciato
 * un attimo fa: più vecchio di così è di un'altra rimozione, e attribuirglielo
 * sarebbe la stessa cosa che indovinare.
 */
export function whoRemovedDraft(): DraftRemovalReason | 'nessuno-ha-firmato' {
  const r = lastReason;
  lastReason = null;
  if (!r || Date.now() - r.at > 1500) return 'nessuno-ha-firmato';
  return r.reason;
}
