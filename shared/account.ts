/**
 * Il vocabolario dell'ACCOUNT, in un posto solo.
 *
 * Sta qui e non due volte perché è letteralmente ciò che viaggia sul filo: la
 * forma che `GET /api/auth/account` restituisce e i codici con cui un gesto
 * viene rifiutato. Ricopiarlo sui due lati vuol dire che il giorno in cui il
 * server aggiunge un motivo di rifiuto, l'interfaccia continua a compilare e a
 * mostrare «non è riuscito» senza sapere perché — un errore che nessun
 * compilatore vede. `tests/unit/no-type-mirrors.test.ts` fa fallire chi ci
 * riprova.
 */

/**
 * PERCHÉ un gesto non è passato. Codici e non frasi: il testo che l'utente
 * legge lo scrive l'interfaccia, nella sua lingua. Un modulo di server che
 * spedisce prosa diventa l'unico posto in cui quella prosa esiste, e da lì non
 * si traduce più.
 *
 * Elenco CHIUSO e ordinato come nasce: chi ne aggiunge uno lo aggiunge qui, e
 * il client se ne accorge subito — `accountState.test.ts` chiede a ognuno la
 * propria frase, nelle due lingue.
 */
export const CODICI_ACCOUNT = [
  /** Nessun servizio a cui chiedere: `TOPICS_ACCOUNT_URL` non c'è o è storta. */
  'not_configured',
  /** Rete caduta, timeout, o il servizio ha risposto 5xx: nessuna risposta di
   *  cui fidarsi. Da qui i tre casi sono lo stesso fatto, ed è transitorio. */
  'service_unreachable',
  /** Il servizio ha risposto, e ha detto di no. */
  'service_refused',
  /** Troppe richieste: si riprova più tardi, e lo si dice. */
  'rate_limited',
  /** Ha risposto `200` con qualcosa che non è la risposta attesa. */
  'bad_response',
  'invalid_email',
  /** Codice sbagliato o scaduto. */
  'bad_code',
  /** Non c'è nessuna persona a cui intestare l'account (schema anteriore alla
   *  084, o rubrica vuota). */
  'no_person',
  /** Quella persona porta GIÀ un altro account: sovrascriverlo in silenzio
   *  sposterebbe un'identità senza che nessuno l'abbia chiesto. */
  'already_linked_other',
  /** L'account o l'indirizzo che stai attivando vivono su un'ALTRA riga della
   *  rubrica di questa macchina. Un solo codice per le due direzioni perché è
   *  lo stesso fatto visto da due chiavi, e il rimedio è uno: quella riga.
   *  Agganciarsi lì comunque sarebbe il guasto peggiore di tutti — l'attivazione
   *  risponderebbe «fatto» su una persona diversa da quella di cui `GET` e
   *  `DELETE` parlano, e l'aggancio resterebbe senza nessun gesto per toglierlo. */
  'belongs_to_other_person',
  /** La riga che quell'account o quell'indirizzo indicano è REVOCATA.
   *  Agganciarcisi la resusciterebbe; scrivere quei valori su un'altra riga
   *  sbatte contro gli indici unici di `people(remote_id)` e `people(email)`,
   *  che le righe revocate NON le escludono. Si dichiara, invece di scegliere
   *  per conto dell'umano. */
  'person_revoked',
  /** Le tabelle della 084 non ci sono su questo database. */
  'unavailable',
] as const;

export type CodiceAccount = (typeof CODICI_ACCOUNT)[number];

/**
 * Lo stato dell'account su un'installazione. Ogni campo esce dal database
 * locale, tranne `configured` che esce dalla variabile d'ambiente: nessuno di
 * questi valori dipende da una risposta ottenuta adesso da un servizio, ed è la
 * proprietà che rende vera la frase «perdere il contatto non toglie niente»
 * (ORG-08).
 */
export interface AccountState {
  /** Esiste un servizio a cui chiedere un'attivazione. Indipendente da
   *  `linked`: si può essere collegati con il servizio ora irraggiungibile. */
  configured: boolean;
  linked: boolean;
  /** `people.remote_id`. */
  accountId: string | null;
  email: string | null;
  personId: string | null;
  personName: string | null;
  /** `people.synced_at`: quando l'aggancio è stato scritto l'ultima volta. */
  linkedAt: number | null;
}
