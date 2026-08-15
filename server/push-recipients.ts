/**
 * CHI riceve una push. Una domanda sola, in un posto solo.
 *
 * Viveva dentro `sendPushToAll` come `WHERE enabled = 1`, e quel predicato
 * rispondeva a una domanda sola su due: diceva chi ha SPENTO le notifiche, non
 * chi ha ancora il diritto di riceverle. Revocare un dispositivo gli chiudeva le
 * socket e gli negava l'API, ma la push continuava ad arrivargli — titoli di
 * task, domande degli agenti, descrizioni di approvazione — perché la push non
 * passa da nessun filo aperto: la consegnano Apple o Google a partire da una
 * riga di questa tabella.
 *
 * Sta in un modulo suo, e non dentro `push-service`, per una ragione di prova:
 * `push-service` è mockato per intero da `push-triggers.test.ts`, e in Bun un
 * `mock.module` sopravvive al file che lo dichiara. Un test che lo importasse
 * per verificare la consegna riceverebbe il finto e passerebbe senza aver
 * misurato niente. Qui invece si prova la decisione VERA, contro un database
 * vero, senza dipendere dall'ordine dei file.
 */

/** Il minimo che serve: `Database` di bun:sqlite lo soddisfa. `all()` è
 *  dichiarato SENZA parametri di proposito — la query non ne prende, e una firma
 *  variadica su `unknown[]` non è assegnabile dai binding tipati di bun:sqlite. */
export interface RecipientsDb {
  query: (sql: string) => { all: () => unknown[] };
}

/** La riga come sta in SQLite: colonne piatte, chiavi non annidate. */
export interface DeliverableSubscription {
  endpoint: string;
  keys_p256dh: string;
  keys_auth: string;
  when_open: string | null;
}

/**
 * Le iscrizioni a cui si può consegnare adesso.
 *
 * DUE filtri, due domande diverse:
 *
 *   `enabled = 0` è un dispositivo che l'utente ha SPENTO, e spegnerlo vale
 *   solo per lui: è il punto dell'intera card delle notifiche.
 *
 *   `auth_device_id` è il dispositivo REVOCATO. È timbrato dal server con
 *   l'identità della richiesta al momento dell'iscrizione, mai preso dal corpo
 *   — `device_id` invece viene dal corpo e serve alla continuità del browser,
 *   quindi non può reggere una revoca.
 *
 * `auth_device_id IS NULL` passa, e non è una svista: vuol dire «riga scritta
 * prima della migration» oppure «iscritta da questa macchina» (loopback non ha
 * una riga in `devices` e non si revoca). Non c'è nessun dispositivo da
 * controllare, e spegnere la push del proprio Mac sarebbe un esito peggiore del
 * buco che questa funzione chiude.
 *
 * IL LIMITE, scritto perché non venga scambiato per una copertura: finché una
 * riga ha NULL, la revoca del dispositivo NON la raggiunge — `dimenticaPush`
 * filtra proprio su quella colonna. Qui non si può fare di meglio: da una riga
 * NULL non si risale al dispositivo. A chiudere il divario è il timbro, e va
 * fatto dove l'identità c'è: `POST /api/push/subscribe` (una nuova iscrizione)
 * e `GET /api/push/devices` (l'apertura della card, che fa il backfill sulle
 * righe dello stesso `device_id`). La frase «la colonna si popola alla prima
 * re-iscrizione» che stava qui era falsa: la subscribe parte solo da un gesto
 * esplicito, e all'avvio il client non la chiama.
 */
export function deliverableSubscriptions(db: RecipientsDb): DeliverableSubscription[] {
  return db.query(
    `SELECT ps.endpoint, ps.keys_p256dh, ps.keys_auth, ps.when_open
       FROM push_subscriptions ps
       LEFT JOIN devices d ON d.id = ps.auth_device_id
      WHERE ps.enabled = 1
        AND (ps.auth_device_id IS NULL OR (d.id IS NOT NULL AND d.revoked_at IS NULL))`,
  ).all() as DeliverableSubscription[];
}
