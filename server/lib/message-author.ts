/**
 * L'AUTORE di un messaggio, ricavato da chi ha fatto la richiesta.
 *
 * Due valori e non uno: la PERSONA è il soggetto (è lei che compare su un
 * profilo e sopravvive a un telefono cambiato), il DISPOSITIVO è il credenziale
 * da cui il messaggio è entrato. Vedi la migration 095.
 *
 * IL LOOPBACK È IL CASO SCOMODO, e vale la pena dirlo qui: davanti a questa
 * macchina non c'è nessun cookie che dica chi ha le mani sulla tastiera. Si
 * ricade sul proprietario PREDEFINITO — la stessa regola che `actingPersonId`
 * applica già a ogni altro gesto locale — perché l'alternativa è che ogni
 * prompt scritto dal Mac di casa resti senza autore, cioè che la funzione
 * chiesta non funzioni proprio nel posto in cui si lavora di più.
 *
 * Ciò che NON si fa mai è inventare una persona quando non ce n'è nessuna:
 * `null` è una risposta, e i conteggi la saltano invece di attribuirla a
 * qualcuno.
 */
import { actingPersonId } from "./orgs";

type Db = Parameters<typeof actingPersonId>[0];

export interface AutoreMessaggio {
  authorPersonId: string | null;
  authorDeviceId: string | null;
}

export function autoreDaIdentita(
  db: Db,
  identita: { deviceId: string | null } | null | undefined,
): AutoreMessaggio {
  const deviceId = identita?.deviceId ?? null;
  return { authorPersonId: actingPersonId(db, deviceId), authorDeviceId: deviceId };
}
