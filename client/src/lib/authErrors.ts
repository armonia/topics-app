/**
 * Dal codice di rifiuto del server alla chiave della frase.
 *
 * Stessa forma di `accountState.chiaveErrore`, e per la stessa ragione: il
 * server manda un CODICE, il testo che l'utente legge lo sceglie qui, nella sua
 * lingua. Prima di questo file `ShareControl` e `DevicesSection` facevano
 * `setErrore(body.error)` e stampavano la risposta tale e quale — cioè prosa
 * italiana in mezzo a un pannello inglese.
 *
 * L'elenco NON si ricopia qui: viene da `shared/auth-codes.ts`, che è lo stesso
 * file da cui lo prende il server. Una seconda copia compilerebbe benissimo
 * anche il giorno in cui il server aggiunge un motivo di rifiuto, e
 * l'interfaccia direbbe «non è riuscito» senza sapere perché.
 */
export { CODICI_AUTH } from '../../../shared/auth-codes';
export type { CodiceAuth } from '../../../shared/auth-codes';
import { CODICI_AUTH } from '../../../shared/auth-codes';

/**
 * Un codice sconosciuto — un server più nuovo dell'interfaccia — cade su una
 * frase generica invece che su un pannello muto: un rifiuto silenzioso chi
 * guarda lo legge come un clic che non ha fatto niente.
 */
export function chiaveErroreAuth(codice: string | null | undefined): string {
  if (!codice) return 'auth.err.generic';
  return (CODICI_AUTH as readonly string[]).includes(codice)
    ? `auth.err.${codice}`
    : 'auth.err.generic';
}
