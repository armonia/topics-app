/**
 * PERCHÉ un gesto di identità, gruppo o condivisione non è passato.
 *
 * ── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 * Il campo `error` di `/api/auth/**` significava DUE cose diverse a seconda
 * della rotta, e nessuno dei due lati poteva accorgersene:
 *
 *   - su `/api/auth/account/*` e sul rifiuto della licenza era un CODICE, che
 *     il client traduce (`accountState.chiaveErrore`, e `IdentitySection` che
 *     confronta `no_seats_left`);
 *   - su `/api/auth/shares`, `/api/auth/share-links`, `/api/auth/orgs*` e
 *     `/api/auth/devices/*` era PROSA ITALIANA, che `ShareControl` e
 *     `DevicesSection` stampavano tale e quale — `setErrore(body.error)` — in
 *     mezzo a un'interfaccia in inglese. «quel dispositivo vede già tutto: è un
 *     tuo dispositivo, non un ospite» compariva così com'è sotto un titolo che
 *     dice «Share this card with a guest».
 *
 * Lo stesso file `shared/account.ts` lo aveva già scritto, e la metà della casa
 * che lo rispettava era l'altra: «Codici e non frasi: il testo che l'utente
 * legge lo scrive l'interfaccia, nella sua lingua. Un modulo di server che
 * spedisce prosa diventa l'unico posto in cui quella prosa esiste, e da lì non
 * si traduce più.» Questo elenco è quella regola applicata al resto del router.
 *
 * ── PERCHÉ IN `shared/` ─────────────────────────────────────────────────────
 * È letteralmente ciò che viaggia sul filo, e una seconda copia sul client
 * compilerebbe benissimo il giorno in cui il server aggiunge un motivo — e
 * l'interfaccia direbbe «non è riuscito» senza sapere perché.
 * `tests/unit/no-type-mirrors.test.ts` fa fallire chi ci riprova.
 *
 * Elenco CHIUSO: `client/src/lib/authErrors.test.ts` chiede a ognuno
 * la propria frase nelle DUE lingue, quindi aggiungerne uno senza tradurlo è
 * rosso, non un buco che si scopre in produzione.
 */

export const CODICI_AUTH = [
  // ── Lo schema è più vecchio della migration che regge queste tabelle.
  //
  // UNO e non quattro. Il server diceva la stessa cosa in quattro modi — «non
  // disponibile su questo database», «le organizzazioni non sono disponibili su
  // questo database», «le persone non sono disponibili…», «i link non sono
  // disponibili…» — cioè quattro frasi per un fatto solo, che è esattamente la
  // divergenza che questo elenco esiste per togliere. Il sostantivo cambiava,
  // il fatto no: questa installazione non ha ancora la tabella.
  'db_unavailable',

  // ── The address you are calling from is not one of the allowed ones.
  //
  // The anti-rebinding gate looks at `Host`, and the refusal arrived as
  // `code: "forbidden"` with the prose in `error`. The phone read the prose,
  // did not find it in this list and fell back to the generic phrase: on
  // 2026-08-21 a pairing from the PWA said only "that did not work" while the
  // server knew exactly why. Its own code, so the phrase can say what to do
  // instead of suggesting another try.
  'host_not_allowed',

  // ── I SOGGETTI di una condivisione.
  'unknown_device',
  /** Non è un ospite: vede già tutto, e «condividere» con lui non limita niente. */
  'device_not_guest',
  'unknown_person',
  'person_revoked',
  /** È una proprietaria dell'installazione: vede già tutto. */
  'person_is_owner',
  /**
   * L'hai TOLTA da ogni gruppo. Codice nuovo, e nasce da una divergenza vera:
   * `GET /api/auth/subjects` la escludeva già dalla rubrica (con un `NOT EXISTS`
   * scritto a mano lì dentro) ma `POST /api/auth/shares` sullo stesso id
   * rispondeva `200` — la persona spariva dal menu e condividere con lei
   * riusciva lo stesso. Adesso la domanda si fa in un posto solo
   * (`server/lib/recipients.ts`) e le due rotte non possono più rispondere
   * diversamente.
   */
  'person_removed',
  'unknown_org',
  'org_revoked',

  // ── I GRUPPI.
  /** Non sei `owner` né `admin` di questo gruppo. */
  'not_org_admin',
  /** Il gruppo di questa installazione non si cancella: è l'ancora di `/api/auth/me`. */
  'installation_org_undeletable',
  /** Toglierti dal tuo gruppo lascerebbe la macchina senza nessuno che la possiede. */
  'cannot_remove_self',
  /** Quella persona non è un membro vivo: non c'è un ruolo da cambiare. */
  'not_a_member',
  /** L'ULTIMO proprietario non si retrocede: zero owner = gruppo immodificabile. */
  'last_owner',
  /** Non c'è nessuna persona a cui intestare il gruppo. */
  'no_person_for_org',
  /**
   * Non si cancella dalla rubrica qualcuno ancora dentro un gruppo: la lapide
   * fa ricadere il suo dispositivo su «solo il ferro», quindi gli toglierebbe
   * in silenzio ciò che a quel gruppo era stato condiviso. Prima si toglie, poi
   * si cancella — due gesti, in quest'ordine.
   */
  'still_a_member',
  /** Ha ancora un dispositivo vivo: cancellarla dalla rubrica non è il modo di
   *  togliergli l'accesso — quello è revocare il dispositivo. */
  'still_has_devices',

  // ── LA LICENZA. Nascono in `server/lib/licenza.ts` e uscivano già come
  //    codici: sono qui perché l'elenco è UNO, e perché il client li traduce
  //    con lo stesso meccanismo degli altri invece che con un `if` a parte.
  'plan_required',
  'no_seats_left',

  // ── I LINK fuori rete.
  /** Niente relay su questa installazione: il gesto non si offre e non si conia. */
  'public_sharing_off',

  // ── L'APPAIAMENTO.
  'pairing_expired',
  'too_many_requests',

  // ── FORMA DELLA RICHIESTA. Un client corretto non le vede mai; restano
  //    distinte perché collassarle nasconderebbe quale campo è storto.
  'name_required',
  'person_required',
  'unknown_role',
  'unknown_resource_type',
  // `kind` e non `type`: il tipo TypeScript si chiama `SubjectKind`, e la
  // parola `subject_type` è una COLONNA di `grants` — `tests/unit/single-door.test.ts`
  // fa un grep su quel nome per tenere le query di `grants` dietro la loro
  // porta unica, e un codice d'errore che la contiene lo fa scattare a vuoto.
  'unknown_subject_kind',
  'resource_id_required',
  'subject_required',
  'bad_person_id',
] as const;

export type CodiceAuth = (typeof CODICI_AUTH)[number];

export function isCodiceAuth(v: unknown): v is CodiceAuth {
  return typeof v === 'string' && (CODICI_AUTH as readonly string[]).includes(v);
}
