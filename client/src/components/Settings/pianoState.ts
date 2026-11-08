/**
 * Il PIANO letto sul filo, e cosa se ne dice a chi guarda.
 *
 * Modulo puro apposta: qui vive l'unica cosa che si può sbagliare in silenzio —
 * la traduzione fra i sette motivi che il server distingue e le frasi che una
 * persona legge. `licenza.ts` li tiene separati per una ragione precisa
 * («non ho una chiave con cui controllare» e «la firma è falsa» sono cose
 * diversissime da dire a chi ha appena pagato) e appiattirli qui butterebbe via
 * quella distinzione nell'ultimo metro, che è il metro in cui la persona
 * decide se il problema è suo o nostro.
 */

/**
 * I sette motivi. La dichiarazione è UNA, in `shared/`: qui si ri-esporta.
 *
 * Ricopiarli qui sarebbe stato più comodo e sbagliato, e il cricchetto
 * anti-specchio (`tests/unit/no-type-mirrors.test.ts`) lo ha detto al primo
 * tentativo — due elenchi di sette voci sono due elenchi che un giorno ne
 * hanno otto e sette, e a schermo diventa una chiave nuda in mezzo alla pagina.
 */
export type { MotivoLicenza } from '../../../../shared/licenza-motivi';
import type { MotivoLicenza } from '../../../../shared/licenza-motivi';

export interface StatoPiano {
  plan: 'free' | 'team';
  seats: number;
  remoteAccess: boolean;
  /** ms epoch, `null` sul gratuito: quello non scade per definizione. */
  expiresAt: number | null;
  reason: MotivoLicenza;
  installationId: string;
}

export interface StatoPagamento {
  /** Si può aprire un checkout: serve la chiave E il listino. */
  configured: boolean;
  webhookConfigured: boolean;
  installationId: string;
}

/**
 * Il motivo va MOSTRATO?
 *
 * `valid` e `no_token` no, e sono i due casi normali: uno è una licenza che
 * funziona, l'altro è il piano gratuito — che non è una versione mutilata di
 * cui scusarsi, è il prodotto. Un avviso su entrambi vorrebbe dire che
 * l'installazione di quasi tutti si apre con un cartello giallo.
 *
 * Gli altri cinque sì, tutti: sono stati in cui qualcuno ha provato ad avere un
 * piano e non ce l'ha, e il silenzio lì è la cosa che trasforma un problema di
 * distribuzione in un sospetto di truffa.
 */
export function mostraMotivo(r: MotivoLicenza): boolean {
  return r !== 'valid' && r !== 'no_token';
}

/**
 * Di CHI è il problema.
 *
 * `no_verification_key` è nostro: questa build non ha con cosa controllare
 * nessuna licenza, quindi nessun gettone potrà mai funzionare e incollarne un
 * altro è tempo perso. Dirlo cambia cosa fa la persona dopo — smette di
 * riprovare e ci scrive.
 *
 * `expired` e `other_installation` sono suoi, nel senso che ha in mano
 * qualcosa da sistemare: rinnovare, o chiedere un gettone per QUESTA macchina.
 */
export function colpaNostra(r: MotivoLicenza): boolean {
  return r === 'no_verification_key';
}

/** La chiave della frase da mostrare per un motivo. */
export function chiaveMotivo(r: MotivoLicenza): string {
  return `plan.reason.${r}`;
}

/**
 * Si può comprare da qui?
 *
 * Solo con Stripe configurato E un'installazione da intestare. Senza, il
 * bottone non si disegna: un bottone che apre un checkout e riceve
 * `not_configured` è peggio di nessun bottone, perché il rifiuto arriva dopo
 * il clic e sembra un guasto.
 */
export function siPuoComprare(p: StatoPagamento | null): boolean {
  return !!p?.configured && !!p.installationId;
}

/**
 * Quanto manca alla scadenza, in giorni interi. `null` se non scade.
 *
 * Arrotonda per DIFETTO: una licenza che scade fra 23 ore dice «meno di un
 * giorno», non «un giorno». Sbagliare per eccesso qui vorrebbe dire una
 * persona che scopre di essere scaduta il giorno in cui contava di non esserlo.
 */
export function giorniAllaScadenza(expiresAt: number | null, ora: number): number | null {
  if (expiresAt === null) return null;
  return Math.floor((expiresAt - ora) / 86_400_000);
}

/**
 * La scadenza è abbastanza vicina da nominarla accanto al piano?
 *
 * Trenta giorni: è il tempo in cui un rinnovo si può ancora organizzare senza
 * fretta. Prima non serve dire niente — un conto alla rovescia che parte da un
 * anno è rumore, e il rumore addestra a non leggere.
 */
export const DAYS_NOTICE_EXPIRY = 30;

export function scadenzaVicina(expiresAt: number | null, ora: number): boolean {
  const g = giorniAllaScadenza(expiresAt, ora);
  return g !== null && g <= DAYS_NOTICE_EXPIRY;
}

/**
 * I posti da chiedere a un checkout, ripuliti.
 *
 * Uno è già il piano gratuito: venderlo sarebbe una schermata di pagamento che
 * non ha senso aprire, quindi il minimo è due. Il tetto è quello del server
 * (`POSTI_MAX_CHECKOUT`), ripetuto qui per non far partire una richiesta che
 * sappiamo già che verrà rifiutata.
 */
export const POSTI_MIN_ACQUISTO = 2;
export const POSTI_MAX_ACQUISTO = 500;

export function postiValidi(n: number): number {
  if (!Number.isFinite(n)) return POSTI_MIN_ACQUISTO;
  return Math.min(POSTI_MAX_ACQUISTO, Math.max(POSTI_MIN_ACQUISTO, Math.floor(n)));
}

/** La chiave della frase per un rifiuto del checkout. Un codice che questa
 *  interfaccia non conosce cade su quella generica, invece di sparire: un clic
 *  senza effetto è indistinguibile da un bottone rotto. */
const CODES_CHECKOUT = new Set([
  'not_configured', 'no_installation', 'bad_seats', 'upstream_error', 'unreachable',
]);

export function chiaveErroreCheckout(codice: string | undefined): string {
  return codice && CODES_CHECKOUT.has(codice)
    ? `plan.checkoutErr.${codice}`
    : 'plan.checkoutErr.generic';
}
